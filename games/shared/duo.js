// ===== Duo: two-phone link for browser games (no accounts, no own server) =====
// Usage:
//   <script src="../shared/duo.js"></script>
//   Duo.init({ game: 'tron', accent: '#ff6b2c' });
//   await Duo.pair();            // shows the pairing overlay (create room / enter 4-digit code); resolves when linked
//   Duo.set({ x: 1, y: 2 });     // merge into MY state (latest value wins, ~16 sends/s max over relay)
//   Duo.partner()                // partner's latest state object, or null
//   Duo.onState(fn)              // fn(partnerState) on every partner update
//   Duo.onLink(fn) / Duo.onLoss(fn)
//   Duo.isHost()                 // true on the phone that created the room (use it to pick an owner for shared objects)
//   Duo.sample({lerp:['x','y'], vel:{x:'vx',y:'vy'}})  // SMOOTH partner state for drawing: interpolated between
//                                             // updates by their send time, drawn a few ms in the past (see below)
//   Duo.ping() -> {via:'напрямую'|'через сервер', ms} or null; Duo.direct() -> true when the direct link is alive
//   Duo.emit(type, data) / Duo.on(type, fn)   // best-effort one-off events (may be lost!). For anything important,
//                                             // keep it in state instead (e.g. a list of moves / turn number).
// Transport: every message goes over BOTH a direct WebRTC link (PeerJS) and a public MQTT relay (wss),
// duplicates are dropped by sequence numbers. Phones need internet; the same Wi-Fi gives the lowest delay.
(function () {
  const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const ICE = { config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ] }, debug: 0 };
  const myId = Math.random().toString(36).slice(2, 12);
  let game = 'game', accent = '#e2bd62';
  let mine = {}, partner = null, linked = false, partnerLast = 0, seq = 0, lastSeq = {}, session = 0;
  let code = '', isHost = false, state = 'idle', error = '';
  const diag = { rtc: '—', mq: '—' };
  const H = { state: [], link: [], loss: [], ev: {} };
  let pairResolve = null;

  function call(list, ...a) { list.forEach(f => { try { f(...a); } catch (e) { console.error(e); } }); }
  const libs = {};
  function loadScript(key, src, test) {
    if (test()) return Promise.resolve();
    if (libs[key]) return libs[key];
    libs[key] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = () => (test() ? res() : rej(new Error('nolib')));
      s.onerror = () => { libs[key] = null; rej(new Error('load')); };
      document.head.appendChild(s);
    });
    return libs[key];
  }

  // ---------- messages ----------
  function packet(t, extra) { return Object.assign({ t, id: myId, code, s: ++seq, w: Date.now() }, extra || {}); }
  // ---------- smoothing buffer for the partner's state ----------
  // Each update is placed on our clock by its send time (offset = smallest arrival-minus-send difference seen,
  // which cancels the clock difference between phones). Drawing happens slightly in the past so there are
  // always two updates to interpolate between: delay = how late updates come + gap between updates.
  let snaps = [], off = null, offT = 0, late = 0;
  function recordSnap(d) {
    const now = Date.now(), sent = typeof d.w === 'number' ? d.w : now, sample = now - sent, nowS = performance.now();
    if (off == null || sample < off) off = sample; else off += Math.min(sample - off, (nowS - (offT || nowS)) * 0.002);
    offT = nowS;
    late = Math.max(sample - off, late * 0.995);
    const t = sent + off;
    if (snaps.length && t <= snaps[snaps.length - 1].t) return;
    snaps.push({ t, p: d.p }); if (snaps.length > 60) snaps.shift();
  }
  function renderDelay() {
    const gap = snaps.length > 1 ? Math.min(120, (snaps[snaps.length - 1].t - snaps[0].t) / (snaps.length - 1)) : 16;
    return Math.max(8, Math.min(250, late + gap + 4));
  }
  function sample(o) {
    o = o || {};
    if (!snaps.length) return partner;
    const lerp = o.lerp || [], vel = o.vel || {}, maxEx = (o.maxExtrapolate == null ? 100 : o.maxExtrapolate);
    const rt = Date.now() - renderDelay();
    let i = snaps.length - 1; while (i > 0 && snaps[i - 1].t > rt) i--;
    const b = snaps[i], a = snaps[i - 1], last = snaps[snaps.length - 1];
    if (rt >= last.t) {
      const out = { ...last.p }, dt = Math.min(maxEx, rt - last.t) / 1000;
      lerp.forEach(k => { if (typeof out[k] === 'number' && typeof out[vel[k]] === 'number') out[k] += out[vel[k]] * dt; });
      return out;
    }
    if (!a || rt <= a.t) return { ...b.p };
    const kf = (rt - a.t) / Math.max(1, b.t - a.t), out = { ...(kf < 0.5 ? a.p : b.p) };
    lerp.forEach(k => { const x0 = a.p[k], x1 = b.p[k]; if (typeof x0 === 'number' && typeof x1 === 'number') out[k] = x0 + (x1 - x0) * kf; });
    return out;
  }
  // ---------- ping per transport ----------
  const rtt = { rtc: 0, mq: 0 }, lastVia = { rtc: 0, mq: 0 };
  setInterval(() => {
    if (!code) return;
    const q = { t: 'q', id: myId, code, ts: performance.now() };
    rtcSend(q); if (mq && mq.connected) { try { mq.publish(topic(), JSON.stringify(q), { qos: 0 }); } catch (e) {} }
  }, 1000);
  function direct() { return Date.now() - lastVia.rtc < 1500; }
  function sendState() { if (!code) return; const m = packet('p', { p: mine }); rtcSend(m); mqSend(m, false); }
  function onMsg(d, via) {
    if (!d || typeof d !== 'object' || d.id === myId || d.code !== code || typeof d.id !== 'string') return;
    lastVia[via] = Date.now();
    if (d.t === 'q') { const a = { t: 'a', id: myId, code, ts: d.ts, to: d.id };
      if (via === 'rtc') rtcSend(a); else if (mq && mq.connected) { try { mq.publish(topic(), JSON.stringify(a), { qos: 0 }); } catch (e) {} }
      return; }
    if (d.t === 'a') { if (d.to === myId && typeof d.ts === 'number') { const v = performance.now() - d.ts; rtt[via] = rtt[via] ? rtt[via] * 0.7 + v * 0.3 : v; } return; }
    if (typeof d.s === 'number') { if (lastSeq[d.id] && d.s <= lastSeq[d.id]) return; lastSeq[d.id] = d.s; }
    partnerLast = Date.now();
    if (via === 'rtc') diag.rtc = 'работает'; if (via === 'mq') diag.mq = 'работает';
    const wasLinked = linked;
    if (!linked) { linked = true; state = 'linked'; error = ''; sendState(); }
    if ((d.t === 'p' || d.t === 'e') && d.p && typeof d.p === 'object') { partner = d.p; recordSnap(d); }
    if (d.t === 'e' && typeof d.k === 'string') { call(H.ev[d.k] || [], d.v); }
    if (!wasLinked) { ui(); call(H.link); if (pairResolve) { const r = pairResolve; pairResolve = null; hideOverlay(); r(); } }
    if (d.t === 'p') call(H.state, partner);
  }
  setInterval(() => {
    if (!code) return;
    sendState();
    if (linked && Date.now() - partnerLast > 9000) { linked = false; partner = null; state = isHost ? 'hosting' : 'lost'; ui(); call(H.loss); }
  }, 1500);

  // ---------- transport 1: WebRTC via PeerJS ----------
  let peer = null, conns = [];
  function rtcSend(m) { conns.forEach(c => { if (c.open) { try { c.send(m); } catch (e) {} } }); }
  function rtcAttach(c, ss) {
    c.on('open', () => { if (ss !== session) return; conns.push(c); diag.rtc = 'канал открыт'; ui(); try { c.send(packet('p', { p: mine })); } catch (e) {} });
    c.on('data', (d) => { if (ss === session) onMsg(d, 'rtc'); });
    const drop = () => { conns = conns.filter(x => x !== c); if (ss === session && !conns.length) { diag.rtc = 'канал закрыт'; ui(); } };
    c.on('close', drop); c.on('error', drop);
  }
  async function rtcStart(ss) {
    diag.rtc = 'загрузка…'; ui();
    try { await loadScript('peer', 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js', () => !!window.Peer); }
    catch (e) { if (ss === session) { diag.rtc = 'не загрузилось'; ui(); } return; }
    if (ss !== session) return;
    const pid = 'duo-' + game + '-' + code;
    if (isHost) {
      peer = new window.Peer(pid, ICE);
      peer.on('open', () => { if (ss === session) { diag.rtc = 'ждёт'; ui(); } });
      peer.on('connection', (c) => rtcAttach(c, ss));
    } else {
      peer = new window.Peer(undefined, ICE);
      const tryConnect = () => { if (ss !== session || conns.length || !peer || peer.destroyed) return; rtcAttach(peer.connect(pid, { reliable: false, serialization: 'json' }), ss); };
      peer.on('open', () => { if (ss !== session) return; diag.rtc = 'соединяюсь…'; ui(); tryConnect(); });
      const iv = setInterval(() => { if (ss !== session) { clearInterval(iv); return; } if (!conns.length) tryConnect(); }, 6000);
    }
    peer.on('disconnected', () => { try { if (ss === session) peer.reconnect(); } catch (e) {} });
    peer.on('error', (e) => { if (ss !== session) return; diag.rtc = e && e.type === 'peer-unavailable' ? 'партнёр не найден' : e && e.type === 'unavailable-id' ? 'код занят' : 'ошибка'; ui(); });
  }
  function rtcStop() { conns.forEach(c => { try { c.close(); } catch (e) {} }); conns = []; try { if (peer) peer.destroy(); } catch (e) {} peer = null; }

  // ---------- transport 2: MQTT relay ----------
  let mq = null, mqPending = null, mqTimer = 0, mqLastSent = 0;
  function topic() { return 'duo/v1/' + game + '/' + code; }
  function mqSend(m, now) {
    if (!mq || !mq.connected) return;
    if (now) { try { mq.publish(topic(), JSON.stringify(m), { qos: 0 }); } catch (e) {} return; }
    mqPending = m;
    const gap = direct() ? 400 : 40; // relay is only a backup while the direct link is alive
    const wait = Math.max(0, gap - (Date.now() - mqLastSent));
    if (!mqTimer) mqTimer = setTimeout(() => {
      mqTimer = 0; if (!mq || !mq.connected || !mqPending) return;
      try { mq.publish(topic(), JSON.stringify(mqPending), { qos: 0 }); } catch (e) {}
      mqPending = null; mqLastSent = Date.now();
    }, wait);
  }
  async function mqStart(ss, bi) {
    bi = bi || 0;
    diag.mq = 'загрузка…'; ui();
    try { await loadScript('mqtt', 'https://unpkg.com/mqtt@4.3.7/dist/mqtt.min.js', () => !!(window.mqtt && window.mqtt.connect)); }
    catch (e) { if (ss === session) { diag.mq = 'не загрузилось'; ui(); } return; }
    if (ss !== session) return;
    const url = BROKERS[bi % BROKERS.length];
    diag.mq = 'подключаюсь…'; ui();
    let ok = false;
    const c = window.mqtt.connect(url, { clientId: 'duo_' + myId + '_' + bi, keepalive: 20, reconnectPeriod: 3000, connectTimeout: 7000, clean: true });
    mq = c;
    c.on('connect', () => {
      if (ss !== session) { try { c.end(true); } catch (e) {} return; }
      ok = true; diag.mq = 'на связи'; ui();
      c.subscribe(topic(), { qos: 0 }, () => sendState());
    });
    c.on('message', (t, buf) => { if (ss !== session) return; let d; try { d = JSON.parse(String(buf)); } catch (e) { return; } onMsg(d, 'mq'); });
    setTimeout(() => { if (ss === session && !ok && mq === c) { try { c.end(true); } catch (e) {} if (bi + 1 < BROKERS.length * 2) mqStart(ss, bi + 1); else { diag.mq = 'сервер недоступен'; ui(); } } }, 9000);
  }
  function mqStop() { try { if (mq) mq.end(true); } catch (e) {} mq = null; mqPending = null; }

  // ---------- sessions ----------
  function stopAll() { session++; rtcStop(); mqStop(); const was = linked; linked = false; partner = null; lastSeq = {}; snaps = []; off = null; late = 0; if (was) call(H.loss); }
  function begin() {
    const ss = session;
    rtcStart(ss); mqStart(ss);
    setTimeout(() => {
      if (ss !== session || linked || isHost) return;
      const any = diag.mq === 'на связи' || diag.rtc === 'соединяюсь…' || diag.rtc === 'партнёр не найден';
      error = any ? 'Комната ' + code + ' пока не отвечает. Проверь код: на первом телефоне должен быть открыт экран с этим кодом. Продолжаю пытаться…'
        : 'Не получается выйти в интернет. Проверь Wi-Fi или мобильный интернет. Продолжаю пытаться…';
      ui();
    }, 12000);
  }
  function host() { stopAll(); isHost = true; code = String(1000 + Math.floor(Math.random() * 9000)); state = 'hosting'; error = ''; diag.rtc = diag.mq = '—'; begin(); ui(); }
  function join(c) {
    c = String(c || '').replace(/\D/g, '').slice(0, 4);
    if (c.length !== 4) { error = 'Код — это 4 цифры'; ui(); return; }
    stopAll(); isHost = false; code = c; state = 'joining'; error = ''; diag.rtc = diag.mq = '—'; begin(); ui();
  }

  // ---------- pairing overlay ----------
  let ov = null;
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function buildOverlay() {
    if (ov) return;
    const css = el('style', null, `
.duo-ov{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom));background:rgba(8,8,10,.86);font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#f3efe6;overflow-y:auto}
.duo-box{width:min(420px,100%);display:flex;flex-direction:column;gap:12px;margin:auto}
.duo-h{font-size:24px;font-weight:800;text-align:center;margin:0}
.duo-sub{text-align:center;color:#b9b3a6;font-size:14px;margin:0;line-height:1.4}
.duo-code{font-size:64px;font-weight:900;letter-spacing:12px;text-align:center;color:var(--duo-accent);font-variant-numeric:tabular-nums;line-height:1.1}
.duo-btn{font:inherit;font-weight:800;font-size:17px;color:#fff;background:#2b2a30;border:2px solid var(--duo-accent);border-radius:14px;padding:13px 16px;cursor:pointer;touch-action:manipulation}
.duo-btn.hot{background:var(--duo-accent);color:#111}
.duo-btn.ghost{background:transparent;border-color:rgba(255,255,255,.25);font-size:15px;padding:10px}
.duo-row{display:flex;gap:10px}.duo-row>*{flex:1;min-width:0}
.duo-in{font:inherit;font-weight:900;font-size:28px;letter-spacing:8px;text-align:center;background:#111;color:#fff;border:2px solid var(--duo-accent);border-radius:14px;padding:10px;min-width:0;-webkit-user-select:text;user-select:text}
.duo-st{text-align:center;font-size:14px;border-radius:12px;padding:8px 12px;background:rgba(255,255,255,.06)}
.duo-err{color:#ffb4a0;border:1px solid rgba(255,120,80,.5)}
.duo-diag{text-align:center;font-size:12px;color:#9a958a;margin:0}
.duo-ov[hidden],.duo-ov [hidden]{display:none!important}`);
    document.head.appendChild(css);
    ov = el('div', 'duo-ov'); ov.hidden = true; ov.style.setProperty('--duo-accent', accent);
    ov.innerHTML = `<div class="duo-box">
      <p class="duo-h">Игра по сети</p>
      <div class="duo-box" data-r="host" hidden><p class="duo-sub">Код комнаты</p><div class="duo-code" data-r="code">····</div>
        <p class="duo-sub">Пусть партнёр откроет эту игру и введёт код. Как только он подключится, игра начнётся сама.</p>
        <button class="duo-btn" data-r="share">Поделиться ссылкой с кодом</button></div>
      <div class="duo-box" data-r="join">
        <button class="duo-btn hot" data-r="new">Создать комнату</button>
        <p class="duo-sub">или войди по коду партнёра</p>
        <div class="duo-row"><input class="duo-in" data-r="in" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="0000" aria-label="Код комнаты" autocomplete="off"><button class="duo-btn" data-r="go">Войти</button></div></div>
      <div class="duo-st" data-r="wait" hidden></div><div class="duo-st duo-err" data-r="err" hidden></div>
      <p class="duo-diag" data-r="diag" hidden></p>
      <button class="duo-btn ghost" data-r="back">Отмена</button></div>`;
    document.body.appendChild(ov);
    const $ = (r) => ov.querySelector('[data-r="' + r + '"]');
    $('new').onclick = () => host();
    $('go').onclick = () => join($('in').value);
    $('in').addEventListener('keydown', (e) => { if (e.key === 'Enter') join($('in').value); });
    $('back').onclick = () => { if (!linked) { stopAll(); state = 'idle'; isHost = false; code = ''; } error = ''; hideOverlay(); if (pairResolve) { pairResolve = null; if (pairReject) pairReject(new Error('cancel')); } };
    $('share').onclick = async () => {
      const url = location.href.split('#')[0] + '#' + code;
      try { if (navigator.share) { await navigator.share({ title: document.title, text: 'Заходи играть! Код комнаты ' + code, url }); return; } } catch (e) { return; }
      try { await navigator.clipboard.writeText(url); $('share').textContent = 'Ссылка скопирована'; } catch (e) { $('share').textContent = url; }
    };
  }
  let pairReject = null;
  function hideOverlay() { if (ov) ov.hidden = true; }
  function ui() {
    if (!ov) return;
    const $ = (r) => ov.querySelector('[data-r="' + r + '"]');
    const hosting = isHost && state === 'hosting';
    $('host').hidden = !hosting; $('code').textContent = code || '····'; $('join').hidden = hosting;
    $('err').textContent = error; $('err').hidden = !error;
    const w = state === 'joining' ? 'Соединяюсь с комнатой ' + code + '…' : state === 'lost' ? 'Связь пропала, переподключаюсь…' : '';
    $('wait').textContent = w; $('wait').hidden = !w;
    $('diag').hidden = state === 'idle'; $('diag').textContent = 'Прямая связь: ' + diag.rtc + ' · Через сервер: ' + diag.mq;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && code) sendState(); });

  window.Duo = {
    init(o) {
      game = String((o && o.game) || 'game').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'game';
      if (o && o.accent) accent = o.accent;
      const m = /^#(\d{4})$/.exec(location.hash);
      if (m) setTimeout(() => { Duo.pair(); join(m[1]); ov.querySelector('[data-r="in"]').value = m[1]; }, 0);
    },
    pair() {
      buildOverlay(); ov.style.setProperty('--duo-accent', accent); ov.hidden = false; ui();
      if (linked) { ov.hidden = true; return Promise.resolve(); }
      return new Promise((res, rej) => { pairResolve = res; pairReject = rej; });
    },
    leave() { stopAll(); state = 'idle'; code = ''; isHost = false; },
    set(patch) { for (const k in patch) { if (patch[k] === null || patch[k] === undefined) delete mine[k]; else mine[k] = patch[k]; } mine = { ...mine }; sendState(); },
    mine() { return mine; },
    partner() { return partner; },
    linked() { return linked; },
    isHost() { return isHost; },
    code() { return code; },
    myId,
    onState(f) { H.state.push(f); }, onLink(f) { H.link.push(f); }, onLoss(f) { H.loss.push(f); },
    emit(k, v) { if (!code) return; const m = packet('e', { k, v, p: mine }); rtcSend(m); mqSend(m, true); },
    on(k, f) { (H.ev[k] = H.ev[k] || []).push(f); },
    status() { return { state, code, isHost, linked, diag: { ...diag }, error }; },
    sample, delay: renderDelay, direct,
    ping() {
      const now = Date.now(), r = now - lastVia.rtc < 2500 && rtt.rtc, m = now - lastVia.mq < 4000 && rtt.mq;
      if (r) return { via: 'напрямую', ms: Math.round(r) };
      if (m) return { via: 'через сервер', ms: Math.round(m) };
      return null;
    },
  };
})();
