/* =====================================================================
   FocusGuard — js/clock.js
   Real-world digital clock (time + date), shown in the top-right corner.

   This module is deliberately independent from js/timer.js. It never reads
   or writes Pomodoro state, and the Pomodoro timer never reads it. It only
   renders `new Date()`.

   ---- DOM contract ----------------------------------------------------
     [data-clock-time]   "08:31:47 PM"
     [data-clock-date]   "Fri, 23 Oct 2026"

   Several elements can carry the same attribute (the topbar and Focus
   Mode both show the clock).

   Console:
     FocusGuardClock.render()
     FocusGuardClock.start()
     FocusGuardClock.stop()
   ===================================================================== */

(function (global) {
  'use strict';

  var TIME_FORMAT = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  };

  var DATE_FORMAT = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  };

  var intervalId = null;
  var alignmentId = null;

  /** Format helpers are exported so the UI can reuse them if it ever needs to. */
  function formatTime(date) {
    return date.toLocaleTimeString([], TIME_FORMAT);
  }

  function formatDate(date) {
    return date.toLocaleDateString([], DATE_FORMAT);
  }

  function writeAll(selector, text) {
    document.querySelectorAll(selector).forEach(function (el) {
      el.textContent = text;
    });
  }

  /** Redraw every clock on the page from the current wall-clock time. */
  function render() {
    var now = new Date();
    writeAll('[data-clock-time]', formatTime(now));
    writeAll('[data-clock-date]', formatDate(now));
  }

  /**
   * Start ticking on real second boundaries, so the digits change exactly
   * when the second changes instead of drifting by up to 1s per cycle.
   */
  function start() {
    stop();
    render();

    // Wait for the next whole second, then settle onto a 1s interval.
    alignmentId = global.setTimeout(function () {
      alignmentId = null;
      render();
      intervalId = global.setInterval(render, 1000);
    }, 1000 - (Date.now() % 1000));
  }

  function stop() {
    if (intervalId !== null) {
      global.clearInterval(intervalId);
      intervalId = null;
    }
    if (alignmentId !== null) {
      global.clearTimeout(alignmentId);
      alignmentId = null;
    }
  }

  function init() {
    start();

    // Background tabs throttle intervals — redraw as soon as we come back.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        stop();
        start();
      }
    });
  }

  global.FocusGuardClock = {
    start: start,
    stop: stop,
    render: render,
    formatTime: formatTime,
    formatDate: formatDate,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
