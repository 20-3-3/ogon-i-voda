// ===== Progress save / load for all games at once =====
// All games live on one site (one origin), so their progress is in the same localStorage.
// "Save" packs every key into a short code and a link (…/games/#save=CODE). Opening that link in another
// browser or on another phone (or scanning its QR with the camera) offers to load the progress there.
// Before loading, the current progress on this device is kept as a backup that can be restored.
(function () {
  const BACKUP = 'save.backup', SKIP = new Set([BACKUP]);
  const $ = (s) => document.querySelector(s);
  const b64u = {
    enc(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const s = atob(str), a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; },
  };
  async function pipe(bytes, Stream, mode) {
    const cs = new Stream(mode); const w = cs.writable.getWriter(); w.write(bytes); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  async function pack(obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    if (window.CompressionStream) { try { return 'z' + b64u.enc(await pipe(raw, CompressionStream, 'deflate-raw')); } catch (e) {} }
    return 'j' + b64u.enc(raw);
  }
  async function unpack(code) {
    code = String(code || '').trim();
    const m = /#save=([A-Za-z0-9_-]+)/.exec(code); if (m) code = m[1];
    code = code.replace(/[^A-Za-z0-9_-]/g, '');
    if (code.length < 4) throw new Error('short');
    let bytes = b64u.dec(code.slice(1));
    if (code[0] === 'z') { if (!window.DecompressionStream) throw new Error('old'); bytes = await pipe(bytes, DecompressionStream, 'deflate-raw'); }
    else if (code[0] !== 'j') throw new Error('fmt');
    const o = JSON.parse(new TextDecoder().decode(bytes));
    if (!o || o.v !== 1 || typeof o.d !== 'object') throw new Error('fmt');
    return o;
  }
  function collect() {
    const d = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!SKIP.has(k)) d[k] = localStorage.getItem(k); } } catch (e) {}
    return { v: 1, t: Date.now(), d };
  }
  const GAMES = [['fw.', 'Огонь и Вода'], ['morskoy', 'Морской бой'], ['zabeg', 'Призрачный забег'], ['artiller', 'Артиллерия'], ['risuy', 'Рисуй-угадай']];
  function gamesIn(d) {
    const ks = Object.keys(d).join('\n').toLowerCase();
    const names = GAMES.filter(([p]) => ks.includes(p)).map(([, n]) => n);
    return names.length ? names.join(', ') : 'данные игр';
  }
  function fmtDate(t) { try { return new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function apply(o) {
    const cur = collect();
    try { localStorage.setItem(BACKUP, JSON.stringify(cur)); } catch (e) {}
    let n = 0;
    for (const k in o.d) { try { localStorage.setItem(k, o.d[k]); n++; } catch (e) {} }
    return n;
  }
  function loadQR() {
    if (window.qrcode) return Promise.resolve();
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'shared/vendor/qrcode.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  function drawQR(canvas, text) {
    const q = window.qrcode(0, 'L'); q.addData(text, 'Byte'); q.make();
    const n = q.getModuleCount(), px = Math.max(3, Math.floor(600 / (n + 8))), size = (n + 8) * px;
    canvas.width = canvas.height = size; const c = canvas.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, size, size); c.fillStyle = '#000';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) c.fillRect((x + 4) * px, (y + 4) * px, px, px);
  }
  function link(code) { return location.origin + location.pathname.replace(/[^/]*$/, '') + '#save=' + code; }
  function toast(msg) { const t = $('#svToast'); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 2600); }
  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch (e) { const ta = $('#svOut'); ta.hidden = false; ta.value = text; ta.focus(); ta.select(); toast('Выдели и скопируй текст вручную'); }
  }
  function show(id) { ['svMain', 'svSaved', 'svLoad', 'svAsk'].forEach(x => { $('#' + x).hidden = x !== id; }); }

  async function onSave() {
    const o = collect();
    if (!Object.keys(o.d).length) { toast('На этом устройстве пока нет прогресса'); return; }
    const code = await pack(o), url = link(code);
    $('#svInfo').textContent = 'Сохранено: ' + gamesIn(o.d) + '.';
    $('#svShare').onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title: 'Прогресс в играх на двоих', text: 'Открой ссылку, чтобы загрузить прогресс', url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
      copy(url, 'Ссылка скопирована');
    };
    $('#svCopy').onclick = () => copy(url, 'Ссылка скопирована');
    const qr = $('#svQR'); qr.hidden = true; $('#svQRnote').hidden = true;
    if (url.length <= 2300) { loadQR().then(() => { drawQR(qr, url); qr.hidden = false; }).catch(() => {}); }
    else $('#svQRnote').hidden = false;
    show('svSaved');
  }
  async function ask(code) {
    let o;
    try { o = await unpack(code); } catch (e) { toast(e && e.message === 'old' ? 'Обнови iOS: этот браузер не умеет распаковывать сохранение' : 'Это не похоже на код сохранения'); show('svMain'); return; }
    $('#svAskInfo').textContent = 'Сохранение от ' + fmtDate(o.t) + ': ' + gamesIn(o.d) + '. Прогресс на этом устройстве будет заменён (его копия сохранится, и загрузку можно будет отменить).';
    $('#svYes').onclick = () => { const n = apply(o); try { history.replaceState(null, '', location.pathname); } catch (e) {} show('svMain'); refreshUndo(); toast(n ? 'Прогресс загружен' : 'Не удалось записать прогресс'); };
    $('#svNo').onclick = () => { try { history.replaceState(null, '', location.pathname); } catch (e) {} show('svMain'); };
    show('svAsk');
    document.getElementById('save').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function refreshUndo() { let has = false; try { has = !!localStorage.getItem(BACKUP); } catch (e) {} $('#svUndo').hidden = !has; }
  function init() {
    $('#svSave').onclick = onSave;
    $('#svLoadBtn').onclick = () => { $('#svIn').value = ''; show('svLoad'); setTimeout(() => $('#svIn').focus(), 50); };
    $('#svLoadGo').onclick = () => ask($('#svIn').value);
    document.querySelectorAll('[data-sv-back]').forEach(b => { b.onclick = () => show('svMain'); });
    $('#svUndo').onclick = () => {
      let b; try { b = JSON.parse(localStorage.getItem(BACKUP)); } catch (e) {}
      if (!b || !b.d) return;
      try { const keep = new Set(Object.keys(b.d)); for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (!keep.has(k) && k !== BACKUP) localStorage.removeItem(k); } } catch (e) {}
      for (const k in b.d) { try { localStorage.setItem(k, b.d[k]); } catch (e) {} }
      try { localStorage.removeItem(BACKUP); } catch (e) {}
      refreshUndo(); toast('Вернул прогресс, который был до загрузки');
    };
    refreshUndo();
    const m = /^#save=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (m) ask(m[1]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.SaveAll = { pack, unpack, collect };
})();
