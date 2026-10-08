/* =====================================================================
   FocusGuard — js/miniWindow.js
   Prompt 10.5: the Mini Focus Window.

   A small, always-on-top monitor you can keep in a corner while you study
   away from the main screen. It shows the clock, the countdown, the camera
   preview and the live focus status.

   ---- Two ways to host it --------------------------------------------
     1. Document Picture-in-Picture (Chrome/Edge 116+). We ask the browser
        for a real floating window with documentPictureInPicture.requestWindow().
     2. Fallback: an in-page draggable panel. Used automatically when
        documentPictureInPicture is unavailable or the request is rejected
        (Firefox, Safari, unsupported gestures…). Same content, same data.

   ---- The two hard rules (Part 10.5) ---------------------------------
     * NO second camera stream — the <video> is bound to the SAME
       MediaStream object that js/camera.js already captured
       (camera.getStream()). We never call getUserMedia again.
     * NO second timer — the countdown is read from the one Pomodoro
       instance (FocusGuard.timer.getState()). This module only *displays*
       state; it owns no time source. Its refresh interval is a plain UI
       repaint (~4 fps), not a timer.

   ---- DOM contract ----------------------------------------------------
     [data-mini-open]          button that opens the window
     [data-mini-close]         button that closes it (inside the panel)
     [data-mini-video]         the preview <video> (bound to the shared stream)
     [data-mini-clock]         wall clock
     [data-mini-timer]         countdown, MM:SS
     [data-mini-period]        "Focus" / "Short break" / …
     [data-mini-focus]         live attention status label
     [data-mini-score]         Focus Score
     [data-mini-coins]         Focus Coins

   Console:
     FocusGuard.miniWindow.open() / close() / isOpen()
     FocusGuard.miniWindow.isPipSupported()
   ===================================================================== */

(function (global) {
  'use strict';

  var REFRESH_MS = 260;

  var instance = null;   // { mode, win, root, doc, interval, drag }
  var opens = 0;         // how many times a window was requested this page

  /* ---------- Small helpers ---------------------------------------- */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
  }

  function firstIn(root, selector) {
    return root ? root.querySelector(selector) : null;
  }

  function formatClock(ms) {
    var timer = global.FocusGuardTimer;
    if (timer && typeof timer.formatClock === 'function') return timer.formatClock(ms);
    var total = Math.max(0, Math.round((ms || 0) / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function formatTime(date) {
    var clock = global.FocusGuardClock;
    if (clock && typeof clock.formatTime === 'function') return clock.formatTime(date);
    return date.toLocaleTimeString();
  }

  /* ---------- The panel markup -------------------------------------- */

  function panelMarkup() {
    return [
      '<div class="mini-win" data-mini-root>',
      '  <div class="mini-win__bar" data-mini-drag>',
      '    <span class="mini-win__title">Mini Focus</span>',
      '    <button class="mini-win__close" type="button" data-mini-close',
      '            aria-label="Close mini window">×</button>',
      '  </div>',
      '  <div class="mini-win__body">',
      '    <div class="mini-win__clock" data-mini-clock>--:--:--</div>',
      '    <div class="mini-win__timer" data-mini-timer>25:00</div>',
      '    <div class="mini-win__period" data-mini-period>Focus</div>',
      '    <div class="mini-win__cam">',
      '      <video class="mini-win__video" data-mini-video autoplay playsinline muted></video>',
      '      <span class="mini-win__cam-off" data-mini-cam-off>Camera off</span>',
      '    </div>',
      '    <div class="mini-win__status">',
      '      <span class="mini-win__status-main" data-mini-focus>Detection unavailable</span>',
      '      <span class="mini-win__chip">Score <strong data-mini-score>—</strong></span>',
      '      <span class="mini-win__chip">Coins <strong data-mini-coins>0</strong></span>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('\n');
  }

  /** Self-contained styles for the Picture-in-Picture document. */
  function pipStyles() {
    return [
      ':root{color-scheme:dark}',
      '*{box-sizing:border-box}',
      'html,body{margin:0;height:100%;font-family:system-ui,Segoe UI,sans-serif;',
      '  background:#180608;color:#f6e9ea}',
      '.mini-win{height:100%;display:flex;flex-direction:column}',
      '.mini-win__bar{display:flex;align-items:center;justify-content:space-between;',
      '  padding:6px 10px;background:#2a0d11;font-size:12px;letter-spacing:.04em;',
      '  text-transform:uppercase;color:#efb9bf}',
      '.mini-win__close{border:0;background:transparent;color:#f6e9ea;font-size:16px;',
      '  cursor:pointer;line-height:1}',
      '.mini-win__body{padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.mini-win__clock{font-variant-numeric:tabular-nums;font-size:13px;opacity:.8}',
      '.mini-win__timer{font-variant-numeric:tabular-nums;font-size:34px;font-weight:700;',
      '  letter-spacing:.02em;line-height:1}',
      '.mini-win__period{font-size:12px;opacity:.75}',
      '.mini-win__cam{position:relative;aspect-ratio:16/9;border-radius:8px;overflow:hidden;',
      '  background:#000}',
      '.mini-win__video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}',
      '.mini-win__cam-off{position:absolute;inset:0;display:flex;align-items:center;',
      '  justify-content:center;font-size:12px;color:#efb9bf;background:rgba(0,0,0,.5)}',
      '.mini-win__status{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px}',
      '.mini-win__status-main{flex:1 1 100%;font-weight:600;color:#ffd9dd}',
      '.mini-win__chip{background:#2a0d11;border-radius:999px;padding:2px 8px}',
    ].join('\n');
  }

  /* ---------- Rendering --------------------------------------------- */

  function render() {
    if (!instance || !instance.root) return;
    var root = instance.root;

    var clockEl = firstIn(root, '[data-mini-clock]');
    if (clockEl) clockEl.textContent = formatTime(new Date());

    var timer = module('timer');
    if (timer && typeof timer.getState === 'function') {
      var t = timer.getState();
      var timerEl = firstIn(root, '[data-mini-timer]');
      if (timerEl) timerEl.textContent = formatClock(t.remainingMs);
      var periodEl = firstIn(root, '[data-mini-period]');
      if (periodEl) {
        var MODE_LABELS = { focus: 'Focus', shortBreak: 'Short break', longBreak: 'Long break' };
        periodEl.textContent = (MODE_LABELS[t.mode] || 'Focus') +
          (t.phase === 'running' ? ' · running' : t.phase === 'paused' ? ' · paused' : ' · idle');
      }
    }

    syncVideo(root);

    var distraction = module('distraction');
    if (distraction && typeof distraction.getState === 'function') {
      var statusEl = firstIn(root, '[data-mini-focus]');
      if (statusEl) statusEl.textContent = distraction.getState().label;
    }

    var engine = module('focusEngine');
    if (engine && typeof engine.getState === 'function') {
      var e = engine.getState();
      var scoreEl = firstIn(root, '[data-mini-score]');
      if (scoreEl) {
        scoreEl.textContent = (e.focusScore === null || e.focusScore === undefined)
          ? '—' : Math.round(e.focusScore) + '%';
      }
      var coinsEl = firstIn(root, '[data-mini-coins]');
      if (coinsEl) coinsEl.textContent = String(e.availableCoins || 0);
    }
  }

  /** Bind the shared camera stream to the mini <video> (never a new one). */
  function syncVideo(root) {
    var video = firstIn(root, '[data-mini-video]');
    if (!video) return;

    var camera = module('camera');
    var live = camera && (camera.getState().state === 'active');
    var stream = camera && typeof camera.getStream === 'function' ? camera.getStream() : null;

    var off = firstIn(root, '[data-mini-cam-off]');
    if (live && stream) {
      if (video.srcObject !== stream) {
        video.srcObject = stream;      // the SAME stream object — no new capture
        var attempt = video.play();
        if (attempt && typeof attempt.catch === 'function') attempt.catch(function () {});
      }
      if (off) off.hidden = true;
      video.hidden = false;
    } else {
      if (video.srcObject) video.srcObject = null;
      if (off) off.hidden = false;
      video.hidden = true;
    }
  }

  /* ---------- Dragging (fallback panel) ----------------------------- */

  function makeDraggable(root) {
    var bar = firstIn(root, '[data-mini-drag]');
    if (!bar) return null;

    var dragging = false;
    var offsetX = 0;
    var offsetY = 0;

    function onDown(event) {
      // Ignore the close button.
      if (event.target && event.target.closest && event.target.closest('[data-mini-close]')) return;
      var rect = root.getBoundingClientRect();
      dragging = true;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      root.classList.add('is-dragging');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      event.preventDefault();
    }

    function onMove(event) {
      if (!dragging) return;
      var left = Math.max(4, Math.min(global.innerWidth - root.offsetWidth - 4,
        event.clientX - offsetX));
      var top = Math.max(4, Math.min(global.innerHeight - root.offsetHeight - 4,
        event.clientY - offsetY));
      root.style.left = left + 'px';
      root.style.top = top + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }

    function onUp() {
      dragging = false;
      root.classList.remove('is-dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }

    bar.addEventListener('pointerdown', onDown);
    return function detach() { bar.removeEventListener('pointerdown', onDown); onUp(); };
  }

  /* ---------- Open / close ------------------------------------------ */

  function isPipSupported() {
    return !!(global.documentPictureInPicture &&
      typeof global.documentPictureInPicture.requestWindow === 'function');
  }

  function open(options) {
    if (instance) {
      if (instance.win && typeof instance.win.focus === 'function') instance.win.focus();
      return instance.mode;
    }
    opens += 1;

    var size = { width: (options && options.width) || 300, height: (options && options.height) || 360 };

    if (isPipSupported() && !(options && options.forceInline)) {
      return startPip(size);
    }
    return Promise.resolve(startInline());
  }

  function startPip(size) {
    var request;
    try {
      request = global.documentPictureInPicture.requestWindow(size);
    } catch (error) {
      return Promise.resolve(startInline());   // not a gesture, or blocked
    }
    return Promise.resolve(request).then(function (win) {
      var doc = win.document;
      doc.documentElement.lang = 'en';
      doc.head.innerHTML = '<meta charset="utf-8">' +
        '<title>FocusGuard mini</title><style>' + pipStyles() + '</style>';
      doc.body.innerHTML = panelMarkup();

      var root = doc.body.querySelector('[data-mini-root]');
      wireClose(root, doc);

      instance = {
        mode: 'pip', win: win, root: root, doc: doc,
        interval: global.setInterval(render, REFRESH_MS), drag: null,
      };

      win.addEventListener('pagehide', close);
      render();
      return 'pip';
    }).catch(function () {
      return startInline();      // the request was rejected — use the fallback
    });
  }

  function startInline() {
    var host = document.querySelector('[data-mini-host]') || document.body;
    var wrap = document.createElement('div');
    wrap.className = 'mini-win-host';
    wrap.setAttribute('data-mini-instance', '');
    wrap.innerHTML = panelMarkup();
    host.appendChild(wrap);

    var root = wrap.querySelector('[data-mini-root]');
    wireClose(root, document);
    var drag = makeDraggable(root);

    instance = {
      mode: 'inline', win: global, root: root, doc: document,
      interval: global.setInterval(render, REFRESH_MS), drag: drag,
      host: wrap,
    };
    render();
    return 'inline';
  }

  function wireClose(root, doc) {
    var closeBtn = root ? root.querySelector('[data-mini-close]') : null;
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (doc && doc !== document) {
      // Nothing else to bind in the PiP document.
    }
  }

  function close() {
    if (!instance) return false;
    if (instance.interval) global.clearInterval(instance.interval);
    if (instance.drag) instance.drag();

    if (instance.mode === 'pip' && instance.win && !instance.win.closed) {
      try { instance.win.close(); } catch (error) { /* already gone */ }
    }
    if (instance.mode === 'inline' && instance.host && instance.host.parentNode) {
      instance.host.parentNode.removeChild(instance.host);
    }
    instance = null;
    return true;
  }

  var api = {
    REFRESH_MS: REFRESH_MS,
    isImplemented: function () { return true; },
    isPipSupported: isPipSupported,
    open: open,
    close: close,
    toggle: function () { return instance ? close() : open(); },
    isOpen: function () { return instance !== null; },
    getMode: function () { return instance ? instance.mode : 'closed'; },
    getOpenCount: function () { return opens; },
    render: render,
  };

  global.FocusGuardMiniWindow = api;
  if (global.FocusGuard) global.FocusGuard.miniWindow = api;
  else global.FocusGuard = { miniWindow: api };

  function bind() {
    each('[data-mini-open]', function (el) {
      el.addEventListener('click', function () { api.toggle(); });
    });
  }

  function init() {
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
