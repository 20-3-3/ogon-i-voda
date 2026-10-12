// ===== Viewport fix for iPhone Safari rotation =====
// After portrait <-> landscape rotation iOS Safari can leave the page scrolled/zoomed by a few pixels and
// fires `resize` before the final size is known. Games then keep a stale canvas size/offset and taps land
// in the wrong place ("buttons stop working, as if the UI moved by some pixels").
// This script: keeps the page at scroll 0, re-sends `resize` after the rotation has settled, and keeps
// --app-h / --app-w CSS variables equal to the real visible size. Safe to include more than once.
(function () {
  if (window.__vfix) return; window.__vfix = true;
  var vv = window.visualViewport;
  function setVars() {
    var h = vv ? vv.height : window.innerHeight, w = vv ? vv.width : window.innerWidth;
    var r = document.documentElement.style;
    r.setProperty('--app-h', Math.round(h) + 'px'); r.setProperty('--app-w', Math.round(w) + 'px');
  }
  function settle() {
    // undo any leftover page scroll / visual viewport offset
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    var se = document.scrollingElement; if (se && (se.scrollTop || se.scrollLeft)) { se.scrollTop = 0; se.scrollLeft = 0; }
    setVars();
  }
  var timers = [];
  function kick() {
    timers.forEach(clearTimeout); timers = [];
    settle();
    // re-dispatch resize after the rotation animation so games recompute sizes and hit areas
    [60, 180, 400, 800, 1300].forEach(function (ms) {
      timers.push(setTimeout(function () {
        settle();
        window.__vfixSynthetic = true;
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        window.__vfixSynthetic = false;
      }, ms));
    });
  }
  var lastW = 0, lastH = 0;
  function onResize() {
    if (window.__vfixSynthetic) return;
    var w = window.innerWidth, h = window.innerHeight;
    // only a real orientation/size change starts the settle sequence (not the iOS toolbar wobble)
    if (Math.abs(w - lastW) > 40 || Math.abs(h - lastH) > 120) { lastW = w; lastH = h; kick(); }
    else setVars();
  }
  window.addEventListener('orientationchange', kick);
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', kick);
  window.addEventListener('resize', onResize);
  if (vv) vv.addEventListener('resize', function () { if (!window.__vfixSynthetic) setVars(); });
  window.addEventListener('pageshow', kick);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') kick(); });
  lastW = window.innerWidth; lastH = window.innerHeight; setVars();
})();

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
// Transport (internet mode): every message goes over BOTH a direct WebRTC link (PeerJS) and a public MQTT relay (wss),
// duplicates are dropped by sequence numbers.
// Nearby mode («Рядом, без интернета»): one WebRTC link over the local Wi-Fi / personal hotspot, set up by showing a
// QR code (or sharing a text code) instead of any server. No internet, no VPN path, a few ms of delay.
(function () {
  const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const ICE = { config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ] }, debug: 0 };
  const myId = Math.random().toString(36).slice(2, 12);
  const BASE = (document.currentScript && document.currentScript.src) ? new URL('.', document.currentScript.src).href : '';
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
  let snaps = [], off = null, offT = 0, late = 0, lateS = [];
  // 90th percentile of how late updates came in the last 2 s: rare spikes are covered by extrapolation instead
  function p90(arr) { const v = arr.map(x => x[1]).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.9))] : 0; }
  function recordSnap(d) {
    const now = Date.now(), sent = typeof d.w === 'number' ? d.w : now, sample = now - sent, nowS = performance.now();
    if (off == null || sample < off) off = sample; else off += Math.min(sample - off, (nowS - (offT || nowS)) * 0.002);
    offT = nowS;
    lateS.push([nowS, sample - off]); while (lateS.length && nowS - lateS[0][0] > 2000) lateS.shift();
    late = p90(lateS);
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
  let localMode = false;
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
    if (!wasLinked) { if (localMode) { diag.rtc = 'рядом: работает'; } ui(); call(H.link); if (pairResolve) { const r = pairResolve; pairResolve = null; hideOverlay(); r(); } else if (ov && !ov.hidden && localMode) hideOverlay(); }
    if (d.t === 'p') call(H.state, partner);
  }
  setInterval(() => {
    if (!code) return;
    sendState();
    if (linked && Date.now() - partnerLast > (localMode ? 6000 : 9000)) { linked = false; partner = null; state = localMode ? 'nearby-lost' : (isHost ? 'hosting' : 'lost'); if (localMode) localLost(); ui(); call(H.loss); }
  }, 1500);

  // ---------- transport 1: WebRTC via PeerJS ----------
  let peer = null, conns = [];
  function rtcSend(m) {
    conns.forEach(c => { if (c.open) { try { c.send(m); } catch (e) {} } });
    if (L.fast && L.fast.readyState === 'open') { try { (m.t === 'e' && L.safe && L.safe.readyState === 'open' ? L.safe : L.fast).send(JSON.stringify(m)); } catch (e) {} }
  }
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


  // ---------- transport 3: NEARBY (local Wi-Fi / hotspot, QR pairing, no server) ----------
  const L = { pc: null, fast: null, safe: null, offer: '', role: '', scan: null };
  function localStop() {
    try { if (L.fast) L.fast.close(); } catch (e) {} try { if (L.safe) L.safe.close(); } catch (e) {}
    try { if (L.pc) L.pc.close(); } catch (e) {}
    L.pc = L.fast = L.safe = null; scanStop();
  }
  const b64u = {
    enc(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const s = atob(str), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; },
  };
  async function zip(text) {
    const raw = new TextEncoder().encode(text);
    if (typeof CompressionStream === 'undefined') return 'r' + b64u.enc(raw);
    const buf = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    return 'z' + b64u.enc(new Uint8Array(buf));
  }
  async function unzip(s) {
    const kind = s[0], bytes = b64u.dec(s.slice(1));
    if (kind === 'r') return new TextDecoder().decode(bytes);
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return new TextDecoder().decode(buf);
  }
  // keep only what a data-channel connection needs: smaller QR codes
  function slimSdp(sdp) {
    return sdp.split(/\r?\n/).filter(l => l && !/^a=candidate:.* tcp /i.test(l) && !/^a=extmap/.test(l) && !/^a=msid-semantic/.test(l)).join('\r\n') + '\r\n';
  }
  async function packSignal(kind, desc) { return 'D2' + kind + (await zip(JSON.stringify({ g: game, c: code, s: slimSdp(desc.sdp) }))); }
  async function unpackSignal(text) {
    text = String(text || '').trim();
    const i = text.indexOf('D2'); if (i < 0) throw new Error('bad');
    text = text.slice(i).split(/\s/)[0];
    const kind = text[2], body = JSON.parse(await unzip(text.slice(3)));
    if (!body || typeof body.s !== 'string') throw new Error('bad');
    return { kind, game: body.g, code: body.c, sdp: body.s };
  }
  function gatherDone(pc, ms) {
    return new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  function wireChannel(ch) {
    ch.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch (er) { return; } onMsg(d, 'rtc'); };
    ch.onopen = () => {
      if (ch.label === 'duo') { L.fast = ch; diag.rtc = 'рядом: канал открыт'; ui(); sendState(); }
      else L.safe = ch;
    };
    ch.onclose = () => { if (ch === L.fast && localMode && linked) { linked = false; partner = null; state = 'nearby-lost'; localLost(); ui(); call(H.loss); } };
  }
  function newPc() {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.onconnectionstatechange = () => {
      if (pc !== L.pc) return;
      if (pc.connectionState === 'failed') { error = 'Не получилось соединиться напрямую. Проверьте, что оба телефона в одной сети Wi-Fi (или второй подключён к точке доступа первого), и выключите VPN на время игры.'; ui(); }
    };
    return pc;
  }
  async function localHost(keepCode) {
    const old = code;
    stopAll(); localMode = true; isHost = true; L.role = 'host';
    code = keepCode && old ? old : 'n' + Math.random().toString(36).slice(2, 8);
    state = 'nearby-offer'; error = ''; diag.rtc = 'рядом: готовлю код'; diag.mq = 'не нужен'; view = 'n-offer'; ui();
    const pc = L.pc = newPc();
    wireChannel(pc.createDataChannel('duo', { ordered: false, maxRetransmits: 0 }));
    wireChannel(pc.createDataChannel('duo-safe', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await gatherDone(pc, 2500);
    if (pc !== L.pc) return;
    L.offer = await packSignal('o', pc.localDescription);
    diag.rtc = 'рядом: жду ответ'; drawQr(L.offer); ui();
  }
  async function localGuestFromOffer(text) {
    let sig;
    try { sig = await unpackSignal(text); } catch (e) { error = 'Это не код игры. Отсканируйте QR-код с экрана партнёра.'; ui(); return; }
    if (sig.kind !== 'o') { error = 'Это код-ответ. Нужен код с экрана того, кто создаёт игру.'; ui(); return; }
    if (sig.game && sig.game !== game) { error = 'Этот код от другой игры. Откройте одну и ту же игру на обоих телефонах.'; ui(); return; }
    stopAll(); localMode = true; isHost = false; L.role = 'guest'; code = sig.code; error = '';
    state = 'nearby-answer'; diag.rtc = 'рядом: готовлю ответ'; diag.mq = 'не нужен'; view = 'n-answer'; ui();
    const pc = L.pc = newPc();
    pc.ondatachannel = (e) => wireChannel(e.channel);
    await pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gatherDone(pc, 2500);
    if (pc !== L.pc) return;
    const ans = await packSignal('a', pc.localDescription);
    diag.rtc = 'рядом: покажите ответ партнёру'; drawQr(ans); L.answer = ans; ui();
  }
  async function localHostApplyAnswer(text) {
    let sig;
    try { sig = await unpackSignal(text); } catch (e) { error = 'Это не код игры. Отсканируйте QR-код с экрана партнёра.'; ui(); return; }
    if (sig.kind !== 'a') { error = 'Это ваш собственный код. Отсканируйте код-ответ с экрана партнёра.'; ui(); return; }
    if (!L.pc || L.role !== 'host') { error = 'Сначала создайте код на этом телефоне.'; ui(); return; }
    try { await L.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp }); } catch (e) { error = 'Этот ответ к старому коду. Пусть партнёр отсканирует ваш текущий код заново.'; ui(); return; }
    error = ''; diag.rtc = 'рядом: соединяюсь…'; view = 'n-wait'; ui();
    setTimeout(() => { if (localMode && !linked && L.role === 'host') { error = 'Соединение не устанавливается. Оба телефона должны быть в одной сети Wi-Fi или второй — на точке доступа первого. Выключите VPN на время игры и попробуйте снова.'; ui(); } }, 12000);
  }
  function localLost() {
    // the link is gone: offer a quick re-pair (same room code, so the game continues where it was)
    setTimeout(() => {
      if (linked || !localMode) return;
      buildOverlay(); ov.hidden = false; error = 'Связь «рядом» прервалась (телефон заблокирован или вышел из сети). Подключитесь заново — игра продолжится.';
      view = 'n-lost'; ui();
    }, 400);
  }
  // ---- QR drawing and scanning ----
  function drawQr(text) {
    const cv = ov && ov.querySelector('[data-r="qr"]'); if (!cv) return;
    loadScript('qrgen', BASE + 'vendor/qrcode.js', () => typeof window.qrcode === 'function').then(() => {
      const q = window.qrcode(0, 'L'); q.addData(text, 'Byte'); q.make();
      const n = q.getModuleCount(), quiet = 4, px = Math.max(3, Math.floor(720 / (n + quiet * 2)));
      cv.width = cv.height = (n + quiet * 2) * px;
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#000';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
      cv.dataset.text = text;
    }).catch(() => { error = 'Не удалось нарисовать QR-код. Используйте «Поделиться кодом».'; ui(); });
  }
  async function scanStart(onText) {
    scanStop();
    const vid = ov.querySelector('[data-r="vid"]');
    view = view === 'n-offer' || view === 'n-wait' ? 'n-scan-answer' : 'n-scan-offer'; error = ''; ui();
    try {
      await loadScript('jsqr', BASE + 'vendor/jsQR.js', () => typeof window.jsQR === 'function');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      L.scan = { stream, stop: false };
      vid.srcObject = stream; vid.setAttribute('playsinline', ''); vid.muted = true; await vid.play();
      const cv = document.createElement('canvas'), g = cv.getContext('2d', { willReadFrequently: true });
      const tick = () => {
        if (!L.scan || L.scan.stop) return;
        if (vid.videoWidth) {
          const k = Math.min(1, 720 / vid.videoWidth); cv.width = Math.round(vid.videoWidth * k); cv.height = Math.round(vid.videoHeight * k);
          g.drawImage(vid, 0, 0, cv.width, cv.height);
          const img = g.getImageData(0, 0, cv.width, cv.height);
          const r = window.jsQR(img.data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
          if (r && r.data && r.data.indexOf('D2') >= 0) { scanStop(); onText(r.data); return; }
        }
        setTimeout(tick, 90);
      };
      tick();
    } catch (e) {
      scanStop();
      error = 'Камера недоступна (' + (e && e.name === 'NotAllowedError' ? 'нет разрешения' : 'ошибка') + '). Разрешите камеру для Safari или используйте «Вставить код».';
      view = L.role === 'host' ? 'n-offer' : 'n-choose'; ui();
    }
  }
  function scanStop() { if (L.scan) { L.scan.stop = true; try { L.scan.stream.getTracks().forEach(t => t.stop()); } catch (e) {} L.scan = null; } }
  async function shareText(text, btn) {
    try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { return; }
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Код скопирован'; } catch (e) { btn.textContent = 'Скопируйте код из поля ниже'; }
  }

  // ---------- sessions ----------
  function stopAll() { session++; rtcStop(); mqStop(); localStop(); localMode = false; const was = linked; linked = false; partner = null; lastSeq = {}; snaps = []; off = null; late = 0; lateS = []; if (was) call(H.loss); }
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
  function host() { stopAll(); view = 'host'; isHost = true; code = String(1000 + Math.floor(Math.random() * 9000)); state = 'hosting'; error = ''; diag.rtc = diag.mq = '—'; begin(); ui(); }
  function join(c) {
    c = String(c || '').replace(/\D/g, '').slice(0, 4);
    if (c.length !== 4) { error = 'Код — это 4 цифры'; ui(); return; }
    stopAll(); view = 'host'; isHost = false; code = c; state = 'joining'; error = ''; diag.rtc = diag.mq = '—'; begin(); ui();
  }

  // ---------- pairing overlay ----------
  let ov = null, view = 'main';
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function buildOverlay() {
    if (ov) return;
    const css = el('style', null, `
.duo-ov{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom));padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right));background:rgba(8,8,10,.96);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#f3efe6;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;-webkit-user-select:none;user-select:none}
.duo-box{width:min(440px,100%);display:flex;flex-direction:column;gap:12px;margin:auto}
.duo-h{font-size:24px;font-weight:800;text-align:center;margin:0}
.duo-sub{text-align:center;color:#c2bcaf;font-size:14px;margin:0;line-height:1.45}
.duo-code{font-size:64px;font-weight:900;letter-spacing:12px;text-align:center;color:var(--duo-accent);font-variant-numeric:tabular-nums;line-height:1.1}
.duo-btn{font:inherit;font-weight:800;font-size:17px;color:#fff;background:#2b2a30;border:2px solid var(--duo-accent);border-radius:14px;padding:13px 16px;min-height:48px;cursor:pointer;touch-action:manipulation}
.duo-btn small{display:block;font-weight:600;font-size:13px;opacity:.75;margin-top:2px}
.duo-btn.hot{background:var(--duo-accent);color:#111}
.duo-btn.near{background:linear-gradient(135deg,#1f3b2f,#1c2b3c);border-color:#7ee0a8}
.duo-btn.ghost{background:transparent;border-color:rgba(255,255,255,.25);font-size:15px;padding:10px}
.duo-row{display:flex;gap:10px}.duo-row>*{flex:1;min-width:0}
.duo-in{font:inherit;font-weight:900;font-size:28px;letter-spacing:8px;text-align:center;background:#111;color:#fff;border:2px solid var(--duo-accent);border-radius:14px;padding:10px;min-width:0;-webkit-user-select:text;user-select:text}
.duo-ta{font:13px/1.3 ui-monospace,Menlo,monospace;background:#111;color:#eee;border:1px solid rgba(255,255,255,.25);border-radius:12px;padding:8px;min-height:64px;resize:vertical;-webkit-user-select:text;user-select:text;word-break:break-all}
.duo-st{text-align:center;font-size:14px;border-radius:12px;padding:8px 12px;background:rgba(255,255,255,.06);line-height:1.4}
.duo-err{color:#ffb4a0;border:1px solid rgba(255,120,80,.5)}
.duo-diag{text-align:center;font-size:12px;color:#9a958a;margin:0}
.duo-or{display:flex;align-items:center;gap:10px;color:#8d877b;font-size:13px}.duo-or::before,.duo-or::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.15)}
.duo-qr{display:block;margin:0 auto;width:min(78vw,58vh,340px);height:auto;aspect-ratio:1;border-radius:12px;background:#fff;image-rendering:pixelated}
.duo-vid{display:block;margin:0 auto;width:min(82vw,58vh,360px);aspect-ratio:1;object-fit:cover;border-radius:16px;background:#000;border:3px solid #7ee0a8}
.duo-steps{margin:0;padding-left:20px;color:#c2bcaf;font-size:14px;line-height:1.5}
.duo-ov[hidden],.duo-ov [hidden]{display:none!important}
@media (orientation:landscape) and (max-height:520px){
.duo-ov{padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom))}
.duo-box{gap:8px;width:min(640px,100%)}
.duo-h{font-size:18px}
.duo-btn{font-size:15px;padding:8px 12px;min-height:44px}.duo-btn small{font-size:12px}
.duo-code{font-size:44px;letter-spacing:10px}
.duo-in{font-size:22px;padding:6px}
.duo-sub,.duo-steps{font-size:13px}
.duo-qr{width:min(56vh,300px)}.duo-vid{width:min(58vh,320px)}
.duo-box[data-v="main"]{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:14px;align-items:center}
.duo-box[data-v="main"]>[data-r="near"]{grid-column:1;grid-row:1/span 3;height:100%}
.duo-box[data-v="main"]>.duo-or{display:none}
.duo-box[data-v="main"]>:not([data-r="near"]){grid-column:2}
.duo-box[data-v="n-offer n-answer"]{display:grid;grid-template-columns:auto 1fr;column-gap:14px;align-items:center}
.duo-box[data-v="n-offer n-answer"]>.duo-qr{grid-column:1;grid-row:1/span 4}
.duo-box[data-v="n-offer n-answer"]>:not(.duo-qr){grid-column:2}
}`);
    document.head.appendChild(css);
    ov = el('div', 'duo-ov'); ov.hidden = true; ov.style.setProperty('--duo-accent', accent);
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Игра вдвоём');
    ov.innerHTML = `<div class="duo-box">
      <p class="duo-h" data-r="title">Игра вдвоём</p>
      <div class="duo-box" data-v="main">
        <button class="duo-btn near" data-r="near">Рядом, без интернета<small>Одна сеть Wi-Fi или точка доступа · VPN не мешает · самая быстрая связь</small></button>
        <div class="duo-or">или через интернет</div>
        <button class="duo-btn hot" data-r="new">Создать комнату</button>
        <p class="duo-sub">или войди по коду партнёра</p>
        <div class="duo-row"><input class="duo-in" data-r="in" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="0000" aria-label="Код комнаты" autocomplete="off"><button class="duo-btn" data-r="go">Войти</button></div>
      </div>
      <div class="duo-box" data-v="host"><p class="duo-sub">Код комнаты</p><div class="duo-code" data-r="code">····</div>
        <p class="duo-sub">Пусть партнёр откроет эту игру и введёт код. Как только он подключится, игра начнётся сама.</p>
        <button class="duo-btn" data-r="share">Поделиться ссылкой с кодом</button></div>
      <div class="duo-box" data-v="n-choose">
        <ol class="duo-steps"><li>Оба телефона — в одной сети Wi-Fi, или второй подключён к точке доступа первого (Настройки → Режим модема).</li><li>Один нажимает «Создать», второй — «Подключиться» и наводит камеру на QR-код.</li><li>Потом первый сканирует ответ со второго телефона.</li></ol>
        <button class="duo-btn hot" data-r="n-host">Создать<small>покажу QR-код партнёру</small></button>
        <button class="duo-btn" data-r="n-join">Подключиться<small>отсканирую QR-код партнёра</small></button>
        <button class="duo-btn ghost" data-r="n-paste-o">Вставить код текстом</button>
      </div>
      <div class="duo-box" data-v="n-offer n-answer">
        <p class="duo-sub" data-r="qr-say"></p>
        <canvas class="duo-qr" data-r="qr" width="10" height="10" aria-label="QR-код для партнёра"></canvas>
        <button class="duo-btn hot" data-r="n-scan-a" data-only="n-offer">Отсканировать ответ партнёра</button>
        <div class="duo-row"><button class="duo-btn ghost" data-r="n-share">Поделиться кодом</button><button class="duo-btn ghost" data-r="n-paste-a" data-only="n-offer">Вставить ответ</button></div>
      </div>
      <div class="duo-box" data-v="n-scan-offer n-scan-answer">
        <p class="duo-sub" data-r="scan-say"></p>
        <video class="duo-vid" data-r="vid" playsinline muted></video>
        <button class="duo-btn ghost" data-r="n-scan-stop">Отменить сканирование</button>
      </div>
      <div class="duo-box" data-v="n-paste">
        <p class="duo-sub" data-r="paste-say">Вставьте код, который прислал партнёр</p>
        <textarea class="duo-ta" data-r="ta" aria-label="Код партнёра" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
        <button class="duo-btn hot" data-r="n-paste-go">Готово</button>
      </div>
      <div class="duo-box" data-v="n-wait"><p class="duo-sub">Соединяюсь напрямую…</p></div>
      <div class="duo-box" data-v="n-lost"><button class="duo-btn hot" data-r="n-again">Подключиться заново</button></div>
      <div class="duo-st" data-r="wait" hidden></div><div class="duo-st duo-err" data-r="err" hidden></div>
      <p class="duo-diag" data-r="diag" hidden></p>
      <button class="duo-btn ghost" data-r="back">Назад</button></div>`;
    document.body.appendChild(ov);
    const $ = (r) => ov.querySelector('[data-r="' + r + '"]');
    $('new').onclick = () => { view = 'host'; host(); };
    $('go').onclick = () => { view = 'host'; join($('in').value); };
    $('in').addEventListener('keydown', (e) => { if (e.key === 'Enter') { view = 'host'; join($('in').value); } });
    $('near').onclick = () => { error = ''; view = 'n-choose'; ui(); };
    $('n-host').onclick = () => localHost(false);
    $('n-join').onclick = () => { L.role = 'guest'; scanStart((t) => localGuestFromOffer(t)); };
    $('n-scan-a').onclick = () => scanStart((t) => localHostApplyAnswer(t));
    $('n-scan-stop').onclick = () => { scanStop(); view = L.role === 'host' ? 'n-offer' : 'n-choose'; ui(); };
    $('n-share').onclick = () => shareText(L.role === 'host' ? L.offer : (L.answer || ''), $('n-share'));
    $('n-paste-o').onclick = () => { L.pasteFor = 'offer'; $('ta').value = ''; view = 'n-paste'; ui(); };
    $('n-paste-a').onclick = () => { L.pasteFor = 'answer'; $('ta').value = ''; view = 'n-paste'; ui(); };
    $('n-paste-go').onclick = () => { const t = $('ta').value; if (L.pasteFor === 'answer') localHostApplyAnswer(t); else localGuestFromOffer(t); };
    $('n-again').onclick = () => { error = ''; if (isHost) localHost(true); else { view = 'n-choose'; L.role = 'guest'; ui(); } };
    $('back').onclick = () => {
      scanStop();
      if (view !== 'main' && !linked && view !== 'n-lost') { if (view.startsWith('n-') || view === 'host') { stopAll(); state = 'idle'; isHost = false; code = ''; } error = ''; view = 'main'; ui(); return; }
      if (!linked) { stopAll(); state = 'idle'; isHost = false; code = ''; }
      error = ''; view = 'main'; hideOverlay(); if (pairResolve) { pairResolve = null; if (pairReject) pairReject(new Error('cancel')); }
    };
    $('share').onclick = async () => {
      const url = location.href.split('#')[0] + '#' + code;
      try { if (navigator.share) { await navigator.share({ title: document.title, text: 'Заходи играть! Код комнаты ' + code, url }); return; } } catch (e) { return; }
      try { await navigator.clipboard.writeText(url); $('share').textContent = 'Ссылка скопирована'; } catch (e) { $('share').textContent = url; }
    };
  }
  let pairReject = null;
  function hideOverlay() { if (ov) { ov.hidden = true; scanStop(); } }
  let waitSince = 0, waitTimer = 0;
  function ui() {
    if (!linked && state !== 'idle') { if (!waitSince) { waitSince = Date.now(); clearTimeout(waitTimer); waitTimer = setTimeout(() => ui(), 8100); } }
    else { waitSince = 0; clearTimeout(waitTimer); }
    if (!ov) return;
    const $ = (r) => ov.querySelector('[data-r="' + r + '"]');
    if (view === 'host' && !(state === 'hosting' || state === 'joining' || state === 'lost')) view = 'main';
    ov.querySelectorAll('[data-v]').forEach(b => { b.hidden = !b.dataset.v.split(' ').includes(view); });
    ov.querySelectorAll('[data-only]').forEach(b => { b.hidden = b.dataset.only !== view; });
    const hosting = isHost && state === 'hosting';
    if (view === 'host') { $('code').parentElement.querySelectorAll('.duo-sub, .duo-code, [data-r="share"]').forEach(e => { e.hidden = !hosting; }); }
    $('code').textContent = code || '····';
    $('title').textContent = view.startsWith('n-') ? 'Рядом, без интернета' : 'Игра вдвоём';
    $('qr-say').textContent = view === 'n-offer' ? 'Покажите этот QR-код партнёру: пусть нажмёт «Подключиться» и наведёт камеру.' : 'Теперь покажите этот QR-код партнёру — он нажмёт «Отсканировать ответ».';
    $('scan-say').textContent = view === 'n-scan-answer' ? 'Наведите камеру на QR-код на экране партнёра (его ответ).' : 'Наведите камеру на QR-код на экране партнёра.';
    $('err').textContent = error; $('err').hidden = !error;
    const w = state === 'joining' ? 'Соединяюсь с комнатой ' + code + '…' : state === 'lost' ? 'Связь пропала, переподключаюсь…' : '';
    $('wait').textContent = w; $('wait').hidden = !w;
    $('diag').hidden = state === 'idle' || view === 'main' || (!error && !(waitSince && Date.now() - waitSince > 8000));
    $('diag').textContent = localMode ? 'Связь: ' + diag.rtc : 'Прямая связь: ' + diag.rtc + ' · Через сервер: ' + diag.mq;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && code) sendState(); });

  // offline cache for the whole site (lets the games open without internet for the «Рядом» mode)
  try {
    if ('serviceWorker' in navigator && location.protocol === 'https:' && BASE) {
      const root = new URL('../../', BASE).href;
      navigator.serviceWorker.register(root + 'sw.js', { scope: root }).catch(() => {});
    }
  } catch (e) {}

  window.Duo = {
    init(o) {
      game = String((o && o.game) || 'game').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'game';
      if (o && o.accent) accent = o.accent;
      const m = /^#(\d{4})$/.exec(location.hash);
      if (m) setTimeout(() => { Duo.pair(); join(m[1]); ov.querySelector('[data-r="in"]').value = m[1]; }, 0);
    },
    pair() {
      buildOverlay(); ov.style.setProperty('--duo-accent', accent); ov.hidden = false; if (!linked && state === 'idle') view = 'main'; ui();
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
    status() { return { state, code, isHost, linked, nearby: localMode, view, diag: { ...diag }, error }; },
    sample, delay: renderDelay, direct,
    ping() {
      const now = Date.now(), r = now - lastVia.rtc < 2500 && rtt.rtc, m = now - lastVia.mq < 4000 && rtt.mq;
      if (r) return { via: localMode ? 'рядом' : 'напрямую', ms: Math.round(r) };
      if (m) return { via: 'через сервер', ms: Math.round(m) };
      return null;
    },
  };
})();
