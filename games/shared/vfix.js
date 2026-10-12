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
