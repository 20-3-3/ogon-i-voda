// Offline cache for the games site: pages open even without internet (needed for the «Рядом» mode on a hotspot).
// Same-origin files: network first (so updates arrive), cache as fallback. Other sites (fonts, libs): cache as fallback.
const CACHE = 'duo-games-v6';
const CORE = ['./', 'index.html', 'games/', 'games/index.html', 'games/shared/duo.js', 'games/shared/save.js', 'games/shared/party.js', 'games/shared/vfix.js', 'games/shared/fonts/fonts.css', 'games/shared/fonts/Nunito.woff', 'games/shared/fonts/RuslanDisplay.woff', 'games/shared/fonts/PressStart2P.woff', 'games/shared/fonts/RussoOne.woff', 'games/shared/fonts/Oswald.woff', 'games/shared/fonts/PTSansCaption-Regular.woff', 'games/shared/fonts/PTSansCaption-Bold.woff', 'games/shared/fonts/Caveat.woff', 'games/shared/fonts/RubikMonoOne.woff', 'games/shared/fonts/Rubik.woff', 'games/check.html', 'games/shared/vendor/qrcode.js', 'games/shared/vendor/jsQR.js',
  'games/morskoy-boy/', 'games/zabeg/', 'games/artilleriya/', 'games/risuy/'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (/broker|peerjs\.com|\/peerjs\/|mqtt/.test(url.href) && url.origin !== location.origin && !/unpkg\.com/.test(url.host)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([fetch(req), timeout(url.origin === location.origin ? 4000 : 6000)]);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await cache.match(new URL('./', url).href) || await cache.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
