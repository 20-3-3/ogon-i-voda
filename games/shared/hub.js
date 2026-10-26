// ===== Hub: the start page keeps ONE room for all games =====
// Players connect here once (create a room / enter a 4-digit code / «Рядом, без интернета»), 2–6 phones. Every game then
// opens inside this page in a frame, and duo.js / party.js in the frame become proxies to this room, so switching games
// never needs a new connection.
//   2-player modes (Duo API): the partner is the other room member who chose «по сети» in the same game.
//   3–6 player modes (Party API): the room creator starts a match for everybody who chose «по сети» in that game.
// Presence of every member travels in its fast Party state: $v = game open now ('' = menu), $d = game key of its Duo mode,
// $p = game key of its Party mode, $pr = (host only) Duo pairs for rooms of 3+. Game state is kept apart from it:
// Duo keys go as 'd.<key>', Party keys as 'p.<key>'. Reliable game messages are sent as '<game key>|<type>'.
(function () {
  if (window.__hub || typeof Party === 'undefined') return;
  const SCRIPT = document.currentScript && document.currentScript.src;
  const BASE = new URL('.', SCRIPT || location.href).href;      // …/games/shared/
  const SHELL = new URL('../', BASE);                             // …/games/  (this page)
  const TITLE = document.title, ACCENT = '#e2bd62';
  const GAMES = [
    { id: 'ogon-i-voda', url: '../', title: 'Огонь и Вода' },
    { id: 'morskoy-boy', url: 'morskoy-boy/', title: 'Морской бой' },
    { id: 'zabeg', url: 'zabeg/', title: 'Призрачный забег' },
    { id: 'artilleriya', url: 'artilleriya/', title: 'Артиллерия' },
    { id: 'risuy', url: 'risuy/', title: 'Рисуй-угадай' },
    { id: 'check', url: 'check.html', title: 'Проверка связи' },
  ];
  const byId = {}; GAMES.forEach((g) => { g.href = new URL(g.url, SHELL).href; byId[g.id] = g; });
  const titleOf = (v) => (byId[v] ? byId[v].title : String(v || ''));
  const $ = (id) => document.getElementById(id);
  const out = (v) => (v === undefined ? undefined : JSON.stringify(v));
  const cleanKey = (k) => String(k || '').replace(/[^a-z0-9-]/gi, '').toLowerCase();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- presence ----------
  const pres = { $v: '', $d: '', $p: '' };
  let hostPairs = {};
  const presCache = {}, presSig = {};
  function pub(patch) { Object.assign(pres, patch); Party.set(patch); }
  function prefixed(pfx, obj, clear) { const o = {}; for (const k in obj) o[pfx + k] = clear ? null : obj[k]; return o; }
  function unpfx(pfx, s) { const o = {}; if (s) for (const k in s) if (k.length > pfx.length && k.startsWith(pfx)) o[k.slice(pfx.length)] = s[k]; return o; }
  function republishAll() {
    const o = Object.assign({}, pres);
    if (o.$pr == null) delete o.$pr;
    if (C) { if (C.D.optIn) Object.assign(o, prefixed('d.', C.D.mine)); if (C.P.optIn) Object.assign(o, prefixed('p.', C.P.mine)); }
    Party.set(o);
  }
  // presence of a room member (by seat id: slots may shift when somebody drops out of the room)
  function presOf(p) {
    if (!p) return {};
    if (p.id && p.id === Party.me.id) return pres;
    const s = Party.state(p.slot);
    if (s && s.$v !== undefined) { presCache[p.id] = s; return s; }
    return presCache[p.id] || {};
  }
  const hubSt = () => Party.hubSt();
  const inRoom = () => { const s = hubSt(); return s === 'hosting' || s === 'joined'; };
  const online = () => Party.players.filter((p) => p.online !== false);

  // ---------- the game in the frame ("client"); one at a time ----------
  let C = null, ifr = null, curView = '', autoJoin = null, pendingHash = '';
  function Pre(s) { this.s = s; }
  function newClient(win, doc) {
    const c = { win, doc, view: curView, dl: null, pl: null,
      D: { key: cleanKey(curView), accent: '', optIn: false, pending: false, linked: false, pid: '', slot: -1, mine: {}, dv: 1, dpv: 1, pLatest: null, pObj: null, invT: 0, invN: 0 },
      P: { key: '', conf: null, fns: {}, optIn: false, match: 0, hostLeft: 0, mine: {}, pv: 1, snapJ: '', rosterJ: '', here: null, cache: {}, invT: 0, invN: 0 } };
    const live = () => C === c;
    c.port = {
      d: (m, js) => { if (!live()) return undefined; const v = duoCall(c, m, js ? JSON.parse(js) : []); return out(v); },
      dv: () => c.D.dv, dpv: () => c.D.dpv,
      p: (m, js) => { if (!live()) return undefined; const v = partyCall(c, m, js ? JSON.parse(js) : []); return v instanceof Pre ? v.s : out(v); },
      pv: () => c.P.pv,
      pInit: (js, fns) => { if (live()) partyInit(c, JSON.parse(js || '{}'), fns || {}); },
      listen: (k, f) => { if (k === 'd') c.dl = f; else c.pl = f; },
      home: (h) => { if (live()) goHome(h); },
      detach: () => { if (live()) dropClient(); },
    };
    return c;
  }
  // ---------- full screen: the frame covers the whole screen, the notch / home bar sizes are handed to the game ----------
  // (inside a frame the browser reports them as 0, so the games read --sa-top/right/bottom/left instead of env())
  let probe = null;
  function insets() {
    if (!probe) { probe = document.createElement('div'); probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'; document.body.appendChild(probe); }
    const cs = getComputedStyle(probe);
    return { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft };
  }
  function pushInsets(doc) {
    try { doc = doc || (ifr && ifr.contentDocument); if (!doc || !doc.documentElement) return; const s = insets(), r = doc.documentElement.style; s.top = '0px'; for (const k in s) r.setProperty('--sa-' + k, s[k]); } catch (e) {}   // the frame starts below the status bar
  }
  // iOS home-screen app installed with a translucent status bar: the page is drawn under the status bar, but innerHeight
  // (and so 100% / inset:0) is short by its height — the menu and the frame are stretched by --vfix down to the screen bottom
  function viewFix() {
    let v = 0;
    try {
      if (navigator.standalone) {
        const top = parseFloat(insets().top) || 0, land = innerWidth > innerHeight;
        const H = land ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
        if (top > 0 && H - innerHeight >= top - 2) v = Math.round(top);
      }
    } catch (e) {}
    document.documentElement.style.setProperty('--vfix', v + 'px');
  }
  viewFix();
  let insT = [];
  function insetsSoon() { insT.forEach(clearTimeout); insT = [0, 120, 400, 900].map((ms) => setTimeout(() => { viewFix(); pushInsets(); }, ms)); }
  window.addEventListener('resize', insetsSoon); window.addEventListener('orientationchange', insetsSoon);
  function attach(win) {
    if (!ifr || win !== ifr.contentWindow) return null;
    let doc; try { doc = win.document; } catch (e) { return null; }
    pushInsets(doc);
    if (C && C.doc === doc) return C.port;
    if (C) dropClient();
    C = newClient(win, doc);
    return C.port;
  }
  function dropClient() {
    const c = C; if (!c) return;
    C = null;
    endMatchFor(c.P.key);
    pub(Object.assign({ $d: '', $p: '' }, prefixed('d.', c.D.mine, true), prefixed('p.', c.P.mine, true)));
    if (ovCtx.c === c) { ovCtx = { kind: 'hub' }; Party.hide(); }
    applyContext();
  }
  // events to the game go out after the current call returns (as if they came from the network)
  const evq = []; let evqOn = false;
  function deliver(c, kind, ev, args) {
    evq.push([c, kind, ev, args === undefined ? '' : JSON.stringify(args)]);
    if (!evqOn) { evqOn = true; Promise.resolve().then(flushEv); }
  }
  function flushEv() {
    evqOn = false;
    while (evq.length) {
      const [c, kind, ev, js] = evq.shift();
      if (c !== C) continue;
      const f = kind === 'd' ? c.dl : c.pl;
      if (f) { try { f(ev, js); } catch (e) { console.error(e); } }
    }
  }
  function wrapFn(c, f) { return typeof f === 'function' ? (...a) => { if (C !== c) return null; try { const r = f(...a); return r === undefined ? null : JSON.parse(JSON.stringify(r)); } catch (e) { return null; } } : null; }
  // the room overlay shows the rules (title, limits, modes, skins) of the game that is open now
  function applyContext() {
    const c = C, conf = c && c.P.conf;
    if (conf) {
      const f = c.P.fns;
      Party.hubContext({ game: c.P.key, title: conf.title, min: conf.min, max: conf.max, modes: conf.modes, accent: conf.accent, skin: f.skin, resolveSkin: f.resolveSkin, skinColor: f.skinColor, opts: f.opts || conf.opts });
      if (f.skin) { const sk = f.skin(); Party.setSkin(sk); }
    } else {
      Party.hubContext({ game: '', title: 'Игра по сети', accent: (c && c.D.accent) || ACCENT });
      Party.setSkin(null);
    }
  }
  function endMatchFor(key) {
    // the host leaves the game in the middle of a match: it is over for everybody («хозяин вышел»)
    if (!key || !Party.isHost || !Party.started) return;
    const cfg = Party.cfg; if (!cfg || cfg.g !== key) return;
    Party.send('$hl', { g: key }); Party.end();
  }

  // ---------- Duo API for the game (2 players) ----------
  function duoCall(c, m, a) {
    const D = c.D;
    switch (m) {
      case 'init': {
        const o = a[0] || {};
        D.key = cleanKey(o.game || c.view || 'game'); if (o.accent) D.accent = o.accent;
        if (!c.P.conf) applyContext();
        if (autoJoin && autoJoin.k === 'duo' && autoJoin.v === c.view && Date.now() - autoJoin.t < 60000) { autoJoin = null; duoOptIn(c); evalDuo(c); }
        return undefined;
      }
      case 'snap': return { linked: D.linked, isHost: duoIsHost(c), code: Party.code, myId: Party.me.id || Party.tok() || '' };
      case 'partner': return duoPartnerState(c);
      case 'pair': duoPair(c); return undefined;
      case 'leave': duoLeave(c, false); return undefined;
      case 'set': {
        const patch = a[0] || {}, pp = {};
        for (const k in patch) { const v = patch[k]; if (v === null || v === undefined) { delete D.mine[k]; pp['d.' + k] = null; } else { D.mine[k] = v; pp['d.' + k] = v; } }
        if (D.optIn) Party.set(pp);
        return undefined;
      }
      case 'mine': return D.mine;
      case 'emit': if (D.linked) Party.send('$de', { g: D.key, k: a[0], v: a[1] }, D.slot); return undefined;
      case 'status': { const s = Party.status(); return { state: D.linked ? 'linked' : (inRoom() ? (Party.isHost ? 'hosting' : 'joining') : 'idle'), code: Party.code, isHost: duoIsHost(c), linked: D.linked, nearby: !!s.nearby, view: '', diag: s.diag || {}, error: '' }; }
      case 'sample': return D.linked ? duoSample(c, a[0] || {}) : null;
      case 'delay': return D.linked ? Party.delay(D.slot) : 0;
      case 'direct': return D.linked ? Party.direct(D.slot) : false;
      case 'ping': return D.linked ? Party.ping(D.slot) : null;
    }
    return undefined;
  }
  function duoIsHost(c) { return c.D.linked ? Party.me.slot < c.D.slot : !!Party.isHost; }
  function duoPartnerState(c) {
    const D = c.D; if (!D.linked) return null;
    const s = Party.state(D.slot);
    if (s && s !== D.pLatest) { D.pLatest = s; D.pObj = unpfx('d.', s); }
    return D.pObj || {};
  }
  function duoSample(c, o) {
    const lerp = (o.lerp || []).map((k) => 'd.' + k), vel = {};
    for (const k in (o.vel || {})) vel['d.' + k] = 'd.' + o.vel[k];
    const s = Party.sample(c.D.slot, { lerp, vel, maxExtrapolate: o.maxExtrapolate });
    return s ? unpfx('d.', s) : duoPartnerState(c);
  }
  function duoPartner(key) {
    const meId = Party.me.id; if (!meId || !key) return null;
    const on = online(), cands = on.filter((p) => p.id !== meId && presOf(p).$d === key);
    if (!cands.length) return null;
    const pr = Party.isHost ? hostPairs : (presOf(on.find((p) => p.host)).$pr || {});
    if (pr[meId]) return cands.find((p) => p.id === pr[meId]) || null;
    return on.length <= 2 ? cands[0] : null;
  }
  function computePairs() {
    // host: stable pairs per game among the members waiting «по сети» in a Duo mode
    const by = {}, next = {};
    online().forEach((p) => { const k = presOf(p).$d; if (k) (by[k] = by[k] || []).push(p); });
    for (const k in by) {
      const ids = by[k].sort((x, y) => x.slot - y.slot).map((p) => p.id);
      ids.forEach((id) => { const o = hostPairs[id]; if (o && ids.includes(o) && hostPairs[o] === id && !next[id] && !next[o]) { next[id] = o; next[o] = id; } });
      const free = ids.filter((id) => !next[id]);
      for (let i = 0; i + 1 < free.length; i += 2) { next[free[i]] = free[i + 1]; next[free[i + 1]] = free[i]; }
    }
    if (JSON.stringify(next) !== JSON.stringify(hostPairs)) { hostPairs = next; pub({ $pr: Object.keys(next).length ? next : null }); }
  }
  function duoOptIn(c) {
    const D = c.D; if (D.optIn) return;
    D.optIn = true; pub({ $d: D.key }); Party.set(prefixed('d.', D.mine));
    if (Party.isHost) computePairs();
  }
  function duoPair(c) {
    const D = c.D;
    D.pending = true; duoOptIn(c); evalDuo(c);
    if (D.linked) return;
    setTimeout(() => {
      if (C !== c || !D.pending || D.linked) return;
      if (inRoom()) invite(c, 'duo', false);
      showOverlay({ kind: 'duo', c });
    }, 350);
  }
  function duoLeave(c, cancel) {
    const D = c.D, wasPending = D.pending;
    D.pending = false;
    if (D.optIn) { D.optIn = false; pub({ $d: '' }); Party.set(prefixed('d.', D.mine, true)); }
    if (D.linked) { D.linked = false; D.pid = ''; D.pLatest = D.pObj = null; D.dv++; D.dpv++; deliver(c, 'd', 'loss'); }
    if (cancel && wasPending) deliver(c, 'd', 'cancel');
    if (ovCtx.c === c && ovCtx.kind === 'duo') { ovCtx = { kind: 'hub' }; Party.hide(); }
  }
  function evalDuo(c) {
    const D = c.D;
    const p = D.optIn && inRoom() ? duoPartner(D.key) : null, pid = p ? p.id : '';
    if (p) D.slot = p.slot;
    if (pid === D.pid) return;
    if (D.linked) { D.linked = false; D.pid = ''; D.pLatest = D.pObj = null; D.dv++; D.dpv++; deliver(c, 'd', 'loss'); }
    if (!p) return;
    D.linked = true; D.pid = pid; D.slot = p.slot; D.dv++; D.dpv++;
    deliver(c, 'd', 'link');
    if (D.pending) { D.pending = false; deliver(c, 'd', 'paired'); }
    deliver(c, 'd', 'state');
    if (ovCtx.kind === 'duo' && ovCtx.c === c) { ovCtx = { kind: 'hub' }; Party.hide(); }
  }

  // ---------- Party API for the game (3–6 players, and 2-player modes built on Party) ----------
  function partyInit(c, conf, fns) {
    const key = cleanKey(conf.game || c.view || 'game');
    if (c.P.key && c.P.key !== key) partyOptOut(c);
    c.P.key = key; c.P.conf = conf;
    c.P.fns = { skin: wrapFn(c, fns.skin), resolveSkin: wrapFn(c, fns.resolveSkin), skinColor: wrapFn(c, fns.skinColor), opts: wrapFn(c, fns.opts) };
    applyContext(); partySync(c);
    if (autoJoin && autoJoin.k === 'party' && autoJoin.v === c.view && Date.now() - autoJoin.t < 60000) { autoJoin = null; partyLobby(c); }
  }
  function partyCall(c, m, a) {
    const P = c.P;
    switch (m) {
      case 'snap': partySync(c); return new Pre(P.snapJ);
      case 'lobby': partyLobby(c); return undefined;
      case 'leave': partyOptOut(c); return undefined;
      case 'start': return !!(P.optIn && Party.isHost && Party.start(a[0] || {}));
      case 'end': if (Party.isHost && P.match) Party.end(); return undefined;
      case 'send': if (!P.optIn || !inRoom() || typeof a[0] !== 'string') return false; return !!Party.send(P.key + '|' + a[0], a[1], a[2] == null ? undefined : a[2]);
      case 'set': {
        const patch = a[0] || {}, pp = {};
        for (const k in patch) { const v = patch[k]; if (v === null || v === undefined) { delete P.mine[k]; pp['p.' + k] = null; } else { P.mine[k] = v; pp['p.' + k] = v; } }
        if (P.optIn) Party.set(pp);
        return undefined;
      }
      case 'mine': return P.mine;
      case 'state': {
        const slot = a[0]; if (slot === Party.me.slot) return P.mine;
        const s = Party.state(slot); if (!s) return null;
        const ch = P.cache[slot]; if (ch && ch.s === s) return ch.o;
        const o = unpfx('p.', s); P.cache[slot] = { s, o }; return o;
      }
      case 'sample': {
        const slot = a[0], o = a[1] || {}; if (slot === Party.me.slot) return Object.assign({}, P.mine);
        const lerp = (o.lerp || []).map((k) => 'p.' + k), vel = {}; for (const k in (o.vel || {})) vel['p.' + k] = 'p.' + o.vel[k];
        const s = Party.sample(slot, { lerp, vel, maxExtrapolate: o.maxExtrapolate });
        return s ? unpfx('p.', s) : null;
      }
      case 'delay': return Party.delay(a[0]);
      case 'setSkin': Party.setSkin(a[0]); return undefined;
      case 'setName': Party.setName(a[0]); return undefined;
      case 'setMode': return !!Party.setMode(a[0]);
      case 'setOpts': Party.setOpts(a[0] || {}); return undefined;
      case 'setTeam': Party.setTeam(a[0], a[1]); return undefined;
      case 'autoTeams': Party.autoTeams(); return undefined;
      case 'kick': Party.kick(a[0]); return undefined;
      case 'canStart': return !!(P.optIn && Party.canStart());
      case 'ping': return Party.ping(a[0] == null ? undefined : a[0]);
      case 'direct': return !!Party.direct(a[0] == null ? undefined : a[0]);
      case 'link': return Party.link();
      case 'status': { const s = Party.status(); return Object.assign({}, s, { state: P.optIn ? s.state : 'idle', started: !!P.match }); }
      case 'near': return Party._near();
    }
    return undefined;
  }
  function partyLobby(c) {
    const P = c.P;
    if (!P.conf) { deliver(c, 'p', 'lobby', [null]); return; }
    if (!P.optIn) { P.optIn = true; P.here = null; pub({ $p: P.key }); Party.set(prefixed('p.', P.mine)); }
    partySync(c);
    // a match of this game is running and I am in it (e.g. the game was reloaded): back into it
    const cfg = Party.cfg;
    if (Party.started && cfg && cfg.g === P.key && !P.match && (cfg.players || []).some((q) => q.id === Party.me.id)) {
      const c2 = JSON.parse(JSON.stringify(cfg)); c2.rejoin = true;
      P.match = cfg.match; partySync(c);
      deliver(c, 'p', 'lobby', [c2]); deliver(c, 'p', 'start', [c2]);
      return;
    }
    if (inRoom()) invite(c, 'party', false);
    showOverlay({ kind: 'party', c });
  }
  function partyOptOut(c) {
    const P = c.P; if (!P.optIn) return;
    P.optIn = false;
    endMatchFor(P.key);
    P.match = 0; P.hostLeft = 0;
    pub({ $p: '' }); Party.set(prefixed('p.', P.mine, true)); P.mine = {};
    if (ovCtx.c === c && ovCtx.kind === 'party') { ovCtx = { kind: 'hub' }; Party.hide(); }
    deliver(c, 'p', 'lobby', [null]);
    partySync(c);
  }
  // the players of this game: who chose «по сети» here, plus everybody of the running match (shown offline if they left)
  function partySync(c) {
    const P = c.P, meId = Party.me.id;
    const cfg = P.match ? Party.cfg : null;
    const inCfg = (id) => !!(cfg && cfg.players && cfg.players.some((q) => q.id === id));
    const here = (p) => (p.id === meId ? P.optIn : (p.online !== false && !!P.key && presOf(p).$p === P.key));
    const list = Party.code ? Party.players.filter((p) => here(p) || inCfg(p.id)).map((p) => Object.assign({}, p, { online: p.online !== false && here(p) })) : [];
    const snap = { me: Party.me, players: list, isHost: Party.isHost, code: Party.code, mode: Party.mode, started: !!P.match, cfg };
    const j = JSON.stringify(snap); if (j !== P.snapJ) { P.snapJ = j; P.pv++; }
    if (!P.optIn) { P.here = null; P.rosterJ = ''; return; }
    const now = {}; list.forEach((p) => { if (p.online && p.id !== meId) now[p.id] = p.slot; });
    if (P.here) {
      for (const id in P.here) if (!(id in now)) deliver(c, 'p', 'leave', [P.here[id]]);
      for (const id in now) if (!(id in P.here)) deliver(c, 'p', 'join', [now[id]]);
    }
    P.here = now;
    const rj = JSON.stringify(list.map((p) => [p.slot, p.id, p.name, p.skin, p.team, p.online, p.host]));
    if (rj !== P.rosterJ) { P.rosterJ = rj; deliver(c, 'p', 'roster', [list]); }
  }

  // ---------- invitations between phones ----------
  function invite(c, kind, manual) {
    const k = kind === 'duo' ? c.D : c.P, t = Date.now();
    if (!manual && t - k.invT < 8000) return;
    k.invT = t; k.invN = online().length;
    Party.send('$inv', { v: c.view, k: kind });
  }
  function reinvite(c) {
    // somebody new came into the room while this phone waits for partners: call them too
    const n = online().length;
    if (c.D.pending && !c.D.linked && n > c.D.invN) invite(c, 'duo', false);
    if (c.P.optIn && !c.P.match && ovCtx.c === c && n > c.P.invN) invite(c, 'party', false);
  }
  function onInvite(d, from) {
    if (!d || !byId[d.v]) return;
    const p = Party.players.find((q) => q.slot === from), name = p ? p.name : 'Игрок', c = C;
    if (c && c.view === d.v && ((d.k === 'duo' && c.D.optIn) || (d.k === 'party' && c.P.optIn))) return;   // already there
    const here = c && c.view === d.v;
    banner(name + (d.k === 'duo' ? ' зовёт играть вдвоём' : ' зовёт играть') + ' в «' + titleOf(d.v) + '»' + (here ? ' — выбери в игре игру по сети' : ''),
      here ? null : { label: 'Перейти', fn: () => { autoJoin = { v: d.v, k: d.k, t: Date.now() }; openGame(d.v); setTimeout(() => { if (autoJoin && autoJoin.v === d.v) banner('Выбери в игре игру по сети — комната уже подключена'); }, 3000); } });
  }
  let bannerT = 0;
  function banner(text, act) {
    const b = $('hubBanner'); if (!b) return;
    b.querySelector('.t').textContent = text;
    const go = b.querySelector('.go'); go.hidden = !act;
    if (act) { go.textContent = act.label; go.onclick = () => { b.hidden = true; act.fn(); }; }
    b.querySelector('.x').onclick = () => { b.hidden = true; };
    b.hidden = false; clearTimeout(bannerT); bannerT = setTimeout(() => { b.hidden = true; }, act ? 20000 : 6000);
  }

  // ---------- room overlay texts (party.js asks through HUB.ctx) ----------
  let ovCtx = { kind: 'hub' };
  function showOverlay(ctx) { ovCtx = ctx; Party.lobby(); Party.ui(); }
  // a game asks for network play while this phone is in no room: connecting happens on the start page only
  function toConnect() { ovCtx = { kind: 'hub' }; goHome(); setTimeout(() => { if (!curView && !inRoom()) showOverlay({ kind: 'hub' }); }, 650); }
  function subFor(min, max) { return (min === max ? (max === 2 ? 'Игра для двоих' : 'Игра для ' + max + ' игроков') : 'Игра для ' + min + '–' + max + ' игроков') + ', у каждого свой телефон. Подключиться нужно один раз — связь останется во всех играх.'; }
  function whereText(p) {
    if (p.online === false) return '';
    const pr = presOf(p), v = pr.$v, c = C;
    if (c && ovCtx.c === c) {
      if (ovCtx.kind === 'party' && c.P.key && pr.$p === c.P.key) return '✓ здесь, по сети';
      if (ovCtx.kind === 'duo' && c.D.key && pr.$d === c.D.key) return '✓ здесь, по сети';
      if (v && v === c.view) return 'в этой игре';
    }
    return v ? 'в «' + titleOf(v) + '»' : 'в меню';
  }
  function ctxInfo() {
    const k = ovCtx.kind, c = ovCtx.c;
    if (k === 'party' && c && C === c) {
      const conf = c.P.conf || {}, t = conf.title || titleOf(c.view), min = conf.min || 3, max = conf.max || 6, meId = Party.me.id;
      const ps = online(), hereN = ps.filter((p) => (p.id === meId ? c.P.optIn : presOf(p).$p === c.P.key)).length;
      const host = Party.players.find((p) => p.host), hostHere = host && (host.id === meId || presOf(host).$p === c.P.key);
      let note = '';
      if (!inRoom()) note = '';
      else if (Party.isHost) note = hereN < min ? 'По сети в этой игре: ' + hereN + ' из ' + (min === max ? min : min + '–' + max) + '. Остальным нужно открыть «' + t + '» и выбрать игру по сети — нажми «Позвать».' : (hereN > max ? 'В этом режиме не больше ' + max + ' игроков, а по сети здесь ' + hereN + '.' : '');
      else note = hostHere ? 'Ждём, когда хозяин начнёт' : 'Хозяин' + (host ? ' (' + host.name + ')' : '') + ' сейчас ' + (host ? whereText(host) : 'не на связи') + '. Начать игру может только он — позови его сюда.';
      const others = ps.some((p) => p.id !== meId && presOf(p).$p !== c.P.key);
      return { kind: 'party', title: t, sub: subFor(min, max), note, start: true, count: hereN, back: 'Назад', onBack: () => partyOptOut(c), onClose: () => partyOptOut(c), onHome: () => { partyOptOut(c); toConnect(); }, invite: inRoom() && others ? 'Позвать всех в «' + t + '»' : null, onInvite: () => invite(c, 'party', true) };
    }
    if (k === 'duo' && c && C === c) {
      const t = titleOf(c.view);
      return { kind: 'duo', title: 'Игра вдвоём · ' + t, sub: subFor(2, 2), note: inRoom() ? 'Ждём партнёра: пусть откроет «' + t + '» и выберет игру по сети.' : '', start: false, count: null, back: 'Отмена', onBack: () => duoLeave(c, true), onClose: () => duoLeave(c, true), onHome: () => { duoLeave(c, true); toConnect(); }, invite: inRoom() && online().length > 1 ? 'Позвать ещё раз' : null, onInvite: () => invite(c, 'duo', true) };
    }
    return { kind: 'hub', title: 'Игра по сети', sub: 'Подключитесь один раз здесь — связь сохранится во всех играх. От 2 до 6 телефонов.', note: inRoom() && online().length > 1 ? 'Открывайте любые игры: в игре выберите игру по сети — партнёры уже подключены.' : '', start: false, count: null, back: null, onBack: null, onClose: () => {}, invite: null };
  }

  // ---------- keeping everything in step ----------
  let syncT = 0, lastSess = -1;
  function soon() { if (!syncT) syncT = setTimeout(syncAll, 0); }
  // the screen must not go dark while this phone is in the room: a sleeping phone drops out (the host — for everybody)
  let wake = null, wakeBusy = false, wakeFail = 0;
  function keepAwake() {
    const s = hubSt(), want = s === 'hosting' || s === 'joined' || s === 'joining' || s === 'lost';
    if (!want) { if (wake) { const w = wake; wake = null; w.release().catch(() => {}); } return; }
    if (wake || wakeBusy || !navigator.wakeLock || document.visibilityState !== 'visible' || Date.now() - wakeFail < 10000) return;
    wakeBusy = true;
    navigator.wakeLock.request('screen').then((w) => {
      wakeBusy = false; wake = w; w.addEventListener('release', () => { if (wake === w) wake = null; });
    }).catch(() => { wakeBusy = false; wakeFail = Date.now(); });
  }
  function syncAll() {
    clearTimeout(syncT); syncT = 0; keepAwake();
    const ss = Party.sess();
    if (ss !== lastSess) { lastSess = ss; hostPairs = {}; for (const k in presCache) delete presCache[k]; for (const k in presSig) delete presSig[k]; pres.$pr = null; }
    if (Party.code && Party.mine().$v === undefined) republishAll();   // a new room starts with an empty state
    if (Party.isHost && inRoom()) computePairs();
    if (C) { evalDuo(C); partySync(C); if (inRoom()) reinvite(C); }
    renderCard(); Party.ui();
  }
  Party.hubSetup({
    ctx: ctxInfo,
    where: whereText,
    eligible: (S) => { const c = C; if (!c || !c.P.optIn || !c.P.key) return false; if (S.id === Party.me.id) return true; return presOf({ id: S.id, slot: S.slot }).$p === c.P.key; },
  });
  Party.on('roster', soon);
  Party.on('join', soon); Party.on('leave', soon);
  Party.on('state', (slot) => {
    const c = C;
    if (c && c.D.linked && slot === c.D.slot) { c.D.dpv++; deliver(c, 'd', 'state'); }
    const s = Party.state(slot), sig = s ? s.$v + '|' + s.$d + '|' + s.$p + '|' + (s.$pr ? JSON.stringify(s.$pr) : '') : '';
    if (sig !== presSig[slot]) { presSig[slot] = sig; soon(); }
  });
  Party.on('start', (cfg) => {
    const c = C; if (!c || !cfg) return;
    const P = c.P;
    if (cfg.g !== P.key || !P.optIn || !(cfg.players || []).some((q) => q.id === Party.me.id)) return;
    P.match = cfg.match; P.hostLeft = 0;
    if (ovCtx.c === c) { ovCtx = { kind: 'hub' }; Party.hide(); }
    partySync(c);
    deliver(c, 'p', 'lobby', [cfg]); deliver(c, 'p', 'start', [cfg]);
  });
  Party.on('end', () => {
    const c = C; if (!c || !c.P.match) return;
    const hl = c.P.hostLeft === c.P.match; c.P.match = 0; partySync(c);
    if (!hl) deliver(c, 'p', 'end');
  });
  Party.on('hostLost', () => { if (C && C.P.optIn) deliver(C, 'p', 'hostLost'); soon(); });
  Party.on('hostBack', () => { if (C && C.P.optIn) deliver(C, 'p', 'hostBack'); soon(); });
  Party.on('msg', (type, d, from) => {
    if (type === '$inv') { onInvite(d, from); return; }
    const c = C; if (!c) return;
    if (type === '$hl') { if (c.P.match && d && d.g === c.P.key) { c.P.hostLeft = c.P.match; deliver(c, 'p', 'hostLost'); } return; }
    if (type === '$de') { if (c.D.linked && d && d.g === c.D.key && from === c.D.slot) deliver(c, 'd', 'ev', [d.k, d.v]); return; }
    const i = type.indexOf('|'); if (i < 0) return;
    if (!c.P.optIn || type.slice(0, i) !== c.P.key) return;
    deliver(c, 'p', 'msg', [type.slice(i + 1), d, from]);
  });
  setInterval(syncAll, 500);

  // ---------- the frame with the game ----------
  function openGame(id, opts) {
    const g = byId[id]; if (!g) return;
    opts = opts || {};
    dropClient();
    if (ifr) { ifr.remove(); ifr = null; }
    curView = id; pub({ $v: id });
    const box = $('hubFrame');
    box.style.background = '#000';
    ifr = document.createElement('iframe');
    ifr.setAttribute('allow', 'camera; microphone; autoplay; fullscreen; clipboard-read; clipboard-write; web-share; screen-wake-lock');
    ifr.title = g.title;
    const me = ifr;
    ifr.addEventListener('load', () => {
      if (ifr !== me) return;
      pushInsets(me.contentDocument);
      try {
        const d = me.contentDocument, m = d.querySelector('meta[name=theme-color]');
        let bg = m && m.content; if (!bg) bg = getComputedStyle(d.body).backgroundColor;
        if (bg) box.style.background = bg;
        me.contentWindow.focus();
      } catch (e) {}
    });
    ifr.src = g.href;
    box.appendChild(ifr); box.hidden = false; document.body.classList.add('playing');
    // history is always [menu, game]: the back button (and «← Все игры») returns to the menu
    if (opts.push !== false) { try { if (history.state && history.state.hub) history.replaceState({ hub: id }, '', '#play=' + id); else history.pushState({ hub: id }, '', '#play=' + id); } catch (e) {} }
    document.title = g.title;
    renderCard();
  }
  function closeGame() {
    dropClient();
    if (ifr) { ifr.remove(); ifr = null; }
    curView = ''; pub({ $v: '' });
    $('hubFrame').hidden = true; document.body.classList.remove('playing'); document.title = TITLE;
    renderCard();
    if (pendingHash === '#save') { const s = $('save'); if (s) setTimeout(() => s.scrollIntoView({ block: 'start' }), 60); }
    pendingHash = '';
  }
  function goHome(hash) {
    pendingHash = hash || '';
    if (history.state && history.state.hub) {
      history.back();
      const v = curView; setTimeout(() => { if (curView && curView === v) { closeGame(); try { history.replaceState(null, '', location.pathname); } catch (e) {} } }, 500);
    } else closeGame();
  }
  window.addEventListener('popstate', (e) => {
    const id = e.state && e.state.hub;
    if (id && byId[id]) { if (id !== curView) openGame(id, { push: false }); }
    else if (curView) closeGame();
  });

  // ---------- the «Игра по сети» card in the menu ----------
  let cardHtml = '';
  function renderCard() {
    const box = $('hubNet'); if (!box) return;
    const s = hubSt(), inR = s === 'hosting' || s === 'joined' || s === 'joining' || s === 'lost';
    let h;
    if (!inR) {
      h = '<h2>🌐 Игра по сети</h2><p>Подключитесь здесь один раз — связь сохранится, когда будете переходить из игры в игру. От 2 до 6 телефонов, без регистрации.</p>'
        + '<div class="svrow"><button class="svb hot" data-a="go">Подключиться</button></div>';
    } else {
      const st0 = Party.status(), near = st0.nearby;
      const ps = Party.players.slice().sort((a, b) => a.slot - b.slot), meId = Party.me.id;
      const head = near ? '🌐 Комната рядом' : '🌐 Комната ' + esc(Party.code);
      const line = s === 'joining' ? 'Подключаюсь к комнате…' : s === 'lost' ? (st0.hostDead ? 'Хозяин закрыл комнату. Нажми «Выйти», чтобы создать свою или войти в другую.' : 'Связь с хозяином пропала — восстанавливаю…')
        : ps.length < 2 ? (Party.isHost ? 'Ждём остальных: пусть откроют эту страницу и введут код ' + esc(Party.code) + (near ? '' : ' (или отсканируют QR в окне комнаты)') + '.' : 'Захожу…')
        : 'Вы на связи. Открывайте любую игру и выбирайте в ней игру по сети.';
      let list = '';
      ps.forEach((p) => {
        const pr = presOf(p), v = pr.$v, mine = p.id === meId;
        const where = p.online === false ? 'нет связи' : v ? 'в «' + esc(titleOf(v)) + '»' : 'в меню';
        const go = !mine && p.online !== false && v && byId[v] && v !== curView ? '<button class="svb ghost hn-go" data-a="open" data-v="' + esc(v) + '">Туда</button>' : '';
        list += '<li><span class="hn-n">' + (p.host ? '👑 ' : '') + esc(p.name) + (mine ? ' (ты)' : '') + '<small>' + where + '</small></span>' + go + '</li>';
      });
      h = '<h2>' + head + '</h2><p>' + line + '</p>' + (list ? '<ul class="hn-l">' + list + '</ul>' : '')
        + '<div class="svrow"><button class="svb" data-a="show">Комната и QR-код</button><button class="svb ghost" data-a="leave">' + (Party.isHost ? 'Закрыть комнату' : 'Выйти') + '</button></div>';
    }
    if (h !== cardHtml) { cardHtml = h; box.innerHTML = h; }
  }
  function onCardClick(e) {
    const b = e.target.closest && e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'go' || a === 'show') showOverlay({ kind: 'hub' });
    else if (a === 'leave') { Party.leave(); renderCard(); }
    else if (a === 'open') openGame(b.dataset.v);
  }

  // ---------- start ----------
  window.__hub = { attach, path: SHELL.pathname, open: openGame, home: goHome, get client() { return C; }, get pres() { return pres; } };
  function boot() {
    const card = $('hubNet'); if (card) card.addEventListener('click', onCardClick);
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[data-g]'); if (!a || !byId[a.dataset.g]) return;
      e.preventDefault(); openGame(a.dataset.g);
    });
    const hs = location.hash;
    Party.init({ game: 'hub', title: 'Игра по сети', min: 2, max: 6, accent: ACCENT, autoResume: true });
    applyContext();
    const m = /[#&]play=([a-z0-9-]+)/.exec(hs);
    if (m && byId[m[1]]) {
      try { history.replaceState(null, '', location.pathname + (/[#&]save=/.test(hs) ? hs : '')); } catch (e) {}
      openGame(m[1]);
    }
    syncAll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  // offline cache for the whole site (lets the games open without internet for the «Рядом» mode)
  try { if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register(new URL('../', SHELL).href + 'sw.js', { scope: new URL('../', SHELL).href }).catch(() => {}); } catch (e) {}
})();
