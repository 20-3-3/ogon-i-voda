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

  // ---- no zoom / magnifier while playing (iPhone Safari) ----
  // double-tap zoom, pinch zoom, the long-press text magnifier and callout menu all distract from the game.
  var vp = document.querySelector('meta[name=viewport]');
  var vpc = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover';
  if (vp) vp.setAttribute('content', vpc);
  else { vp = document.createElement('meta'); vp.name = 'viewport'; vp.content = vpc; (document.head || document.documentElement).appendChild(vp); }
  var st = document.createElement('style');
  st.textContent = 'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}html,body{touch-action:manipulation}' +
    'html,body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}' +
    '*{-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}' +
    'button,a,[role=button],canvas,label,select{touch-action:manipulation}' +
    'input,textarea,[contenteditable=true]{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default;font-size:max(16px,1em)}';
  (document.head || document.documentElement).appendChild(st);
  function editable(t) { return t && t.closest && t.closest('input,textarea,select,[contenteditable=true]'); }
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false }); });
  document.addEventListener('touchmove', function (e) { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('dblclick', function (e) { if (!editable(e.target)) e.preventDefault(); }, { passive: false });
  document.addEventListener('selectstart', function (e) { if (!editable(e.target)) e.preventDefault(); });
  document.addEventListener('contextmenu', function (e) { if (!editable(e.target)) e.preventDefault(); });
})();

// ===== Party: N-player room (3–6 phones) for browser games. Star topology, no accounts, no own server =====
// Full reference: shared/PARTY.md
//   Party.init({game:'ships', title:'Морской бой', min:3, max:6, modes:[{id:'ffa',name:'Каждый сам за себя'},{id:'teams',name:'Команды'}], accent:'#ff6b2c', skin:()=>({color:'#f00'})})
//   Party.lobby();                       // overlay: create room / join by code, roster, mode, «Начать»
//   Party.on('start', cfg => …);         // cfg = {mode, players:[{slot,id,name,skin,team}], seed, opts, match, rejoin}
//   Party.send(type, data, toSlot?)      // reliable + ordered (through the host); no toSlot = everyone else
//   Party.set({x,y}) / Party.sample(slot) / Party.state(slot)   // fast latest-wins state with interpolation
// Transport: the creator is the host. Every guest opens a WebRTC link to the host (signalling over the relays:
// 3 public MQTT brokers + ntfy.sh in parallel). Until the direct link works (and whenever it fails) everything goes
// through the relays. Guest→guest traffic is forwarded by the host.
(function () {
  if (window.Party) return;
  // A game opened inside the start page (games/index.html) uses the page's one room instead of its own (see hub.js):
  // here window.Party becomes a thin proxy to it, so switching games never needs a new connection.
  const HUBP = (function () { try { return window.parent !== window && window.parent.__hub && window.parent.__hub.attach ? window.parent.__hub : null; } catch (e) { return null; } })();
  if (HUBP) { const port = HUBP.attach(window); if (port) { window.Party = partyProxy(port); window.addEventListener('pagehide', (e) => { if (!e.persisted) port.detach(); }); return; } }
  const BROKERS = Array.isArray(window.DUO_TEST_BROKERS) ? window.DUO_TEST_BROKERS : ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt', 'wss://mqtt.eclipseprojects.io:443/mqtt'];
  // Transport budget. Public brokers throttle / kick clients that publish too often, and all phones on one Wi-Fi share one
  // public IP, so the relay path is batched: every RELAY_TICK ms at most one publish per topic per broker, each broker
  // connection has its own token bucket, fast state is latest-wins, reliable messages are acked and retransmitted.
  const RELAY_TICK = 100, BUCKET_CAP = 16, BUCKET_RATE = 11, BATCH_MAX = 24000;
  const T_HOST_LOST = 15000, T_GUEST_OFF = 15000, T_GUEST_DROP = 25000, T_WEAK = 3000;
  const NTFY = 'ntfy.sh';
  const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.nextcloud.com:443' }];
  const BASE = (document.currentScript && document.currentScript.src) ? new URL('.', document.currentScript.src).href : '';
  const rnd = (n) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0');
  const now = () => Date.now();
  const rtcOk = () => typeof RTCPeerConnection === 'function' && !window.PARTY_TEST_NORTC;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
  const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} };
  const ssDel = (k) => { try { sessionStorage.removeItem(k); } catch (e) {} };

  let G = { game: 'game', title: 'Игра с друзьями', min: 2, max: 6, modes: [], accent: '#e2bd62', skinFn: null, resolveSkin: null, skinColor: null, optsInit: null, autoResume: true };
  // Hub mode (start page only): the room lives as long as the page and is shared by all games; G then describes the game
  // that is open right now. HUB = hooks from hub.js: ctx() → texts/buttons of the overlay, where(p), eligible(seat).
  let HUB = null;
  const CAP = 6;
  let st = 'idle';            // idle | hosting | joining | joined | lost
  let code = '', isHost = false, tok = '', ep = rnd(6), session = 0, error = '', joinSince = 0, silent = false, nearby = false;
  let me = { slot: -1, id: '', name: '', skin: null, team: 0 };
  let room = { v: 0, mode: '', opts: {}, started: false, cfg: null, match: 0, players: [], evn: 0, ev: [] };
  let seats = [], seatByTok = {};      // host only
  let localSkin = null, myName = '';
  let hostEp = '', oldEps = new Set(), hostDead = false, sseq = 0, pseq = 0, hostLast = 0, lastEv = 0, lastMatch = 0, sawLobby = false, hostLostFired = false;
  const diag = { rtc: '—', mq: '—' };
  const H = {};
  function on(k, f) { (H[k] = H[k] || []).push(f); }
  function off(k, f) { H[k] = (H[k] || []).filter(x => x !== f); }
  function call(k, ...a) { (H[k] || []).slice().forEach(f => { try { f(...a); } catch (e) { console.error(e); } }); }
  const clone = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } };

  // ---------- fast state: per player buffer, send-time interpolation (same idea as Duo.sample) ----------
  const ST = {};
  function rec(slot) { return ST[slot] || (ST[slot] = { snaps: [], off: null, offT: 0, late: 0, lateS: [], latest: null, lastS: 0, fq: 0, ver: 0, sent: {} }); }
  function p90(arr) { const v = arr.map(x => x[1]).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.9))] : 0; }
  function recordSnap(r, w, p) {
    const t0 = now(), sent = typeof w === 'number' ? w : t0, sample = t0 - sent, nowS = performance.now();
    if (r.off == null || sample < r.off) r.off = sample; else r.off += Math.min(sample - r.off, (nowS - (r.offT || nowS)) * 0.002);
    r.offT = nowS;
    r.lateS.push([nowS, sample - r.off]); while (r.lateS.length && nowS - r.lateS[0][0] > 2000) r.lateS.shift();
    r.late = p90(r.lateS);
    const t = sent + r.off;
    if (r.snaps.length && t <= r.snaps[r.snaps.length - 1].t) return;
    r.snaps.push({ t, p }); if (r.snaps.length > 60) r.snaps.shift();
  }
  function renderDelay(r) {
    const s = r.snaps, gap = s.length > 1 ? Math.min(120, (s[s.length - 1].t - s[0].t) / (s.length - 1)) : 16;
    return Math.max(8, Math.min(250, r.late + gap + 4));
  }
  function sampleRec(r, o) {
    o = o || {};
    if (!r.snaps.length) return r.latest ? { ...r.latest } : null;
    const lerp = o.lerp || [], vel = o.vel || {}, maxEx = (o.maxExtrapolate == null ? 100 : o.maxExtrapolate);
    const rt = now() - renderDelay(r), sn = r.snaps;
    let i = sn.length - 1; while (i > 0 && sn[i - 1].t > rt) i--;
    const b = sn[i], a = sn[i - 1], last = sn[sn.length - 1];
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

  // ---------- minimal MQTT 3.1.1 client over WebSocket (copy of duo.js) ----------
  function MiniMqtt(url, clientId) {
    // A phone that slept or switched networks often keeps a WebSocket that looks open but carries nothing. Every packet from
    // the broker is a sign of life, a ping goes out every 5 s, and 15 s of silence (or a failed check()) means the socket is
    // dead: it is dropped and a new one connects at once instead of waiting for the system to notice.
    const H2 = {}; let ws = null, buf = new Uint8Array(0), pid = 1, ping = 0, dead = false, retry = 0, wait = 0, cto = 0, probe = 0, rx = 0;
    const c = { connected: false, url,
      on(ev, f) { (H2[ev] = H2[ev] || []).push(f); return c; },
      subscribe(t, o, cb) { c._subs = c._subs || []; if (!c._subs.includes(t)) c._subs.push(t); if (c.connected) sendSub(t); cb && cb(); },
      publish(t, msg) { if (!c.connected) return; const tb = utf(t), pb = utf(msg); send(0x30, cat(len16(tb.length), tb, pb)); },
      end() { dead = true; clearInterval(ping); clearTimeout(wait); clearTimeout(cto); clearTimeout(probe); try { if (ws && ws.readyState === 1) ws.send(new Uint8Array([0xe0, 0])); ws && ws.close(); } catch (e) {} ws = null; c.connected = false; },
      // after sleep or a network change: connect now if down, else make sure the socket still answers
      check() {
        if (dead) return;
        if (!ws) { clearTimeout(wait); retry = 0; open(); return; }
        if (!c.connected || Date.now() - rx < 3000) return;
        const t = Date.now(); send(0xc0, new Uint8Array(0));
        clearTimeout(probe); probe = setTimeout(() => { if (c.connected && rx < t) drop('stale'); }, 3500);
      },
    };
    function emit(ev, ...a) { (H2[ev] || []).forEach(f => { try { f(...a); } catch (e) {} }); }
    function utf(x) { return new TextEncoder().encode(String(x)); }
    function len16(n) { return new Uint8Array([n >> 8, n & 255]); }
    function cat(...a) { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let i = 0; a.forEach(x => { o.set(x, i); i += x.length; }); return o; }
    function varlen(n) { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; o.push(b); } while (n > 0); return new Uint8Array(o); }
    function send(h, body) { try { if (ws && ws.readyState === 1) ws.send(cat(new Uint8Array([h]), varlen(body.length), body)); } catch (e) {} }
    function sendSub(t) { const tb = utf(t); pid = (pid % 65000) + 1; send(0x82, cat(len16(pid), len16(tb.length), tb, new Uint8Array([0]))); }
    function drop(why) {
      const w = ws; if (!w) return;
      ws = null; clearTimeout(cto); clearTimeout(probe); clearInterval(ping);
      try { w.close(); } catch (e) {}
      const was = c.connected; c.connected = false; buf = new Uint8Array(0);
      if (was) { emit('close', why || ''); retry = 0; }
      later();
    }
    function open() {
      if (dead || ws) return;
      let w; try { w = ws = new WebSocket(url, ['mqtt']); } catch (e) { ws = null; emit('error', e); return later(); }
      w.binaryType = 'arraybuffer';
      cto = setTimeout(() => { if (w === ws && !c.connected) drop(); }, 8000);
      w.onopen = () => {
        if (w !== ws) return;
        const id = utf(clientId);
        send(0x10, cat(new Uint8Array([0, 4, 77, 81, 84, 84, 4, 2, 0, 30]), len16(id.length), id));
      };
      w.onmessage = (e) => {
        if (w !== ws) return;
        rx = Date.now();
        buf = cat(buf, new Uint8Array(e.data));
        for (;;) {
          if (buf.length < 2) return;
          let mul = 1, n = 0, i = 1, b;
          do { if (i >= buf.length) return; b = buf[i++]; n += (b & 127) * mul; mul *= 128; } while (b & 128);
          if (buf.length < i + n) return;
          const h0 = buf[0], type = h0 >> 4, body = buf.slice(i, i + n); buf = buf.slice(i + n);
          if (type === 2) {
            clearTimeout(cto);
            if (body[1] !== 0) { drop(); return; }
            c.connected = true; retry = 0; (c._subs || []).forEach(sendSub);
            clearInterval(ping); ping = setInterval(() => { if (Date.now() - rx > 15000) drop('stale'); else send(0xc0, new Uint8Array(0)); }, 5000);
            emit('connect');
          }
          else if (type === 3) { const tl = (body[0] << 8) | body[1], t = new TextDecoder().decode(body.subarray(2, 2 + tl)); let off = 2 + tl; if ((h0 >> 1 & 3) > 0) off += 2; emit('message', t, new TextDecoder().decode(body.subarray(off))); }
        }
      };
      w.onclose = w.onerror = () => { if (w === ws) drop(); };
    }
    function later() { if (dead) return; retry++; clearTimeout(wait); wait = setTimeout(open, retry === 1 ? 700 : Math.min(15000, 1500 * retry)); }
    open();
    return c;
  }

  // ---------- relays: several MQTT brokers + ntfy.sh, all at once ----------
  let relays = [];            // {name, kind, ok, send(str, suffix), stop()}
  function base() { return 'party/v1/' + G.game + '/' + code; }
  function relayStatus() { const ok = relays.filter(r => r.ok).length; return relays.length ? ok + ' из ' + relays.length : '—'; }
  function relayUp() { return relays.some(r => r.ok); }
  // suffix: 'h' (host inbox) | 'all' (broadcast to guests) | 'g/<token>' (one guest). `imp` = may also go through slow ntfy.
  // Outgoing relay traffic is queued per topic and flushed as one batch publish per RELAY_TICK (see flushRelays).
  const RQ = {};   // suffix -> { list: [json strings], fast: {key: json string}, imp: bool }
  function rq(suffix) { return RQ[suffix] || (RQ[suffix] = { list: [], fast: {}, imp: false }); }
  function relayPub(suffix, s, imp) {
    if (nearby) return;
    const q = rq(suffix); q.list.push(s); if (q.list.length > 1500) q.list.splice(0, q.list.length - 1500);
    if (imp) { q.imp = true; ntfyMaybe(s); }
  }
  function relayFast(suffix, key, s) { rq(suffix).fast[key] = s; }
  function mqttUp() { return relays.some(r => r.ok && r.kind === 'mqtt'); }
  function take(r) {
    const t = now(), pen = t < (r.penalty || 0) ? 0.45 : 1;
    r.tokens = Math.min(BUCKET_CAP, (r.tokens == null ? BUCKET_CAP : r.tokens) + (t - (r.refill || t)) / 1000 * BUCKET_RATE * pen); r.refill = t;
    if (r.tokens < 1) return false; r.tokens -= 1; return true;
  }
  let ntfyTokens = 12, ntfyRefill = 0;
  function ntfyMaybe(s) {
    // ntfy.sh: a different provider, often reachable when the MQTT brokers are not. It allows only a small burst per public IP
    // (shared by every phone on the Wi-Fi), so only joining, room control and WebRTC signalling go through it, on a budget.
    if (s.length > 3800) return;
    const t = now(); ntfyTokens = Math.min(12, ntfyTokens + (t - (ntfyRefill || t)) / 5000); ntfyRefill = t;
    if (ntfyTokens < 1) return; ntfyTokens -= 1;
    relays.forEach(r => { if (r.ok && r.kind === 'ntfy') r.send(s); });
  }
  let lastFlushR = 0;
  function flushRelays(force) {
    if (!code || !relays.length) return;
    const t = now(); if (!force && t - lastFlushR < RELAY_TICK - 4) return; lastFlushR = t;
    for (const suffix in RQ) {
      const q = RQ[suffix], fk = Object.keys(q.fast);
      if (!q.list.length && !fk.length) continue;
      const items = []; let size = 0, used = 0;
      for (const k of fk) { items.push(q.fast[k]); size += q.fast[k].length; }
      while (used < q.list.length && (size + q.list[used].length < BATCH_MAX || !items.length)) { size += q.list[used].length + 1; items.push(q.list[used]); used++; }
      const batch = '{"t":"B","i":' + JSON.stringify(tok) + ',"b":[' + items.join(',') + ']}';
      let sent = 0;
      relays.forEach(r => { if (r.ok && r.kind === 'mqtt' && (force || take(r))) { r.send(batch, suffix); sent++; } });
      if (sent) { q.list.splice(0, used); q.fast = {}; q.imp = false; }
      else if (!mqttUp()) { q.fast = {}; if (q.list.length > 300) q.list.splice(0, q.list.length - 300); }  // keep reliable items for when a broker comes back
    }
  }
  function mqttRelay(url, ss, subs) {
    const name = url.replace(/^wss?:\/\/|:\d+\/mqtt$/g, '').replace(/^broker\.|^test\.|^mqtt\./, '');
    const r = { name, kind: 'mqtt', ok: false, send() {}, stop() {}, tokens: BUCKET_CAP, refill: 0, penalty: 0 };
    const id = 'party_' + tok + '_' + rnd(4);
    const cl = (window.mqtt && window.mqtt.connect) ? window.mqtt.connect(url, { clientId: id, keepalive: 20, reconnectPeriod: 3000, connectTimeout: 7000, clean: true }) : MiniMqtt(url, id);
    cl.on('connect', () => { if (ss !== session) return; r.ok = true; subs.forEach(s => cl.subscribe(base() + '/' + s, { qos: 0 }, () => {})); diag.mq = relayStatus(); ui(); onRelayUp(); });
    cl.on('close', (why) => { if (r.ok && why !== 'stale') r.penalty = now() + 30000; r.ok = false; diag.mq = relayStatus(); ui(); });  // probably throttled: publish slower to it for a while
    cl.on('message', (t, buf) => { if (ss === session) relayIn(String(buf), 'mqtt'); });
    r.send = (s, suffix) => { try { cl.publish(base() + '/' + suffix, s, { qos: 0 }); } catch (e) {} };
    r.stop = () => { try { cl.end(true); } catch (e) {} };
    r.check = () => { try { if (cl.check) cl.check(); } catch (e) {} };
    return r;
  }
  function ntfyRelay(ss) {
    // ntfy.sh: slow but very common; only signalling and lobby control go through it (see `imp`), one topic, filtered by `to`
    const r = { name: 'ntfy', kind: 'ntfy', ok: false, send() {}, stop() {} };
    if (window.mqtt || window.DUO_TEST_BROKERS) return r; // test harness
    const tp = ('party1' + G.game + code + 'x').replace(/[^a-zA-Z0-9_-]/g, '');
    // ntfy sends a keepalive event every 45 s: 70 s of silence means a dead socket (the phone slept, the network changed)
    let ws = null, dead = false, retry = 0, wait = 0, rx = 0;
    function open() {
      if (dead || ss !== session || ws) return;
      let w; try { w = ws = new WebSocket('wss://' + NTFY + '/' + tp + '/ws'); } catch (e) { ws = null; return later(); }
      w.onopen = () => { if (w !== ws) return; rx = now(); r.ok = true; retry = 0; diag.mq = relayStatus(); ui(); onRelayUp(); };
      w.onmessage = (e) => { if (w !== ws) return; rx = now(); let d; try { d = JSON.parse(e.data); } catch (er) { return; } if (d.event === 'message' && typeof d.message === 'string') relayIn(d.message, 'ntfy'); };
      w.onclose = w.onerror = () => { if (w === ws) drop(); };
    }
    function drop() { const w = ws; if (!w) return; ws = null; try { w.close(); } catch (e) {} const was = r.ok; r.ok = false; if (was) { diag.mq = relayStatus(); ui(); } later(); }
    function later() { if (dead) return; retry++; clearTimeout(wait); wait = setTimeout(open, Math.min(20000, 2000 * retry)); }
    const wd = setInterval(() => { if (ws && r.ok && now() - rx > 70000) drop(); }, 10000);
    r.send = (s) => { fetch('https://' + NTFY + '/' + tp, { method: 'POST', body: s, mode: 'cors', keepalive: true }).catch(() => {}); };
    r.check = () => { if (dead) return; if (!ws) { clearTimeout(wait); retry = 0; open(); } else if (r.ok && now() - rx > 50000) drop(); };
    r.stop = () => { dead = true; clearInterval(wd); clearTimeout(wait); try { ws && ws.close(); } catch (e) {} ws = null; };
    open();
    return r;
  }
  function checkRelays() { relays.forEach(r => { if (r.check) r.check(); }); }
  function relaysStart(ss) {
    const subs = isHost ? ['h'] : ['all', 'g/' + tok];
    relays = BROKERS.map(u => mqttRelay(u, ss, subs)); relays.push(ntfyRelay(ss));
    diag.mq = 'подключаюсь…';
  }
  const seenVia = { mqtt: {}, ntfy: {} };   // peer token -> last time a packet from it arrived through this kind of relay
  function relayIn(text, kind) {
    let d; try { d = JSON.parse(text); } catch (e) { return; }
    if (d && typeof d.i === 'string' && d.i !== tok) seenVia[kind === 'ntfy' ? 'ntfy' : 'mqtt'][d.i] = now();
    if (d && d.t === 'B' && Array.isArray(d.b)) { if (d.i === tok) return; d.b.forEach(x => onPkt(x, 'mq')); }
    else onPkt(d, 'mq');
  }
  // a peer we only hear through ntfy (no common MQTT broker): keep it alive with rare keep-alives over ntfy
  function ntfyOnly(peer) { const t = now(); return t - (seenVia.ntfy[peer] || 0) < 20000 && t - (seenVia.mqtt[peer] || 0) > 12000; }

  // ---------- links (one per guest on the host, one to the host on a guest) ----------
  const L = {};
  function Lk(key) { return L[key] || (L[key] = { key, pc: null, fast: null, safe: null, sid: '', answered: false, resend: 0, made: 0, tRtc: 0, tMq: 0, openT: 0, rtt: { rtc: 0, mq: 0 } }); }
  const fastOpen = (lk) => !!(lk && lk.fast && lk.fast.readyState === 'open');
  const safeOpen = (lk) => !!(lk && lk.safe && lk.safe.readyState === 'open');
  function alive(lk) { return fastOpen(lk) && now() - Math.max(lk.tRtc, lk.openT) < 3500; }
  function chSend(ch, s) { try { if (ch.readyState === 'open' && (ch.bufferedAmount || 0) < 262144) ch.send(s); } catch (e) {} }
  // mode: 'fast' (rtc fast channel, else relay) | 'rel' (rtc ordered channel, else relay) | 'both' (rtc and relay) | 'mq' (relay only)
  function xmit(key, m, mode, imp) {
    m.to = isHost ? key : 'h';
    const s = JSON.stringify(m), lk = L[key], al = alive(lk), suffix = isHost ? 'all' : 'h';
    if (mode === 'fast') { if (al) return chSend(lk.fast, s); if (m.t === 'p' || m.t === 'P') return relayFast(suffix, m.t + (isHost ? key : ''), s); }
    else if (mode === 'rel') { if (al && safeOpen(lk)) return chSend(lk.safe, s); }
    else if (mode === 'both') { if (al) chSend(safeOpen(lk) ? lk.safe : lk.fast, s); }
    relayPub(suffix, s, imp);
  }
  function pk(t, extra) { return Object.assign({ t, i: tok, e: ep, s: ++sseq, w: now() }, extra); }

  // ---------- reliable ordered stream per link (+ NACK resend over the relays) ----------
  const OUT = {}, IN = {};
  const outS = (k) => OUT[k] || (OUT[k] = { q: 0, buf: [], ack: 0 });
  const inS = (k) => IN[k] || (IN[k] = { next: 1, hold: {}, since: 0, nacked: 0 });
  function sendRel(key, k, d, fr, ts) {
    const o = outS(key), m = pk('m', { q: ++o.q, k, d });
    if (fr != null) m.fr = fr; if (ts != null) m.ts = ts;
    o.buf.push(m); m._t = now(); if (o.buf.length > 1000) o.buf.shift();
    xmit(key, m, 'rel');
  }
  function onRel(key, m) {
    const s = inS(key);
    if (m.q < s.next) return;
    if (m.q > s.next) { s.hold[m.q] = m; if (!s.since) s.since = now(); return; }
    procRel(key, m); s.next++;
    drain(key, s);
  }
  function drain(key, s) {
    while (s.hold[s.next]) { const m = s.hold[s.next]; delete s.hold[s.next]; procRel(key, m); s.next++; }
    s.since = Object.keys(s.hold).length ? (s.since || now()) : 0;
  }
  function checkStreams() {
    for (const key in IN) {
      const s = IN[key]; if (!s.since) continue;
      const age = now() - s.since;
      if (age > 15000) { s.next = Math.min(...Object.keys(s.hold).map(Number)); drain(key, s); continue; }  // give up on a hole only after retransmits had plenty of time
      if (age > 350 && now() - s.nacked > 900) {
        s.nacked = now();
        const n = pk('nack', { from: s.next }); n.to = isHost ? key : 'h';
        relayPub(isHost ? 'all' : 'h', JSON.stringify(n), false);
      }
    }
    // sender side: resend what the peer has not acknowledged yet
    const t0 = now();
    for (const key in OUT) {
      const o = OUT[key], lk = L[key], rto = alive(lk) ? 900 : 2200; let n = 0;
      for (const m of o.buf) { if (m.q <= o.ack) continue; if (t0 - (m._t || 0) > rto) { m._t = t0; xmit(key, m, 'both'); if (++n >= 30) break; } }
    }
  }
  function onAck(key, n) {
    const o = OUT[key]; if (!o || typeof n !== 'number' || n <= o.ack) return;
    o.ack = n; while (o.buf.length && o.buf[0].q <= n) o.buf.shift();
  }
  const ackOf = (key) => (IN[key] ? IN[key].next - 1 : 0);
  function onNack(key, d) {
    const o = OUT[key]; if (!o || typeof d.from !== 'number') return;
    const t0 = now(); o.buf.filter(m => m.q >= d.from).slice(0, 60).forEach(m => { m._t = t0; xmit(key, m, 'both'); });
  }
  function procRel(key, m) {
    if (isHost) {
      const S = seatByTok[key]; if (!S) return;
      const target = typeof m.ts === 'number' ? m.ts : null;
      if (target == null || target === 0) call('msg', m.k, m.d, S.slot);
      seats.forEach(T => { if (T.slot !== 0 && T.slot !== S.slot && T.online && (target == null || target === T.slot)) sendRel(T.tok, m.k, m.d, S.slot); });
    } else call('msg', m.k, m.d, typeof m.fr === 'number' ? m.fr : 0);
  }

  // ---------- inbound packets ----------
  const seen = new Set(), seenQ = [];
  const rttPend = {};
  function onPkt(d, via, lkIn) {
    if (!d || typeof d !== 'object' || typeof d.i !== 'string' || d.i === tok || !code) return;
    if (isHost && lkIn && lkIn.key !== d.i && lkIn.key[0] === '~') bindNear(lkIn, d.i);
    if (d.to && d.to !== tok && !(d.to === 'h' && isHost)) return;
    const t0 = now();
    if (d.t !== 'p' && d.t !== 'P' && d.t !== 'm') {
      const key = d.i + d.e + ':' + d.s;
      if (seen.has(key)) return;
      seen.add(key); seenQ.push(key); if (seenQ.length > 5000) seen.delete(seenQ.shift());
    }
    if (isHost) {
      const S0 = seatByTok[d.i]; if (S0 && S0.byeEp && d.e === S0.byeEp) return;  // late copies (other brokers) after a farewell
      if (d.t === 'join') return hostJoin(d, via);
      const S = seatByTok[d.i]; if (!S) return;
      if (d.e !== S.ep) { if (d.t === 'hb' || d.t === 'p') return; }
      S.last = t0;
      const lk = Lk(d.i); if (via === 'rtc') lk.tRtc = t0; else lk.tMq = t0;
      if (!S.online) setOnline(S, true);
      switch (d.t) {
        case 'hb': hostHb(S, d); if (d.ak != null) onAck(d.i, d.ak); break;
        case 'p': hostState(S, d); break;
        case 'm': onRel(d.i, d); break;
        case 'nack': onNack(d.i, d); break;
        case 'q': xmit(d.i, pk('a', { ts: d.ts }), via === 'rtc' ? 'fast' : 'mq'); break;
        case 'sig': onSig(d); break;
        case 'bye': S.byeEp = d.e; removeSeat(S); break;
      }
      return;
    }
    // guest
    if (typeof d.e === 'string' && d.e !== hostEp) { if (oldEps.has(d.e)) return; if (hostEp) { oldEps.add(hostEp); hostReset(); } hostEp = d.e; }   // late copies from before the reload: ignored
    hostLast = t0; if (d.t !== 'B') hostTok = d.i;
    const lk = Lk('H'); if (via === 'rtc') lk.tRtc = t0; else lk.tMq = t0;
    if (st === 'lost' && !hostDead && d.t !== 'hostbye') { st = 'joining'; joinSince = t0; sendJoin(); }
    switch (d.t) {
      case 'welcome': guestWelcome(d); break;
      case 'full': if (st === 'joining' || st === 'lost') giveUp(d.why === 'started' ? 'Игра уже идёт, присоединиться нельзя' : 'Комната заполнена', true); break;
      case 'roster': if (st === 'joined') applyRoster(d.room, false); break;
      case 'start': if (st === 'joined' && d.cfg) { room.started = true; room.cfg = d.cfg; fireStart(d.cfg, false); } break;
      case 'm': onRel('H', d); break;
      case 'P': guestStates(d); break;
      case 'hh': if (d.acks && typeof d.acks[tok] === 'number') onAck('H', d.acks[tok]); break;
      case 'nack': onNack('H', d); break;
      case 'a': if (typeof d.ts === 'number') { const v = performance.now() - d.ts; if (v >= 0 && v < 20000) lk.rtt[via] = lk.rtt[via] ? lk.rtt[via] * 0.7 + v * 0.3 : v; } break;
      case 'sig': onSig(d); break;
      case 'hostbye': hostDead = true; hostGone('Хозяин вышел из комнаты'); break;
      case 'kicked': giveUp('Хозяин убрал вас из комнаты', true); break;
    }
  }

  // the host's page was reloaded (a new epoch): its reliable stream, state counters, room versions and the direct link start over
  function hostReset() {
    delete OUT.H; delete IN.H; closeLink('H');
    for (const k in ST) delete ST[k];
    room.v = 0; lastEv = 0; lastMatch = 0;
  }

  // ---------- host: seats, roster ----------
  function cleanName(n) { n = String(n == null ? '' : n).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14); return n || 'Игрок'; }
  function uniqName(n, except) {
    let base0 = n, k = 1; const taken = () => seats.some(S => S !== except && S.name.toLowerCase() === n.toLowerCase());
    while (taken()) { k++; n = base0.slice(0, 12) + ' ' + k; }
    return n;
  }
  function modeInfo(id) { return G.modes.find(m => m.id === id) || null; }
  function teamsN() { const m = modeInfo(room.mode); return m ? (m.teams || (m.id === 'teams' ? 2 : 0)) : 0; }
  function pubPlayers() {
    return seats.map(S => ({ slot: S.slot, id: S.id, name: S.name, skin: S.skin, team: S.team, online: S.online, host: S.slot === 0, via: S.slot === 0 ? '' : (alive(L[S.tok]) ? 'rtc' : 'mq'), ms: S.ms || 0 }));
  }
  function pubRoom() { return { v: room.v, mode: room.mode, opts: room.opts, started: room.started, cfg: room.started ? room.cfg : null, match: room.match, players: pubPlayers(), evn: room.evn, ev: room.ev, teams: teamsN() }; }
  function syncMyRoom() {
    room.players = pubPlayers();
    const p = room.players.find(x => x.id === me.id);
    if (p) { me.slot = p.slot; me.name = p.name; me.skin = p.skin; me.team = p.team; }
  }
  function bump() { room.v++; syncMyRoom(); bcastRoster(true); ui(); call('roster', room.players); [350, 1100].forEach(ms => { const v = room.v, ss = session; setTimeout(() => { if (ss === session && isHost && v === room.v) bcastRoster(); }, ms); }); }
  function bcastRoster(imp) {
    if (!isHost) return;
    syncMyRoom();
    const m = pk('roster', { room: pubRoom() }), s = JSON.stringify(m);
    relayPub('all', s, !!imp);
    seats.forEach(S => { if (S.slot) { const lk = L[S.tok]; if (alive(lk)) chSend(safeOpen(lk) ? lk.safe : lk.fast, s); } });
  }
  function hostEvent(k, slot) { room.ev.push({ n: ++room.evn, k, slot }); if (room.ev.length > 24) room.ev.shift(); call(k, slot); }
  function fixSkin(S, wanted) {
    S.reqSkin = JSON.stringify(wanted == null ? null : wanted);
    let sk = wanted;
    if (G.resolveSkin && sk != null) { try { const r = G.resolveSkin(clone(sk), seats.filter(x => x !== S).map(x => clone(x.skin))); if (r != null) sk = r; } catch (e) {} }
    return sk;
  }
  function addSeat(t, d) {
    const slot = seats.length;
    const S = { tok: t, id: rnd(6), slot, name: '', skin: null, team: 0, online: true, last: now(), ep: d && d.e, ms: 0, reqSkin: '' };
    S.name = uniqName(cleanName(d && d.name), S);
    S.skin = fixSkin(S, d && d.skin);
    const n = teamsN(); S.team = n ? slot % n : 0;
    seats.push(S); seatByTok[t] = S; return S;
  }
  function hostJoin(d, via) {
    if (st !== 'hosting' || typeof d.i !== 'string') return;
    let S = seatByTok[d.i], isNew = false;
    if (!S) {
      if (room.started && !HUB) { xmit(d.i, pk('full', { why: 'started' }), 'both', true); return; }
      if (seats.length >= (HUB ? CAP : G.max)) { xmit(d.i, pk('full', { why: 'full' }), 'both', true); return; }
      S = addSeat(d.i, d); isNew = true;
    } else {
      if (S.ep !== d.e) { S.ep = d.e; delete OUT[S.tok]; delete IN[S.tok]; const r = rec(S.slot); r.lastS = 0; closeLink(S.tok); }
      let changed = false;
      const nm = uniqName(cleanName(d.name), S); if (nm !== S.name) { S.name = nm; changed = true; }
      const rq = JSON.stringify(d.skin == null ? null : d.skin);
      if (rq !== S.reqSkin) { S.skin = fixSkin(S, d.skin); changed = true; }
      if (!S.online) { S.last = now(); setOnline(S, true); changed = false; }
      else if (changed) bump();
    }
    S.last = now();
    const lk = Lk(S.tok); if (via === 'rtc') lk.tRtc = now(); else lk.tMq = now();
    const w = pk('welcome', { pid: S.id, slot: S.slot, room: pubRoom() });
    xmit(S.tok, w, 'both', true);
    if (isNew) { hostEvent('join', S.slot); bump(); }
  }
  function hostHb(S, d) {
    let changed = false;
    if (typeof d.ms === 'number') S.ms = Math.round(d.ms);
    if (typeof d.name === 'string') { const nm = uniqName(cleanName(d.name), S); if (nm !== S.name) { S.name = nm; changed = true; } }
    if (d.skin !== undefined) { const rq = JSON.stringify(d.skin == null ? null : d.skin); if (rq !== S.reqSkin) { S.skin = fixSkin(S, d.skin); changed = true; } }
    if (changed) bump();
  }
  function setOnline(S, on) {
    if (S.online === on) return;
    S.online = on; hostEvent(on ? 'join' : 'leave', S.slot); bump();
  }
  function closeLink(key) {
    const lk = L[key]; if (!lk) return;
    clearInterval(lk.resend); try { if (lk.pc) lk.pc.close(); } catch (e) {}
    lk.pc = lk.fast = lk.safe = null; lk.sid = ''; lk.made = 0;
  }
  function removeSeat(S) {
    if (S.slot === 0 || !seatByTok[S.tok]) return;
    if (room.started) { setOnline(S, false); return; }
    const old = S.slot;
    seats = seats.filter(x => x !== S); delete seatByTok[S.tok]; closeLink(S.tok); delete OUT[S.tok]; delete IN[S.tok];
    seats.forEach((x, i) => { x.slot = i; });
    for (const k in ST) delete ST[k]; // slots shifted: drop buffered states (lobby only)
    hostEvent('leave', old); bump();
  }
  function goOffline(S) { if (room.started) setOnline(S, false); else removeSeat(S); }
  function hostState(S, d) {
    if (!d.p || typeof d.p !== 'object' || typeof d.s !== 'number') return;
    const r = rec(S.slot); if (d.s <= r.lastS) return;
    r.lastS = d.s; r.w = d.w; r.latest = d.p; r.fq++; r.ver++; recordSnap(r, d.w, d.p);
    if (HUB) call('state', S.slot);
  }
  // forward fresh states from everyone to every guest as one bundle (20–60 Hz over rtc, ~20 Hz over a relay)
  const lastBundle = {};
  let lastRelayBundle = 0;
  function bundleTick() {
    if (!code) return;
    flushRelays(false);
    if (!isHost || seats.length < 2) return;
    const t0 = now();
    if (t0 - lastRelayBundle >= RELAY_TICK - 4 && seats.some(G2 => G2.slot && G2.online && !alive(L[G2.tok]))) {
      lastRelayBundle = t0; const es = [];
      seats.forEach(S => { const r = ST[S.slot]; if (r && r.latest && (r.ver > (r.sentR || 0) || t0 - (r.sentRT || 0) > 1000)) { r.sentR = r.ver; r.sentRT = t0; es.push([S.slot, r.fq, r.w || t0, r.latest]); } });
      if (es.length) relayFast('all', 'P', JSON.stringify(pk('P', { es })));
    }
    seats.forEach(G2 => {
      if (G2.slot === 0 || !G2.online) return;
      const lk = L[G2.tok]; if (!alive(lk)) return;
      if (t0 - (lastBundle[G2.tok] || 0) < 16) return;
      const es = [];
      seats.forEach(S => { if (S.slot === G2.slot) return; const r = ST[S.slot]; if (r && r.latest && r.ver > (r.sent[G2.tok] || 0)) { r.sent[G2.tok] = r.ver; es.push([S.slot, r.fq, r.w || t0, r.latest]); } });
      if (!es.length) return;
      lastBundle[G2.tok] = t0;
      xmit(G2.tok, pk('P', { es }), 'fast');
    });
  }
  function guestStates(d) {
    if (!Array.isArray(d.es)) return;
    d.es.forEach(e => { if (e[0] === me.slot) return; const r = rec(e[0]); if (e[1] <= r.fq) return; r.fq = e[1]; r.w = e[2]; r.latest = e[3]; r.ver++; recordSnap(r, e[2], e[3]); if (HUB) call('state', e[0]); });
  }

  // ---------- guest ----------
  function sendJoin() {
    if (isHost || !code) return;
    xmit('H', pk('join', { name: myName, skin: localSkin }), 'both', true);
  }
  function guestWelcome(d) {
    if (typeof d.pid !== 'string' || !d.room) return;
    const was = st;
    me.id = d.pid; me.slot = d.slot; st = 'joined'; error = '';
    if (hostLostFired) { hostLostFired = false; call('hostBack'); }
    if (was !== 'joined') { lastEv = d.room.evn; applyRoster(d.room, true); startRtcSoon(); }
    else applyRoster(d.room, false);
    saveAct();
    if (silent) { silent = false; if (!room.started) { buildOverlay(); ov.hidden = false; ui(); } }
  }
  function applyRoster(r, fromWelcome) {
    if (!r || typeof r.v !== 'number') return;
    if (r.v < room.v && !fromWelcome) return;
    const was = room, changed = r.v > room.v || fromWelcome;
    if (!changed) { // same version: only link quality changes
      (r.players || []).forEach(p => { const q = room.players.find(x => x.id === p.id); if (q) { q.via = p.via; q.ms = p.ms; } });
      return;
    }
    room = { v: r.v, mode: r.mode, opts: r.opts || {}, started: !!r.started, cfg: r.cfg || null, match: r.match || 0, players: r.players || [], evn: r.evn || 0, ev: r.ev || [], teams: r.teams || 0 };
    const p = room.players.find(x => x.id === me.id);
    if (!p) { if (st === 'joined') { st = 'joining'; joinSince = now(); sendJoin(); } ui(); return; }
    me.slot = p.slot; me.name = p.name; me.skin = p.skin; me.team = p.team;
    if (!room.started) { sawLobby = true; if (was.players.length !== room.players.length) for (const k in ST) delete ST[k]; }
    // events (leave / join) in order
    (r.ev || []).filter(e => e.n > lastEv).forEach(e => { lastEv = e.n; if (e.slot !== me.slot) call(e.k, e.slot); });
    if (r.evn > lastEv) lastEv = r.evn;
    ui(); call('roster', room.players);
    if (was.started && !room.started) { clearAct(); call('end'); }
    if (room.started && room.cfg && room.cfg.match > lastMatch) fireStart(room.cfg, fromWelcome && !sawLobby);
  }
  function fireStart(cfg, rejoin) {
    if (cfg.match <= lastMatch) return;
    lastMatch = cfg.match; sawLobby = false;
    const c = clone(cfg); c.rejoin = !!rejoin;
    me.team = (cfg.players.find(p => p.id === me.id) || me).team || 0;
    saveAct();
    if (HUB) { call('start', c); return; }   // hub.js decides whether this match is for the game open on this phone
    hideOverlay();
    if (lobbyRes) { const r = lobbyRes; lobbyRes = null; r(c); }
    call('start', c);
  }
  function hostGone(msg) {
    if (st === 'lost') return;
    st = 'lost'; error = msg || 'Хозяин пропал'; ui();
    if (!hostLostFired) { hostLostFired = true; call('hostLost'); }
  }
  function giveUp(msg, show) {
    const wasSilent = silent;
    stopAll(); clearAct(); st = 'idle'; code = ''; isHost = false; silent = false;
    error = wasSilent ? '' : (msg || ''); view = 'main';
    if (!wasSilent && show) { buildOverlay(); ov.hidden = false; }
    ui();
  }
  // the host's room survives a reload of the page (iOS often reloads a home-screen app that was in the background):
  // same code and token, the guests that keep knocking get their seats again
  function saveHost() {
    if (!isHost || !code || !tok || nearby || !seats[0]) return;
    const v = JSON.stringify({ code, tok, id: seats[0].id, t: now() });
    ssSet('party.host.' + G.game, v); lsSet('party.host.' + G.game, v);
  }
  function clearHost() { ssDel('party.host.' + G.game); lsDel('party.host.' + G.game); }
  function saveAct() {
    if (isHost) return saveHost();
    if (!code || !tok || nearby) return;
    const v = JSON.stringify({ code, tok, t: now() });
    ssSet('party.act.' + G.game, v); lsSet('party.act.' + G.game, v);
  }
  function clearAct() { ssDel('party.act.' + G.game); lsDel('party.act.' + G.game); }
  function tokenFor(c) {
    const k = 'party.tok.' + G.game + '.' + c;
    let t = ssGet(k) || lsGet(k);
    if (!t) t = rnd(10) + rnd(6);
    ssSet(k, t); lsSet(k, t);
    return t;
  }

  // ---------- fast state out ----------
  let mine = {}, flushTimer = 0, lastFlush = 0;
  function flushState(force) {
    flushTimer = 0; lastFlush = now();
    if (!code || (st !== 'joined' && st !== 'hosting')) return;
    const w = now();
    if (isHost) { const r = rec(0); r.lastS = ++pseq; r.fq++; r.latest = { ...mine }; r.w = w; r.ver++; recordSnap(r, w, r.latest); return; }
    xmit('H', pk('p', { s: ++pseq, w, p: mine }), force ? 'mq' : 'fast');
  }
  function scheduleFlush() {
    if (flushTimer) return;
    const gap = alive(L.H) || isHost ? 16 : RELAY_TICK;
    flushTimer = setTimeout(() => flushState(false), Math.max(0, gap - (now() - lastFlush)));
  }

  // ---------- WebRTC (host offers, guest answers; signalling over the relays) ----------
  function gatherDone(pc, ms) {
    return new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  function rtcWire(lk, ch, pc) {
    ch.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch (er) { return; } onPkt(d, 'rtc', lk); };
    ch.onopen = () => {
      if (pc !== lk.pc) return;
      if (ch.label === 'duo') { lk.fast = ch; lk.openT = now(); rtcDiag(); ui(); if (!isHost) { if (st === 'joining') { lastJoin = now(); sendJoin(); } flushState(false); sendHb(); } } else lk.safe = ch;
    };
    ch.onclose = () => { if (pc === lk.pc && ch === lk.fast) { lk.fast = null; rtcDiag(); ui(); } };
  }
  function rtcNewPc(lk) {
    try { if (lk.pc) lk.pc.close(); } catch (e) {}
    lk.fast = lk.safe = null; lk.answered = false;
    const pc = lk.pc = new RTCPeerConnection({ iceServers: nearby ? [] : STUN });
    pc.onconnectionstatechange = () => {
      if (pc !== lk.pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { rtcDiag(); ui(); if (!isHost) setTimeout(rtcKick, 3000); }
      if (pc.connectionState === 'connected') { rtcDiag(); ui(); }
    };
    return pc;
  }
  function sigSend(key, k, extra) { const m = pk('sig', Object.assign({ k, sid: L[key].sid }, extra)); m.to = isHost ? key : 'h'; relayPub(isHost ? 'all' : 'h', JSON.stringify(m), true); }
  async function rtcOffer(key) {
    if (!rtcOk()) return;
    const lk = Lk(key);
    lk.sid = rnd(8); lk.made = now();
    const pc = rtcNewPc(lk), sid = lk.sid;
    rtcWire(lk, pc.createDataChannel('duo', { ordered: false, maxRetransmits: 0 }), pc);
    rtcWire(lk, pc.createDataChannel('duo-safe', { ordered: true }), pc);
    await pc.setLocalDescription(await pc.createOffer());
    await gatherDone(pc, 2500);
    if (pc !== lk.pc) return;
    const sdp = pc.localDescription.sdp;
    let n = 0; clearInterval(lk.resend);
    lk.resend = setInterval(() => { if (pc !== lk.pc || lk.answered || ++n > 8) { clearInterval(lk.resend); return; } sigSend(key, 'offer', { sdp, sid }); }, 2500);
    sigSend(key, 'offer', { sdp, sid });
  }
  function rtcKick() {
    if (!code || isHost || st !== 'joined' || !rtcOk()) return;
    if (alive(L.H)) return;
    xmit('H', pk('sig', { k: 'hi' }), 'mq', true);
  }
  let rtcSoon = 0;
  function startRtcSoon() { clearTimeout(rtcSoon); rtcSoon = setTimeout(rtcKick, 50); }
  function onRelayUp() { if (!isHost) { if (st === 'joining') sendJoin(); startRtcSoon(); } }
  async function onSig(d) {
    if (!rtcOk()) return;
    if (isHost) {
      const S = seatByTok[d.i]; if (!S) return;
      const lk = Lk(d.i);
      if (d.k === 'hi') {
        const cs = lk.pc ? lk.pc.connectionState : 'none';
        const stuck = !lk.pc || cs === 'failed' || cs === 'closed' || (!fastOpen(lk) && now() - lk.made > 15000) || (fastOpen(lk) && !alive(lk) && now() - lk.made > 15000);
        if (!alive(lk) && stuck) rtcOffer(d.i).catch(() => {});
        return;
      }
      if (d.k === 'answer' && d.sid === lk.sid && lk.pc && !lk.answered && typeof d.sdp === 'string') {
        lk.answered = true;
        try { await lk.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp }); } catch (e) { lk.answered = false; }
      }
      return;
    }
    if (d.k === 'offer' && typeof d.sdp === 'string') {
      const lk = Lk('H');
      if (d.sid === lk.sid && lk.pc) return;
      lk.sid = d.sid;
      const pc = rtcNewPc(lk);
      pc.ondatachannel = (e) => rtcWire(lk, e.channel, pc);
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await gatherDone(pc, 2500);
        if (pc !== lk.pc) return;
        const sdp = pc.localDescription.sdp; let n = 0;
        const t = setInterval(() => { if (pc !== lk.pc || fastOpen(lk) || ++n > 4) { clearInterval(t); return; } sigSend('H', 'answer', { sdp, sid: d.sid }); }, 2500);
        sigSend('H', 'answer', { sdp, sid: d.sid });
      } catch (e) { diag.rtc = 'ошибка'; ui(); }
    }
  }
  function rtcDiag() {
    if (!rtcOk()) { diag.rtc = 'недоступна'; return; }
    if (isHost) { const g = seats.filter(S => S.slot); diag.rtc = g.length ? g.filter(S => alive(L[S.tok])).length + ' из ' + g.length : '—'; }
    else diag.rtc = alive(L.H) ? 'работает' : (L.H && L.H.pc ? 'соединяюсь…' : '—');
  }

  // ---------- periodic work ----------
  let lastHb = 0, lastPingR = 0, lastPingM = 0, lastRoster = 0, lastKick = 0, lastJoin = 0, lastAct = 0, lastHh = 0, lastNtHb = 0, lastNtHh = 0, hostTok = '';
  function hostHh() {
    // tiny host heartbeat with the acks of every guest stream: direct to linked guests, one copy on the relays for the rest
    const acks = {}; seats.forEach(S => { if (S.slot) acks[S.tok] = ackOf(S.tok); });
    const m = pk('hh', { acks }), s = JSON.stringify(m); let anyRelay = false;
    seats.forEach(S => { if (!S.slot || !S.online) return; const lk = L[S.tok]; if (alive(lk)) chSend(lk.fast, s); else anyRelay = true; });
    if (anyRelay || seats.length > 1) relayFast('all', 'hh', s);
    if (seats.some(S => S.slot && S.online && !alive(L[S.tok]) && ntfyOnly(S.tok)) && now() - lastNtHh > 7000) { lastNtHh = now(); ntfyMaybe(s); }
  }
  function sendHb() {
    if (isHost || st !== 'joined') return;
    const lk = Lk('H'), al = alive(lk);
    const hb = pk('hb', { name: myName, skin: localSkin, ms: Math.round((al ? lk.rtt.rtc : lk.rtt.mq) || 0), ak: ackOf('H') });
    const slowNt = !al && hostTok && ntfyOnly(hostTok) && now() - lastNtHb > 7000; if (slowNt) lastNtHb = now();
    xmit('H', hb, 'both', slowNt);
    if (Object.keys(mine).length) flushState(true);
  }
  function tick() {
    if (!code) return;
    const t0 = now();
    checkStreams();
    if (isHost) {
      seats.slice().forEach(S => { if (S.slot && S.online && t0 - S.last > (room.started ? T_GUEST_OFF : T_GUEST_DROP)) goOffline(S); });
      if (t0 - lastHh > 1000) { lastHh = t0; hostHh(); }
      if (t0 - lastRoster > 3000) { lastRoster = t0; bcastRoster(); rtcDiag(); ui(); }
      if (t0 - lastAct > 10000) { lastAct = t0; saveHost(); }
      weak(seats.filter(S => S.slot && S.online && t0 - S.last > T_WEAK).map(S => S.name));
      return;
    }
    if (st === 'joining' || st === 'lost') {
      if (hostDead) return;
      if (t0 - lastJoin > 2000) { lastJoin = t0; sendJoin(); }
      if (st === 'joining' && silent && t0 - joinSince > 10000) { giveUp('', false); return; }
      if (st === 'joining') ui();
      return;
    }
    if (st !== 'joined') return;
    if (t0 - lastHb > 1000) { lastHb = t0; sendHb(); }
    const lk = Lk('H');
    if (t0 - lastPingR > 1000) { lastPingR = t0; if (alive(lk)) xmit('H', pk('q', { ts: performance.now() }), 'fast'); }
    if (t0 - lastPingM > 2000) { lastPingM = t0; xmit('H', pk('q', { ts: performance.now() }), 'mq'); }
    if (t0 - lastKick > 5000) { lastKick = t0; rtcKick(); }
    if (t0 - lastAct > 10000) { lastAct = t0; saveAct(); }
    rtcDiag();
    weak(t0 - hostLast > T_WEAK ? ['хозяином'] : []);
    if (t0 - hostLast > T_HOST_LOST) hostGone('Хозяин пропал: связи нет больше 15 секунд');
  }
  // small non-blocking notice while some link is silent (instead of dropping the player at once)
  let weakEl = null, weakTxt = '';
  function weak(names) {
    const txt = names.length && code && st !== 'lost' ? '⚠ Связь с ' + names.join(', ') + ' прерывается — восстанавливаю…' : '';
    if (txt === weakTxt) return; weakTxt = txt;
    if (!weakEl) { weakEl = document.createElement('div'); weakEl.style.cssText = 'position:fixed;left:50%;top:calc(var(--sa-top, env(safe-area-inset-top,0px)) + 6px);transform:translateX(-50%);z-index:10000;background:rgba(20,20,26,.88);color:#ffd27a;font:600 13px/1.3 -apple-system,Roboto,sans-serif;padding:6px 12px;border-radius:999px;pointer-events:none;max-width:92vw;text-align:center;border:1px solid rgba(255,210,122,.35)'; (document.body || document.documentElement).appendChild(weakEl); }
    weakEl.textContent = txt; weakEl.style.display = txt ? 'block' : 'none';
  }
  setInterval(tick, 250);
  setInterval(bundleTick, 16);
  setInterval(() => { if (ov && !ov.hidden) ui(); }, 1000);
  // back from sleep / another app, or the network changed: check every relay socket at once (they often die silently)
  function wakeUp() { if (!code) return; checkRelays(); if (!isHost) { if (st === 'joined') { sendHb(); startRtcSoon(); } else if (st === 'joining' || st === 'lost') sendJoin(); } else bcastRoster(); }
  window.addEventListener('online', wakeUp); window.addEventListener('pageshow', (e) => { if (e.persisted) wakeUp(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && code) checkRelays(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && code) { if (!isHost) { if (st === 'joined') { sendHb(); flushState(true); } else if (st === 'joining' || st === 'lost') sendJoin(); } else bcastRoster(); } });

  // ---------- «Рядом, без интернета»: QR handshake, direct WebRTC over the same Wi-Fi / personal hotspot, no servers ----------
  // Host shows an offer QR; a new player scans it and shows an answer QR; host scans the answer -> direct link. Repeat per player.
  let near = { view: 'choose', pend: null, offerTxt: '', answerTxt: '', scan: null, err: '' };
  const b64u = {
    enc(bytes) { let x = ''; for (let i = 0; i < bytes.length; i++) x += String.fromCharCode(bytes[i]); return btoa(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const x = atob(str), b = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) b[i] = x.charCodeAt(i); return b; },
  };
  async function zip(text) {
    const raw = new TextEncoder().encode(text);
    if (typeof CompressionStream === 'undefined') return 'r' + b64u.enc(raw);
    const buf = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    return 'z' + b64u.enc(new Uint8Array(buf));
  }
  async function unzip(x) {
    const kind = x[0], bytes = b64u.dec(x.slice(1));
    if (kind === 'r') return new TextDecoder().decode(bytes);
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return new TextDecoder().decode(buf);
  }
  function slimSdp(sdp) { return sdp.split(/\r?\n/).filter(l => l && !/^a=candidate:.* tcp /i.test(l) && !/^a=extmap/.test(l) && !/^a=msid-semantic/.test(l)).join('\r\n') + '\r\n'; }
  async function packNear(kind, o) { return 'P1' + kind + (await zip(JSON.stringify(o))); }
  async function unpackNear(text) {
    text = String(text || '').trim(); const i = text.indexOf('P1'); if (i < 0) throw new Error('bad');
    text = text.slice(i).split(/\s/)[0];
    const o = JSON.parse(await unzip(text.slice(3))); if (!o || typeof o.s !== 'string') throw new Error('bad');
    o.kind = text[2]; return o;
  }
  function bindNear(lk, t) {
    // a nearby link (temporary key '~…') just delivered its first packet: from now on it belongs to guest token t
    if (L[t] && L[t] !== lk) closeLink(t);
    delete L[lk.key]; lk.key = t; L[t] = lk;
    if (near.pend === lk) near.pend = null;
    setTimeout(() => { if (nearby && isHost) nearNewOffer(); }, 300);
  }
  function hostNearby() {
    stopAll(); clearHost(); nearby = true; isHost = true; code = String(1000 + Math.floor(Math.random() * 9000)); joinSince = now(); tok = rnd(10) + rnd(6); ep = rnd(6); error = ''; silent = false;
    st = 'hosting'; room.mode = G.modes.length ? G.modes[0].id : 'default';
    room.opts = clone(typeof G.optsInit === 'function' ? G.optsInit() : (G.optsInit || {})) || {};
    const S = { tok, id: rnd(6), slot: 0, name: uniqName(myName), skin: localSkin, team: 0, online: true, last: now(), ep, ms: 0, reqSkin: '' };
    seats = [S]; seatByTok[tok] = S; me = { slot: 0, id: S.id, name: S.name, skin: S.skin, team: 0 };
    room.v = 1; syncMyRoom(); view = 'room'; near.view = 'host'; drawnQr = ''; ui();
    nearNewOffer();
  }
  async function nearNewOffer() {
    if (!nearby || !isHost || !rtcOk()) return;
    if (near.pend && near.pend.pc && near.pend.pc.connectionState === 'new' && !near.pend.answered) return;
    if (seats.filter(S => S.online).length >= (HUB ? CAP : G.max)) { near.offerTxt = ''; ui(); return; }
    const ss = session, key = '~' + rnd(6), lk = Lk(key); lk.made = now(); near.pend = lk; near.offerTxt = ''; ui();
    const pc = rtcNewPc(lk);
    rtcWire(lk, pc.createDataChannel('duo', { ordered: false, maxRetransmits: 0 }), pc);
    rtcWire(lk, pc.createDataChannel('duo-safe', { ordered: true }), pc);
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' && near.pend === lk) { near.err = 'Не получилось соединиться напрямую. Телефоны должны быть в одной сети Wi-Fi (или игрок — на точке доступа хозяина), VPN выключен. Покажите новый код.'; nearNewOffer(); } });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gatherDone(pc, 2000);
      if (ss !== session || lk.pc !== pc) return;
      near.offerTxt = await packNear('o', { g: G.game, c: code, k: key, s: slimSdp(pc.localDescription.sdp) });
    } catch (e) { near.err = 'Браузер не дал создать прямое соединение.'; }
    drawnQr = ''; ui();
  }
  async function nearHostAnswer(text) {
    let o; try { o = await unpackNear(text); } catch (e) { near.err = 'Это не код игры. Отсканируйте код-ответ с экрана игрока.'; ui(); return; }
    if (o.kind !== 'a') { near.err = 'Это код хозяина. Нужен ответ с экрана игрока.'; ui(); return; }
    const lk = L[o.k];
    if (!lk || !lk.pc || lk.answered) { near.err = 'Этот ответ к старому коду. Пусть игрок отсканирует ваш текущий код заново.'; ui(); return; }
    try { lk.answered = true; await lk.pc.setRemoteDescription({ type: 'answer', sdp: o.s }); near.err = ''; }
    catch (e) { lk.answered = false; near.err = 'Не удалось применить ответ. Пусть игрок отсканирует ваш код заново.'; ui(); return; }
    near.view = 'host'; ui();
    setTimeout(() => { if (nearby && isHost && L[o.k] === lk && !fastOpen(lk)) { near.err = 'Соединение не устанавливается. Оба телефона должны быть в одной сети Wi-Fi или игрок — на точке доступа хозяина; VPN выключите. Показываю новый код.'; if (near.pend === lk) near.pend = null; closeLink(o.k); delete L[o.k]; nearNewOffer(); } }, 15000);
  }
  async function nearGuestOffer(text) {
    let o; try { o = await unpackNear(text); } catch (e) { near.err = 'Это не код игры. Отсканируйте QR-код с экрана хозяина.'; ui(); return; }
    if (o.kind !== 'o') { near.err = 'Это код-ответ. Нужен код с экрана хозяина.'; ui(); return; }
    if (o.g && o.g !== G.game) { near.err = 'Этот код от другой игры. Откройте одну и ту же игру на всех телефонах.'; ui(); return; }
    stopAll(); nearby = true; isHost = false; code = String(o.c); tok = tokenFor(code); ep = rnd(6); error = ''; silent = false;
    st = 'joining'; joinSince = now(); lastJoin = now(); lastHb = now(); near.err = ''; near.view = 'answer'; near.answerTxt = '';
    me = { slot: -1, id: '', name: myName, skin: localSkin, team: 0 }; view = 'room'; ui();
    const ss = session, lk = Lk('H'); lk.sid = o.k; lk.made = now();
    const pc = rtcNewPc(lk); pc.ondatachannel = (e) => rtcWire(lk, e.channel, pc);
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' && lk.pc === pc) { near.err = 'Не получилось соединиться напрямую. Проверьте, что телефоны в одной сети Wi-Fi (или на точке доступа хозяина) и VPN выключен, и отсканируйте новый код хозяина.'; near.view = 'choose'; ui(); } });
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: o.s });
      await pc.setLocalDescription(await pc.createAnswer());
      await gatherDone(pc, 2000);
      if (ss !== session || lk.pc !== pc) return;
      near.answerTxt = await packNear('a', { k: o.k, s: slimSdp(pc.localDescription.sdp) });
    } catch (e) { near.err = 'Не удалось подготовить ответ. Отсканируйте код хозяина ещё раз.'; }
    drawnQr = ''; ui();
  }
  async function scanStart(onText) {
    scanStop();
    near.err = ''; near.scanning = true; ui();
    const vid = ov.querySelector(isHost && nearby ? '[data-r="hvid"]' : '[data-r="vid"]');
    try {
      await loadScript('jsqr', BASE + 'vendor/jsQR.js', () => typeof window.jsQR === 'function');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      near.scan = { stream, stop: false };
      vid.srcObject = stream; vid.setAttribute('playsinline', ''); vid.muted = true; await vid.play();
      const cv = document.createElement('canvas'), g = cv.getContext('2d', { willReadFrequently: true });
      const tickScan = () => {
        if (!near.scan || near.scan.stop) return;
        if (vid.videoWidth) {
          const k = Math.min(1, 900 / vid.videoWidth); cv.width = Math.round(vid.videoWidth * k); cv.height = Math.round(vid.videoHeight * k);
          g.drawImage(vid, 0, 0, cv.width, cv.height);
          const r = window.jsQR(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
          if (r && r.data && r.data.indexOf('P1') >= 0) { scanStop(); ui(); onText(r.data); return; }
        }
        setTimeout(tickScan, 90);
      };
      tickScan();
    } catch (e) {
      scanStop();
      near.err = 'Камера недоступна (' + (e && e.name === 'NotAllowedError' ? 'нет разрешения — разрешите камеру для этого сайта в настройках Safari' : 'ошибка') + '). Можно скопировать код и вставить его в поле ниже.';
      ui();
    }
  }
  function scanStop() { near.scanning = false; if (near.scan) { near.scan.stop = true; try { near.scan.stream.getTracks().forEach(t => t.stop()); } catch (e) {} near.scan = null; } }
  function drawBigQr(cv, text) {
    if (!cv || cv.dataset.text === text) return;
    cv.dataset.text = text;
    if (!text) { cv.hidden = true; return; }
    loadScript('qrgen', BASE + 'vendor/qrcode.js', () => typeof window.qrcode === 'function').then(() => {
      const q = window.qrcode(0, 'L'); q.addData(text, 'Byte'); q.make();
      const n = q.getModuleCount(), quiet = 4, px = Math.max(3, Math.floor(760 / (n + quiet * 2)));
      cv.width = cv.height = (n + quiet * 2) * px;
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#000';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
      cv.hidden = false;
    }).catch(() => { cv.hidden = true; });
  }
  async function copyText(text, btn, label) {
    try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { return; }
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Скопировано'; } catch (e) { btn.textContent = 'Не удалось скопировать'; }
    setTimeout(() => { btn.textContent = label; }, 2500);
  }

  // ---------- sessions ----------
  function stopAll() {
    session++; nearby = false; scanStop(); near.pend = null; near.offerTxt = ''; near.answerTxt = '';
    relays.forEach(r => r.stop()); relays = [];
    for (const k in RQ) delete RQ[k]; weak([]);
    for (const k in L) { closeLink(k); delete L[k]; }
    for (const k in OUT) delete OUT[k]; for (const k in IN) delete IN[k];
    for (const k in ST) delete ST[k]; for (const k in lastBundle) delete lastBundle[k];
    seen.clear(); seenQ.length = 0;
    seats = []; seatByTok = {}; mine = {}; clearTimeout(flushTimer); flushTimer = 0;
    room = { v: 0, mode: '', opts: {}, started: false, cfg: null, match: 0, players: [], evn: 0, ev: [] };
    me = { slot: -1, id: '', name: myName, skin: localSkin, team: 0 };
    lastEv = 0; lastMatch = 0; sawLobby = false; hostLostFired = false; hostDead = false; hostEp = ''; oldEps.clear(); diag.rtc = diag.mq = '—';
  }
  function hostCreate(o) {
    stopAll(); isHost = true; code = (o && o.code) || String(1000 + Math.floor(Math.random() * 9000)); joinSince = now(); tok = (o && o.tok) || rnd(10) + rnd(6); ep = rnd(6); error = ''; silent = false;
    st = 'hosting'; room.mode = G.modes.length ? G.modes[0].id : 'default';
    room.opts = clone(typeof G.optsInit === 'function' ? G.optsInit() : (G.optsInit || {})) || {};
    const S = { tok, id: (o && o.id) || rnd(6), slot: 0, name: uniqName(myName), skin: localSkin, team: 0, online: true, last: now(), ep, ms: 0, reqSkin: '' };
    seats = [S]; seatByTok[tok] = S; me = { slot: 0, id: S.id, name: S.name, skin: S.skin, team: 0 };
    room.v = 1; syncMyRoom(); saveHost();
    relaysStart(session); view = 'room'; drawnQr = ''; ui();
    setTimeout(() => { const ss = session; if (ss === session && st === 'hosting' && !relayUp()) { error = noRelayMsg(); ui(); } }, 8000);
  }
  function noRelayMsg() { return 'Не удаётся связаться ни с одним сервером-посредником. Возможно, их блокирует провайдер или VPN. Открой «Проверка связи» в меню игр — она покажет, что именно недоступно. Продолжаю пытаться…'; }
  function joinRoom(c, o) {
    c = String(c || '').replace(/\D/g, '').slice(0, 4);
    if (c.length !== 4) { error = 'Код — это 4 цифры'; ui(); return; }
    stopAll(); clearHost(); isHost = false; code = c; tok = (o && o.tok) || tokenFor(c); ep = rnd(6); error = ''; silent = !!(o && o.silent);
    st = 'joining'; joinSince = now(); lastJoin = now(); lastHb = now();
    me = { slot: -1, id: '', name: myName, skin: localSkin, team: 0 };
    relaysStart(session); view = 'room'; drawnQr = '';
    saveAct(); ui();
    setTimeout(() => {
      const ss = session; if (ss !== session || st !== 'joining' || silent) return;
      error = relayUp() ? 'Комната ' + code + ' пока не отвечает. Проверь код: на телефоне хозяина должен быть открыт экран комнаты с этим кодом. Продолжаю пытаться…' : noRelayMsg();
      ui();
    }, 10000);
  }
  function leave() {
    const relaysNow = relays;
    if (code) {
      if (isHost) {
        const m = JSON.stringify(pk('hostbye', {}));
        relayPub('all', m, true); relayPub('all', m, true);
        seats.forEach(S => { const lk = L[S.tok]; if (S.slot && alive(lk)) chSend(safeOpen(lk) ? lk.safe : lk.fast, m); });
      } else if (st === 'joined') xmit('H', pk('bye', {}), 'both', true);
    }
    flushRelays(true);
    relays = []; // keep the sockets open a moment so the farewell actually leaves
    setTimeout(() => relaysNow.forEach(r => r.stop()), 400);
    clearAct(); clearHost(); stopAll(); st = 'idle'; code = ''; isHost = false; error = ''; view = 'main'; silent = false; near.view = 'choose'; near.err = '';
    if (lobbyRes) { const r = lobbyRes; lobbyRes = null; r(null); }
    ui();
  }

  // ---------- host actions ----------
  function setMode(id) {
    if (!isHost || room.started || !modeInfo(id) || room.mode === id) return false;
    room.mode = id; const n = teamsN(); if (n) autoTeams(true); else seats.forEach(S => { S.team = 0; });
    bump(); return true;
  }
  function setOpts(o) { if (!isHost) return; room.opts = Object.assign({}, room.opts, o); bump(); }
  function setTeam(slot, team) { if (!isHost || room.started) return; const S = seats[slot], n = teamsN(); if (!S || !n) return; S.team = ((team % n) + n) % n; bump(); }
  function autoTeams(silentBump) { if (!isHost) return; const n = teamsN() || 2; seats.forEach((S, i) => { S.team = i % n; }); if (!silentBump) bump(); }
  // hub mode: only the players who opened this game's network mode take part (the others are in the menu or another game)
  const inMatch = (S) => S.online && (!HUB || HUB.eligible(S));
  function canStart() {
    if (!isHost || room.started) return false;
    const on = seats.filter(inMatch);
    if (on.length < G.min || (HUB && on.length > G.max)) return false;
    const n = teamsN(); if (n && !HUB && new Set(on.map(S => S.team)).size < 2) return false;   // hub: start() splits the teams itself
    return true;
  }
  function start(over) {
    over = over || {};
    if (!isHost || room.started) return false;
    seats.filter(S => !S.online).forEach(S => removeSeat(S));
    const ps = seats.filter(inMatch);
    if (ps.length < G.min || (HUB && ps.length > G.max)) return false;
    if (over.mode && modeInfo(over.mode)) room.mode = over.mode;
    if (over.opts) room.opts = Object.assign({}, room.opts, over.opts);
    const n = teamsN();
    if (HUB && n) { const tm = new Set(ps.map(S => S.team)); if (tm.size < 2) ps.forEach((S, i) => { S.team = i % n; }); }
    room.started = true; room.match++;
    const cfg = { mode: room.mode, players: ps.map(S => ({ slot: S.slot, id: S.id, name: S.name, skin: S.skin, team: n ? S.team : 0 })), seed: over.seed != null ? over.seed >>> 0 : (Math.random() * 4294967296) >>> 0, opts: clone(room.opts), match: room.match, rejoin: false };
    if (HUB) cfg.g = G.key;
    room.cfg = cfg; room.v++; syncMyRoom();
    const m = JSON.stringify(pk('start', { cfg }));
    relayPub('all', m, true);
    seats.forEach(S => { if (S.slot) { const lk = L[S.tok]; if (alive(lk)) chSend(safeOpen(lk) ? lk.safe : lk.fast, m); } });
    bcastRoster(true); [300, 900].forEach(ms => { const ss = session; setTimeout(() => { if (ss === session && isHost) bcastRoster(); }, ms); });
    lastMatch = cfg.match; hideOverlay();
    if (lobbyRes) { const r = lobbyRes; lobbyRes = null; r(clone(cfg)); }
    call('start', clone(cfg)); call('roster', room.players);
    return true;
  }
  function endMatch() {
    if (!isHost || !room.started) return;
    room.started = false; room.cfg = null; call('end');
    seats.filter(S => !S.online).forEach(S => { seats = seats.filter(x => x !== S); delete seatByTok[S.tok]; closeLink(S.tok); });
    seats.forEach((S, i) => { S.slot = i; });
    bump();
  }
  function kick(slot) { const S = seats[slot]; if (!isHost || !S || !S.slot) return; const m = pk('kicked', {}); m.to = S.tok; relayPub('all', JSON.stringify(m), true); const lk = L[S.tok]; if (alive(lk)) chSend(lk.safe || lk.fast, JSON.stringify(m)); const was = room.started; room.started = false; removeSeat(S); room.started = was; }

  // ---------- profile ----------
  function setSkin(o) {
    localSkin = o == null ? null : clone(o); me.skin = localSkin;
    if (isHost && seats[0]) { const S = seats[0]; S.reqSkin = ''; const sk = fixSkin(S, localSkin); S.skin = sk; me.skin = sk; bump(); }
    else if (st === 'joined') sendHb();
  }
  function setName(n) {
    myName = cleanName(n); lsSet('party.name', myName); me.name = myName;
    if (isHost && seats[0]) { const nm = uniqName(myName, seats[0]); if (nm !== seats[0].name) { seats[0].name = nm; bump(); } }
    else if (st === 'joined') sendHb();
  }

  // ---------- overlay ----------
  let ov = null, view = 'main', lobbyRes = null, drawnQr = '';
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
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
  function roomLink() { return location.href.split('#')[0] + '#room=' + code; }
  function drawQr(text) {
    const cv = ov && ov.querySelector('[data-r="qr"]'); if (!cv || drawnQr === text) return;
    drawnQr = text;
    loadScript('qrgen', BASE + 'vendor/qrcode.js', () => typeof window.qrcode === 'function').then(() => {
      const q = window.qrcode(0, 'L'); q.addData(text, 'Byte'); q.make();
      const n = q.getModuleCount(), quiet = 3, px = Math.max(3, Math.floor(480 / (n + quiet * 2)));
      cv.width = cv.height = (n + quiet * 2) * px;
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#000';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    }).catch(() => { cv.hidden = true; });
  }
  function skinCss(s) {
    if (G.skinColor) { try { const c = G.skinColor(s); if (c) return c; } catch (e) {} }
    if (typeof s === 'string') return s;
    if (s && typeof s === 'object') {
      for (const k of ['color', 'colour', 'c', 'fill', 'main', 'body', 'col']) if (typeof s[k] === 'string') return s[k];
      if (typeof s.hue === 'number') return 'hsl(' + s.hue + ',75%,55%)';
      if (typeof s.color === 'number') return '#' + (s.color >>> 0).toString(16).padStart(6, '0').slice(-6);
    }
    return '#8b8f9a';
  }
  const TEAM_COL = ['#4aa3ff', '#ff6b6b', '#5ed18a', '#f5c542', '#c58bff', '#ff9b45'], TEAM_LET = ['А', 'Б', 'В', 'Г', 'Д', 'Е'];
  function buildOverlay() {
    if (ov) return;
    const css = el('style', null, `
.pty-ov{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:16px;padding-top:max(16px,var(--sa-top, env(safe-area-inset-top)));padding-bottom:max(16px,var(--sa-bottom, env(safe-area-inset-bottom)));padding-left:max(16px,var(--sa-left, env(safe-area-inset-left)));padding-right:max(16px,var(--sa-right, env(safe-area-inset-right)));background:rgba(12,13,18,.97);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#f2f1ec;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;-webkit-user-select:none;user-select:none;box-sizing:border-box}
.pty-ov *{box-sizing:border-box}
.pty-ov[hidden],.pty-ov [hidden]{display:none!important}
.pty-box{width:min(460px,100%);display:flex;flex-direction:column;gap:10px;margin:auto}
.pty-h{font-size:24px;font-weight:800;text-align:center;margin:0}
.pty-sub{text-align:center;color:#b9bbc6;font-size:14px;margin:0;line-height:1.45}
.pty-code{font-size:56px;font-weight:900;letter-spacing:10px;text-align:center;color:var(--pty-accent);font-variant-numeric:tabular-nums;line-height:1.05;padding-left:10px}
.pty-btn{font:inherit;font-weight:800;font-size:17px;color:#fff;background:#262833;border:2px solid var(--pty-accent);border-radius:14px;padding:10px 16px;min-height:48px;cursor:pointer;touch-action:manipulation}
.pty-btn:disabled{opacity:.4;cursor:default}
.pty-btn.hot{background:var(--pty-accent);color:#111}
.pty-btn.ghost{background:transparent;border-color:rgba(255,255,255,.25);font-size:15px;padding:8px}
.pty-btn.sm{font-size:14px;min-height:44px;padding:6px 10px}
.pty-row{display:flex;gap:10px}.pty-row>*{flex:1;min-width:0}
.pty-in{font:inherit;font-weight:700;font-size:20px;background:#15161d;color:#fff;border:2px solid rgba(255,255,255,.28);border-radius:12px;padding:8px 12px;min-height:46px;min-width:0;width:100%;-webkit-user-select:text;user-select:text}
.pty-in.code{font-weight:900;font-size:28px;letter-spacing:8px;text-align:center;border-color:var(--pty-accent)}
.pty-lab{font-size:13px;color:#9da0ae;margin:0 0 -4px 4px}
.pty-or{display:flex;align-items:center;gap:10px;color:#868a99;font-size:13px}.pty-or::before,.pty-or::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.15)}
.pty-st{text-align:center;font-size:14px;border-radius:12px;padding:8px 12px;background:rgba(255,255,255,.07);line-height:1.4}
.pty-err{color:#ffb4a0;border:1px solid rgba(255,120,80,.5)}
.pty-diag{text-align:center;font-size:12px;color:#8e91a0;margin:0}
.pty-qr{display:block;margin:0 auto;width:min(34vh,150px);height:auto;aspect-ratio:1;border-radius:10px;background:#fff;image-rendering:pixelated}
.pty-qr.big,.pty-ov.near .pty-qr[data-r="qr"]{width:min(72vw,46vh,300px)}
.pty-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.pty-p{display:flex;align-items:center;gap:8px;min-height:46px;padding:4px 10px;border-radius:12px;background:#1d1f28;border:1px solid rgba(255,255,255,.1)}
.pty-p.me{border-color:var(--pty-accent)}
.pty-p.off{opacity:.5}
.pty-n{flex:none;width:24px;height:24px;border-radius:50%;background:#2d3040;font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center}
.pty-sk{flex:none;width:26px;height:26px;border-radius:50%;border:2px solid rgba(255,255,255,.75);box-shadow:0 0 0 1px rgba(0,0,0,.5)}
.pty-nm{flex:1;min-width:0;font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pty-q{flex:none;display:flex;flex-direction:column;align-items:flex-end;font-size:11px;color:#9da0ae;line-height:1.2}
.pty-q i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;vertical-align:middle}
.pty-tm{flex:none;width:30px;height:30px;border-radius:9px;color:#111;font-weight:900;display:flex;align-items:center;justify-content:center;font-size:15px}
.pty-modes{display:flex;gap:6px;flex-wrap:wrap}.pty-modes .pty-btn{flex:1 1 auto;font-size:14px;min-height:44px;padding:6px 10px}
.pty-modes .pty-btn.sel{background:var(--pty-accent);color:#111}
.pty-main{display:contents}
.pty-ov .pty-box.room{display:grid;grid-template-columns:1fr;gap:10px}
.pty-ov .pty-side{display:flex;flex-direction:column;gap:8px}
.pty-ov .pty-pane{display:flex;flex-direction:column;gap:8px;min-width:0}
.pty-ov .pty-foot{display:flex;flex-direction:column;gap:8px}
@media (orientation:landscape) and (max-height:520px){
.pty-ov{padding-top:max(8px,var(--sa-top, env(safe-area-inset-top)));padding-bottom:max(8px,var(--sa-bottom, env(safe-area-inset-bottom)))}
.pty-box{gap:7px;width:min(680px,100%)}
.pty-h{font-size:18px}
.pty-btn{font-size:15px;padding:6px 12px;min-height:44px}
.pty-code{font-size:38px;letter-spacing:7px;padding-left:7px}
.pty-in{font-size:18px;min-height:44px;padding:5px 10px}.pty-in.code{font-size:22px}
.pty-sub{font-size:13px}
.pty-qr{width:min(30vh,112px)}
.pty-p{min-height:44px;padding:2px 8px}
.pty-ov{align-items:stretch}
.pty-box[data-v="main"]{display:grid;grid-template-columns:1fr 1fr;column-gap:14px;align-content:center;align-items:center}
.pty-box[data-v="main"]>.pty-h,.pty-box[data-v="main"]>.pty-sub{grid-column:1/3}
.pty-ov .pty-box.room{grid-template-columns:200px minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;column-gap:14px;row-gap:6px;width:min(700px,100%);height:100%;margin:0 auto}
.pty-ov .pty-side{grid-column:1;grid-row:1;overflow-y:auto;min-height:0;justify-content:center}
.pty-ov .pty-foot{grid-column:1;grid-row:2;gap:6px}
.pty-ov .pty-pane{grid-column:2;grid-row:1/3;min-height:0}
.pty-ov .pty-list{overflow-y:auto;min-height:0;flex:1 1 auto}
}`);
    document.head.appendChild(css);
    ov = el('div', 'pty-ov'); ov.hidden = true; ov.style.setProperty('--pty-accent', G.accent);
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Игра с друзьями');
    ov.innerHTML = `
<div class="pty-box" data-v="main">
  <p class="pty-h" data-r="title"></p>
  <p class="pty-sub" data-r="sub"></p>
  <div style="display:flex;flex-direction:column;gap:10px"><p class="pty-lab">Твоё имя</p><input class="pty-in" data-r="name" maxlength="14" placeholder="Игрок" autocomplete="off" autocapitalize="words" aria-label="Имя игрока">
  <button class="pty-btn hot" data-r="new">Создать комнату</button></div>
  <div style="display:flex;flex-direction:column;gap:10px"><div class="pty-or">или войди по коду</div>
  <div class="pty-row"><input class="pty-in code" data-r="in" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="0000" aria-label="Код комнаты" autocomplete="off"><button class="pty-btn" data-r="go">Войти</button></div>
  <div class="pty-st pty-err" data-r="err0" hidden></div>
  <button class="pty-btn" data-r="nearbtn">📶 Рядом, без интернета<small style="display:block;font-weight:600;font-size:12px;opacity:.75;margin-top:2px">одна сеть Wi-Fi или точка доступа · обмен QR-кодами</small></button>
  <button class="pty-btn ghost" data-r="close">Закрыть</button></div>
</div>
<div class="pty-box" data-v="near" hidden>
  <p class="pty-h">Рядом, без интернета</p>
  <p class="pty-sub" data-r="nsub"></p>
  <video data-r="vid" playsinline muted style="width:100%;max-height:46vh;border-radius:12px;background:#000;object-fit:cover" hidden></video>
  <canvas class="pty-qr big" data-r="nqr" width="10" height="10" hidden></canvas>
  <div class="pty-st" data-r="nstat" hidden></div>
  <div class="pty-st pty-err" data-r="nerr" hidden></div>
  <button class="pty-btn hot" data-r="nhost">Я создаю комнату</button>
  <button class="pty-btn hot" data-r="nscan">📷 Сканировать код хозяина</button>
  <button class="pty-btn sm ghost" data-r="nstop" hidden>Остановить камеру</button>
  <div class="pty-row" data-r="nprow"><input class="pty-in" data-r="npaste" placeholder="…или вставьте код текстом" autocomplete="off" style="font-size:15px"><button class="pty-btn sm" data-r="npgo">OK</button></div>
  <button class="pty-btn sm" data-r="ncopy" hidden>Поделиться кодом текстом</button>
  <button class="pty-btn ghost" data-r="nback">Назад</button>
</div>
<div class="pty-box room" data-v="room" hidden>
  <div class="pty-side">
    <p class="pty-sub" data-r="rl">Код комнаты</p>
    <div class="pty-code" data-r="code">····</div>
    <canvas class="pty-qr" data-r="qr" width="10" height="10" aria-label="QR-код для входа"></canvas>
    <video data-r="hvid" playsinline muted style="width:100%;max-height:40vh;border-radius:12px;background:#000;object-fit:cover" hidden></video>
    <div class="pty-st pty-err" data-r="hnerr" hidden></div>
    <button class="pty-btn sm hot" data-r="hscan" hidden>📷 Сканировать ответ игрока</button>
    <div class="pty-row" data-r="hprow" hidden><input class="pty-in" data-r="hpaste" placeholder="…или вставьте ответ" autocomplete="off" style="font-size:14px;min-height:40px"><button class="pty-btn sm" data-r="hpgo">OK</button></div>
    <button class="pty-btn sm" data-r="share">Позвать по ссылке</button>
  </div>
  <div class="pty-pane">
    <ul class="pty-list" data-r="list"></ul>
    <div class="pty-modes" data-r="modes" hidden></div>
    <div class="pty-row" data-r="teamrow" hidden><button class="pty-btn sm ghost" data-r="auto">Разбить на команды поровну</button></div>
    <p class="pty-sub" data-r="modeinfo" hidden></p>
    <button class="pty-btn hot" data-r="start">Начать</button>
    <p class="pty-sub" data-r="wait" hidden>Ждём, когда хозяин начнёт</p>
    <div class="pty-st" data-r="hubnote" hidden></div>
    <button class="pty-btn sm" data-r="invite" hidden>Позвать</button>
    <div class="pty-st" data-r="stat" hidden></div>
    <div class="pty-st pty-err" data-r="err" hidden></div>
    <p class="pty-diag" data-r="diag" hidden></p>
  </div>
  <div class="pty-foot">
    <input class="pty-in" data-r="name2" maxlength="14" placeholder="Твоё имя" autocomplete="off" aria-label="Имя игрока" style="min-height:44px;font-size:16px">
    <button class="pty-btn" data-r="hidebtn" hidden>Готово</button>
    <button class="pty-btn ghost" data-r="leave">Выйти из комнаты</button>
  </div>
</div>`;
    document.body.appendChild(ov);
    const $ = (r) => ov.querySelector('[data-r="' + r + '"]');
    const nm = $('name'), nm2 = $('name2');
    nm.value = nm2.value = myName === 'Игрок' && !lsGet('party.name') ? '' : myName;
    [nm, nm2].forEach(inp => { inp.addEventListener('input', () => { setName(inp.value); (inp === nm ? nm2 : nm).value = inp.value; }); });
    $('new').onclick = () => { setName(nm.value); hostCreate(); };
    const go = () => { setName(nm.value); joinRoom($('in').value); };
    $('go').onclick = go;
    $('in').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('close').onclick = () => { error = ''; hideOverlay(); if (lobbyRes) { const r = lobbyRes; lobbyRes = null; r(null); } if (HUB) HUB.ctx().onClose(); };
    $('leave').onclick = () => { const c = HUB && HUB.ctx(); if (c && c.onBack) { hideOverlay(); c.onBack(); return; } leave(); hideOverlay(); };
    $('invite').onclick = () => { const c = HUB && HUB.ctx(); if (c && c.onInvite) { c.onInvite(); $('invite').dataset.t = now(); ui(); setTimeout(() => { if (ov) ui(); }, 2600); } };
    $('start').onclick = () => { if (canStart()) start(); };
    $('nearbtn').onclick = () => { error = ''; near.view = 'choose'; near.err = ''; view = 'near'; ui(); };
    $('nhost').onclick = () => { setName(nm.value); near.err = ''; hostNearby(); };
    $('nscan').onclick = () => { setName(nm.value); scanStart((t) => nearGuestOffer(t)); };
    $('nstop').onclick = () => { scanStop(); ui(); };
    $('npgo').onclick = () => { setName(nm.value); const v = $('npaste').value; $('npaste').value = ''; nearGuestOffer(v); };
    $('ncopy').onclick = () => copyText(near.answerTxt, $('ncopy'), 'Поделиться кодом текстом');
    $('nback').onclick = () => { scanStop(); if (nearby && !isHost) leave(); near.view = 'choose'; near.err = ''; view = 'main'; ui(); };
    $('hscan').onclick = () => { if (near.scanning) { scanStop(); ui(); return; } scanStart((t) => nearHostAnswer(t)); };
    $('hpgo').onclick = () => { const v = $('hpaste').value; $('hpaste').value = ''; nearHostAnswer(v); };
    $('auto').onclick = () => autoTeams();
    $('hidebtn').onclick = () => hideOverlay();
    $('share').onclick = async () => {
      if (nearby) return copyText(near.offerTxt, $('share'), 'Поделиться кодом текстом');
      const url = roomLink();
      try { if (navigator.share) { await navigator.share({ title: G.title, text: 'Заходи играть! Код комнаты ' + code, url }); return; } } catch (e) { return; }
      try { await navigator.clipboard.writeText(url); $('share').textContent = 'Ссылка скопирована'; } catch (e) { $('share').textContent = url; }
      setTimeout(() => { $('share').textContent = 'Позвать по ссылке'; }, 2500);
    };
  }
  function hideOverlay() { if (ov) ov.hidden = true; }
  let lastListKey = '';
  function ui() {
    if (!ov) return;
    const $ = (r) => ov.querySelector('[data-r="' + r + '"]');
    ov.style.setProperty('--pty-accent', G.accent);
    const inRoom = st === 'hosting' || st === 'joined' || st === 'joining' || st === 'lost';
    if (!inRoom && view !== 'near') view = 'main';
    const nearGuestPre = nearby && !isHost && st === 'joining';
    const shown = nearGuestPre || (!inRoom && view === 'near') ? 'near' : (inRoom ? 'room' : 'main');
    ov.querySelectorAll('[data-v]').forEach(b => { b.hidden = b.dataset.v !== shown; });
    ov.classList.toggle('near', nearby);
    if (shown === 'near') {
      const ans = nearGuestPre && near.answerTxt, scanning = !!near.scanning;
      $('nsub').textContent = ans ? 'Покажите этот код хозяину — пусть он нажмёт «Сканировать ответ игрока». После этого телефоны соединятся напрямую.'
        : nearGuestPre ? 'Готовлю ответ…'
        : 'Все телефоны — в одной сети Wi-Fi, или игроки подключены к точке доступа хозяина. VPN выключите. Интернет не нужен.';
      $('vid').hidden = !scanning; $('nstop').hidden = !scanning;
      drawBigQr($('nqr'), ans ? near.answerTxt : ''); if (!ans) $('nqr').hidden = true;
      $('nhost').hidden = nearGuestPre || scanning; $('nscan').hidden = nearGuestPre || scanning;
      $('nprow').hidden = nearGuestPre; $('ncopy').hidden = !ans;
      const fo = nearGuestPre && fastOpen(L.H);
      $('nstat').textContent = fo ? 'Соединились! Захожу в комнату…' : (ans ? 'Жду, пока хозяин отсканирует ответ…' : ''); $('nstat').hidden = !$('nstat').textContent;
      $('nerr').textContent = near.err; $('nerr').hidden = !near.err;
      return;
    }
    const hc = HUB ? HUB.ctx() : null;
    $('title').textContent = hc ? hc.title : G.title;
    $('sub').textContent = hc ? hc.sub : (G.min === G.max ? (G.max === 2 ? 'Игра для двоих' : 'Игра для ' + G.max + ' игроков') : 'Игра для ' + G.min + '–' + G.max + ' игроков') + ', у каждого свой телефон';
    $('err0').textContent = error; $('err0').hidden = !error || inRoom;
    if (!inRoom) return;
    $('code').textContent = nearby ? 'Рядом' : (code || '····');
    $('rl').textContent = nearby ? (isHost ? (near.offerTxt ? 'Новый игрок сканирует этот код' : (seats.filter(S => S.online).length >= (HUB ? CAP : G.max) ? 'Комната заполнена' : 'Готовлю код…')) : 'Комната рядом') : 'Код комнаты';
    if (nearby) { const q = $('qr'); if (isHost && near.offerTxt && !near.scanning) { drawBigQr(q, near.offerTxt); } else q.hidden = true; }
    else { $('qr').hidden = false; delete $('qr').dataset.text; drawQr(roomLink()); }
    $('hvid').hidden = !(nearby && isHost && near.scanning);
    $('hscan').hidden = !(nearby && isHost && (!room.started || HUB)); $('hscan').textContent = near.scanning ? 'Остановить камеру' : '📷 Сканировать ответ игрока';
    $('hprow').hidden = !(nearby && isHost && (!room.started || HUB) && !near.scanning);
    $('hnerr').textContent = nearby ? near.err : ''; $('hnerr').hidden = !(nearby && near.err);
    $('share').hidden = st === 'lost' || (nearby && !(isHost && near.offerTxt)); $('share').textContent = nearby ? 'Поделиться кодом текстом' : ($('share').textContent === 'Поделиться кодом текстом' ? 'Позвать по ссылке' : $('share').textContent);
    const players = room.players;
    const where = (p) => (HUB ? HUB.where(p) : '');
    const key = JSON.stringify([players.map(p => [p.slot, p.name, p.skin, p.team, p.online, p.via, p.ms >> 5, where(p)]), me.id, isHost, teamsN(), room.mode, st]);
    if (key !== lastListKey) {
      lastListKey = key;
      const ul = $('list'); ul.textContent = '';
      const tN = teamsN();
      players.forEach(p => {
        const li = el('li', 'pty-p' + (p.id === me.id ? ' me' : '') + (p.online ? '' : ' off'));
        li.appendChild(el('span', 'pty-n', String(p.slot + 1)));
        const sk = el('span', 'pty-sk'); sk.style.background = skinCss(p.skin); li.appendChild(sk);
        const nmEl = el('span', 'pty-nm', (p.host ? '👑 ' : '') + p.name + (p.id === me.id ? ' (ты)' : '')); li.appendChild(nmEl);
        const wh = where(p); if (wh) { const sm = el('small', null, wh); sm.style.cssText = 'display:block;font-weight:600;font-size:12px;color:#9da0ae;overflow:hidden;text-overflow:ellipsis'; nmEl.appendChild(sm); }
        if (tN) { const t = el('span', 'pty-tm', TEAM_LET[p.team] || '?'); t.style.background = TEAM_COL[p.team % TEAM_COL.length]; li.appendChild(t); }
        const q = el('span', 'pty-q');
        if (!p.online) q.textContent = 'нет связи';
        else if (p.host) q.textContent = 'хозяин';
        else { const ms = p.ms || 0, c = !ms ? '#9da0ae' : ms < 90 ? '#5ed18a' : ms < 220 ? '#f5c542' : '#ff6b6b'; const a = el('span'); const dot = el('i'); dot.style.background = c; a.appendChild(dot); a.appendChild(document.createTextNode(ms ? ms + ' мс' : '…')); q.appendChild(a); q.appendChild(el('span', null, p.via === 'rtc' ? 'напрямую' : 'через сервер')); }
        li.appendChild(q);
        if (isHost && tN && !room.started) { li.style.cursor = 'pointer'; li.onclick = () => setTeam(p.slot, p.team + 1); }
        ul.appendChild(li);
      });
    }
    // modes
    const showStart = !hc || hc.start;
    const modesEl = $('modes'), hostPick = isHost && G.modes.length > 1 && showStart;
    modesEl.hidden = !hostPick;
    if (hostPick) {
      const k2 = G.modes.map(m => m.id + (m.id === room.mode ? '*' : '')).join('|');
      if (modesEl.dataset.k !== k2) { modesEl.dataset.k = k2; modesEl.textContent = ''; G.modes.forEach(m => { const b = el('button', 'pty-btn' + (m.id === room.mode ? ' sel' : ''), m.name || m.id); b.onclick = () => setMode(m.id); modesEl.appendChild(b); }); }
    }
    const mi = modeInfo(room.mode);
    $('modeinfo').hidden = isHost || !mi || G.modes.length < 2 || !(!hc || hc.kind === 'party'); if (mi) $('modeinfo').textContent = 'Режим: ' + (mi.name || mi.id) + (teamsN() ? ' — хозяин делит на команды' : '');
    $('teamrow').hidden = !(isHost && teamsN() && showStart);
    const on = hc && hc.count != null ? hc.count : players.filter(p => p.online).length, can = isHost && canStart();
    $('start').hidden = !isHost || room.started || st === 'lost' || !showStart;
    $('start').disabled = !can;
    $('start').textContent = on < G.min && isHost ? 'Начать (нужно минимум ' + G.min + ', сейчас ' + on + ')' : (isHost && HUB && on > G.max ? 'Начать (не больше ' + G.max + ', сейчас ' + on + ')' : (isHost && !can && teamsN() ? 'Распредели игроков по командам' : 'Начать'));
    $('wait').hidden = isHost || st !== 'joined' || room.started || !!hc;
    $('hubnote').textContent = hc && hc.note || ''; $('hubnote').hidden = !(hc && hc.note);
    $('invite').hidden = !(hc && hc.invite && st !== 'joining'); if (hc && hc.invite) $('invite').textContent = now() - ($('invite').dataset.t || 0) < 2500 ? 'Позвали ✓' : hc.invite;
    const w = st === 'joining' ? 'Захожу в комнату ' + code + '…' : st === 'lost' ? (nearby ? 'Связь с хозяином потеряна. Отсканируйте новый код хозяина (кнопка «Рядом, без интернета»).' : 'Связь с хозяином потеряна. Пробую вернуться…') : (isHost && (hc ? hc.kind === 'hub' && seats.filter(S => S.online).length < 2 : on < G.min) ? (nearby ? 'Каждый игрок: «Рядом, без интернета» → «Сканировать код хозяина» (' + on + ' из ' + G.min + '–' + G.max + ')' : 'Пусть остальные введут код ' + code + ' или отсканируют QR (' + on + ' из ' + G.min + '–' + G.max + ')') : '');
    $('stat').textContent = w; $('stat').hidden = !w;
    $('err').textContent = error; $('err').hidden = !error;
    const slow = (st === 'joining' && joinSince && now() - joinSince > 8000) || (st === 'hosting' && !relayUp() && relays.length && now() - joinSince > 8000);
    $('diag').hidden = false;
    $('diag').textContent = nearby ? 'Рядом, без интернета: прямая связь по Wi-Fi / точке доступа' : 'Прямая связь: ' + diag.rtc + ' · Серверы: ' + (relays.length ? relays.map(r => r.name + (r.ok ? ' ✓' : ' ✕')).join(', ') : '—');
    $('leave').textContent = hc && hc.back ? hc.back : (isHost ? 'Закрыть комнату' : 'Выйти из комнаты');
    $('hidebtn').hidden = !(hc && hc.kind === 'hub');
  }

  // ---------- public API ----------
  function init(o) {
    o = o || {};
    G.game = String(o.game || 'game').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'game';
    if (o.title) G.title = String(o.title);
    G.min = Math.max(2, Math.min(6, o.min || 3)); G.max = Math.max(G.min, Math.min(6, o.max || 6));
    G.modes = Array.isArray(o.modes) ? o.modes.filter(m => m && m.id) : [];
    if (o.accent) G.accent = o.accent;
    G.skinFn = typeof o.skin === 'function' ? o.skin : null; G.resolveSkin = typeof o.resolveSkin === 'function' ? o.resolveSkin : null;
    G.skinColor = typeof o.skinColor === 'function' ? o.skinColor : null; G.optsInit = o.opts || null;
    G.autoResume = o.autoResume !== false;
    myName = cleanName(lsGet('party.name') || 'Игрок');
    try { localSkin = G.skinFn ? clone(G.skinFn()) : null; } catch (e) { localSkin = null; }
    me.name = myName; me.skin = localSkin;
    if (ov) ov.style.setProperty('--pty-accent', G.accent);
    const m = /[#&]room=(\d{4})/.exec(location.hash);
    if (m) { setTimeout(() => { buildOverlay(); ov.hidden = false; joinRoom(m[1]); }, 0); }
    else if (G.autoResume) setTimeout(resume, 0);
  }
  function resume() {
    if (code) return false;
    let h = null; try { h = JSON.parse(ssGet('party.host.' + G.game) || lsGet('party.host.' + G.game) || 'null'); } catch (e) {}
    if (h && h.code && h.tok && now() - h.t < 2 * 3600 * 1000) { hostCreate(h); return true; }
    clearHost();
    let r = null; try { r = JSON.parse(ssGet('party.act.' + G.game) || lsGet('party.act.' + G.game) || 'null'); } catch (e) {}
    if (!r || !r.code || !r.tok || now() - r.t > 4 * 3600 * 1000) { clearAct(); return false; }
    joinRoom(r.code, { tok: r.tok, silent: true }); return true;
  }
  function lobby() {
    buildOverlay(); ov.hidden = false; ui();
    if (silent && st === 'joining') silent = false;
    return new Promise((res) => { if (lobbyRes) lobbyRes(null); lobbyRes = res; });
  }
  // ---------- hub mode (start page): one room for all games ----------
  // hubContext: the game that is open on this phone now (its title, player limits, modes, skins); null = the menu.
  // Topics stay 'hub' (G.game) so the connection never changes; G.key names the game for matches (cfg.g).
  function hubContext(o) {
    o = o || {};
    G.key = String(o.game || ''); G.title = o.title || 'Игра по сети';
    G.min = Math.max(2, Math.min(6, o.min || 2)); G.max = Math.max(G.min, Math.min(6, o.max || 6));
    G.modes = Array.isArray(o.modes) ? o.modes.filter(m => m && m.id) : [];
    if (o.accent) G.accent = o.accent;
    G.skinFn = typeof o.skin === 'function' ? o.skin : null; G.resolveSkin = typeof o.resolveSkin === 'function' ? o.resolveSkin : null;
    G.skinColor = typeof o.skinColor === 'function' ? o.skinColor : null; G.optsInit = o.opts || null;
    if (isHost && code && !room.started) {
      room.mode = G.modes.length ? G.modes[0].id : 'default';
      try { room.opts = clone(typeof G.optsInit === 'function' ? G.optsInit() : (G.optsInit || {})) || {}; } catch (e) { room.opts = {}; }
      const n = teamsN(); seats.forEach((S, i) => { S.team = n ? i % n : 0; });
      seats.forEach(S => { let w = null; try { w = JSON.parse(S.reqSkin || 'null'); } catch (e) {} S.skin = fixSkin(S, w); });   // skins are per game
      bump();
    }
    if (ov) ui();
  }
  function pingOf(slot) {
    if (slot == null) slot = 0;
    const p = room.players.find(x => x.slot === slot);
    if (!p || slot === me.slot) return null;
    if (isHost) return p.online ? { via: p.via === 'rtc' ? 'напрямую' : 'через сервер', ms: p.ms } : null;
    const lk = Lk('H'), al = alive(lk), own = Math.round((al ? lk.rtt.rtc : lk.rtt.mq) || 0);
    if (slot === 0) return own || st === 'joined' ? { via: al ? 'напрямую' : 'через сервер', ms: own } : null;
    return p.online ? { via: al && p.via === 'rtc' ? 'напрямую' : 'через сервер', ms: own + p.ms } : null;
  }
  window.Party = {
    init, lobby, resume, on, off, leave: () => leave(), start, end: endMatch,
    hubSetup(h) { HUB = h; G.key = ''; }, hubContext, ui: () => { if (ov && !ov.hidden) ui(); }, hide: hideOverlay, shown: () => !!(ov && !ov.hidden),
    hubSt: () => st, sess: () => session, tok: () => tok,
    send(type, data, toSlot) {
      if (!code || (st !== 'joined' && st !== 'hosting') || typeof type !== 'string') return false;
      if (isHost) {
        let n = 0;
        seats.forEach(S => { if (S.slot && S.online && (toSlot == null || toSlot === S.slot)) { sendRel(S.tok, type, data, 0); n++; } });
        return n > 0;
      }
      if (toSlot === me.slot) return false;
      sendRel('H', type, data, null, toSlot == null ? null : toSlot);
      return true;
    },
    set(patch) {
      if (patch && typeof patch === 'object') for (const k in patch) { if (patch[k] === null || patch[k] === undefined) delete mine[k]; else mine[k] = patch[k]; }
      mine = { ...mine }; if (st === 'joined' || st === 'hosting') scheduleFlush();
    },
    mine() { return mine; },
    state(slot) { if (slot === me.slot) return mine; const r = ST[slot]; return r && r.latest ? r.latest : null; },
    sample(slot, o) { if (slot === me.slot) return { ...mine }; const r = ST[slot]; return r ? sampleRec(r, o) : null; },
    delay(slot) { const r = ST[slot]; return r ? renderDelay(r) : 0; },
    setSkin, setName, setMode, setOpts, setTeam, autoTeams, kick, canStart,
    ping: pingOf,
    direct(slot) { const p = pingOf(slot); return !!(p && p.via === 'напрямую'); },
    link() { return code ? roomLink() : ''; },
    get me() { return me; }, get players() { return room.players; }, get isHost() { return isHost; },
    get code() { return code; }, get mode() { return room.mode; }, get started() { return room.started; }, get cfg() { return room.cfg; },
    _near() { return { offer: near.offerTxt, answer: near.answerTxt, err: near.err, nearby }; },
    status() { return { nearby, state: st, code, isHost, started: room.started, slot: me.slot, mode: room.mode, players: room.players.length, hostLost: st === 'lost', hostDead, diag: { ...diag }, error, relays: relays.map(r => r.name + ':' + (r.ok ? 'ok' : '–')) }; },
  };

  // ---------- proxy for a game inside the start page: same API, the work is done by hub.js in the page ----------
  // Everything crosses the frame border as JSON, so the game never holds objects of the page (and vice versa).
  function partyProxy(port) {
    const H = {};
    const call = (m, ...a) => { let r; try { r = port.p(m, JSON.stringify(a)); } catch (e) { console.error(e); return undefined; } return typeof r === 'string' ? JSON.parse(r) : r; };
    let snap = null, sv = -1, lobbyRes = null, mine2 = {};
    const S = () => { const v = port.pv(); if (v !== sv || !snap) { snap = call('snap') || {}; sv = v; } return snap; };
    port.listen('p', (ev, js) => {
      const a = js ? JSON.parse(js) : [];
      if (ev === 'lobby') { const r = lobbyRes; lobbyRes = null; if (r) r(a[0] || null); return; }
      (H[ev] || []).slice().forEach(f => { try { f(...a); } catch (e) { console.error(e); } });
    });
    const P = {
      init(o) { o = o || {}; const fns = {}, c = {}; for (const k in o) { if (typeof o[k] === 'function') fns[k] = o[k]; else c[k] = o[k]; } port.pInit(JSON.stringify(c), fns); },
      lobby() { return new Promise((res) => { if (lobbyRes) lobbyRes(null); lobbyRes = res; call('lobby'); }); },
      resume() { return false; },
      on(k, f) { (H[k] = H[k] || []).push(f); }, off(k, f) { H[k] = (H[k] || []).filter(x => x !== f); },
      leave() { mine2 = {}; call('leave'); }, start(o) { return !!call('start', o || {}); }, end() { call('end'); },
      send(type, data, toSlot) { return !!call('send', type, data === undefined ? null : data, toSlot == null ? null : toSlot); },
      set(patch) {
        if (patch && typeof patch === 'object') for (const k in patch) { if (patch[k] === null || patch[k] === undefined) delete mine2[k]; else mine2[k] = patch[k]; }
        mine2 = { ...mine2 }; call('set', patch || {});
      },
      mine() { return mine2; },
      state(slot) { return call('state', slot); }, sample(slot, o) { return call('sample', slot, o || {}); }, delay(slot) { return call('delay', slot) || 0; },
      setSkin(o) { call('setSkin', o == null ? null : o); }, setName(n) { call('setName', n); }, setMode(id) { return !!call('setMode', id); }, setOpts(o) { call('setOpts', o || {}); },
      setTeam(slot, team) { call('setTeam', slot, team); }, autoTeams() { call('autoTeams'); }, kick(slot) { call('kick', slot); }, canStart() { return !!call('canStart'); },
      ping(slot) { return call('ping', slot == null ? null : slot); }, direct(slot) { return !!call('direct', slot == null ? null : slot); }, link() { return call('link') || ''; },
      get me() { return S().me; }, get players() { return S().players || []; }, get isHost() { return !!S().isHost; },
      get code() { return S().code || ''; }, get mode() { return S().mode; }, get started() { return !!S().started; }, get cfg() { return S().cfg || null; },
      _near() { return call('near'); }, status() { return call('status') || {}; },
    };
    return P;
  }
})();
