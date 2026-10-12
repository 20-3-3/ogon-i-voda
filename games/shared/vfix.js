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
