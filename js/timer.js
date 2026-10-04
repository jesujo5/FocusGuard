/* =====================================================================
   FocusGuard — js/timer.js
   Phase 2: Pomodoro logic.

   This file contains NO DOM code, NO sound and NO storage. It is a small
   state machine you can test from the console:

     const t = new PomodoroTimer({ tickMs: 10 })
     t.on('change', console.log)
     t.start()

   Everything else (buttons, chime, settings inputs) lives in timer-ui.js.
   ===================================================================== */

(function (global) {
  'use strict';

  /* ---------- Public constants ---------- */

  /** The three periods a Pomodoro cycle can be in. */
  var MODE = {
    FOCUS: 'focus',
    SHORT_BREAK: 'shortBreak',
    LONG_BREAK: 'longBreak',
  };

  /** Where the state machine currently sits. */
  var PHASE = {
    IDLE: 'idle',       // loaded with a full duration, never started / reset
    RUNNING: 'running', // counting down
    PAUSED: 'paused',   // stopped part-way through
  };

  /** Default durations in minutes (requirement 1–3). */
  var DEFAULT_DURATIONS = {
    focus: 25,
    shortBreak: 5,
    longBreak: 15,
  };

  /** Guard rails for user-entered durations. */
  var MIN_MINUTES = 1;
  var MAX_MINUTES = 180;

  var MS_PER_MINUTE = 60 * 1000;

  /* ---------- Helpers ---------- */

  /**
   * Convert minutes to milliseconds, clamped to a sane range so a typo
   * like "0" or "-5" can never produce a broken timer.
   */
  function minutesToMs(minutes) {
    var value = Number(minutes);
    if (!isFinite(value)) value = 0;
    var clamped = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(value)));
    return clamped * MS_PER_MINUTE;
  }

  /** Turn a millisecond value into "MM:SS" (minutes may exceed 59). */
  function formatClock(ms) {
    var totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  /* ---------- The timer ---------- */

  /**
   * @param {object} [options]
   * @param {object} [options.durations]            starting durations in minutes
   * @param {number} [options.cyclesBeforeLongBreak] focus blocks before a long break
   * @param {boolean} [options.autoStartNext]        start the next period automatically
   * @param {number} [options.tickMs]                how often to redraw (ms)
   */
  function PomodoroTimer(options) {
    options = options || {};
    var durations = options.durations || {};

    this.durations = {
      focus: pick(durations.focus, DEFAULT_DURATIONS.focus),
      shortBreak: pick(durations.shortBreak, DEFAULT_DURATIONS.shortBreak),
      longBreak: pick(durations.longBreak, DEFAULT_DURATIONS.longBreak),
    };

    this.cyclesBeforeLongBreak = options.cyclesBeforeLongBreak || 4;
    this.autoStartNext = options.autoStartNext !== false;
    this.tickMs = options.tickMs || 250;

    this.mode = MODE.FOCUS;
    this.phase = PHASE.IDLE;
    this.completedPomodoros = 0;

    this.totalMs = minutesToMs(this.durations.focus);
    this.remainingMs = this.totalMs;

    // Private bookkeeping. These two are what stop a second interval from
    // ever being created (requirement 15).
    this._intervalId = null;
    this._endTime = null;

    this._handlers = { tick: [], change: [], complete: [] };
  }

  function pick(value, fallback) {
    return value === undefined || value === null ? fallback : value;
  }

  /* ---------- Events ---------- */

  /** Subscribe to 'tick', 'change' or 'complete'. Returns an unsubscribe fn. */
  PomodoroTimer.prototype.on = function (eventName, handler) {
    if (!this._handlers[eventName]) return function () {};
    this._handlers[eventName].push(handler);
    var self = this;
    return function () {
      var list = self._handlers[eventName];
      var index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    };
  };

  /**
   * Handlers are always called as handler(state, payload) so a subscriber can
   * render from the snapshot alone; only 'complete' needs the extra payload.
   */
  PomodoroTimer.prototype._emit = function (eventName, payload) {
    var state = this.getState();
    var list = this._handlers[eventName] || [];
    for (var i = 0; i < list.length; i += 1) {
      list[i](state, payload);
    }
  };

  /* ---------- Reading state ---------- */

  /** A plain snapshot the UI can render from. */
  PomodoroTimer.prototype.getState = function () {
    return {
      mode: this.mode,
      phase: this.phase,
      remainingMs: this.remainingMs,
      totalMs: this.totalMs,
      // 0 at the start of a period, 1 when it is finished.
      progress: this.totalMs > 0 ? 1 - this.remainingMs / this.totalMs : 0,
      completedPomodoros: this.completedPomodoros,
      durations: {
        focus: this.durations.focus,
        shortBreak: this.durations.shortBreak,
        longBreak: this.durations.longBreak,
      },
      autoStartNext: this.autoStartNext,
    };
  };

  PomodoroTimer.prototype.getDurationMinutes = function (mode) {
    return this.durations[mode];
  };

  /* ---------- The countdown clock ---------- */

  /**
   * Start the one and only interval. If an interval is already running this
   * is a no-op, which is what keeps two countdowns from ticking at once.
   */
  PomodoroTimer.prototype._startTicking = function () {
    if (this._intervalId !== null) return;
    var self = this;
    this._intervalId = global.setInterval(function () {
      self._sync();
    }, this.tickMs);
  };

  PomodoroTimer.prototype._stopTicking = function () {
    if (this._intervalId === null) return;
    global.clearInterval(this._intervalId);
    this._intervalId = null;
  };

  /**
   * Recompute the remaining time from a wall-clock end time rather than by
   * subtracting a fixed amount. Browsers throttle timers in background tabs,
   * so this keeps the countdown honest when you come back to the tab.
   */
  PomodoroTimer.prototype._sync = function () {
    if (this._endTime === null) return;
    this.remainingMs = Math.max(0, this._endTime - Date.now());
    if (this.remainingMs === 0) {
      this._finishPeriod();
      return;
    }
    this._emit('tick', null);
  };

  /** Load the full duration of the current mode into the countdown. */
  PomodoroTimer.prototype._loadCurrentMode = function () {
    this.totalMs = minutesToMs(this.durations[this.mode]);
    this.remainingMs = this.totalMs;
    this._endTime = null;
  };

  /* ---------- Controls (requirements 4–8) ---------- */

  /** Start from idle, or resume if paused. */
  PomodoroTimer.prototype.start = function () {
    if (this.phase === PHASE.RUNNING) return; // already going — do nothing
    this.phase = PHASE.RUNNING;
    this._endTime = Date.now() + this.remainingMs;
    this._startTicking();
    this._emit('change', null);
  };

  /** Pause the countdown, keeping the time already spent. */
  PomodoroTimer.prototype.pause = function () {
    if (this.phase !== PHASE.RUNNING) return;
    this.remainingMs = Math.max(0, this._endTime - Date.now());
    this._endTime = null;
    this._stopTicking();
    this.phase = PHASE.PAUSED;
    this._emit('change', null);
  };

  /** Resume from exactly where pause left off. */
  PomodoroTimer.prototype.resume = function () {
    if (this.phase !== PHASE.PAUSED) return;
    this.start();
  };

  /** Convenience for a single Start/Pause/Resume button. */
  PomodoroTimer.prototype.toggle = function () {
    if (this.phase === PHASE.RUNNING) this.pause();
    else this.start();
  };

  /** Reload the current period from the start. Does not touch the count. */
  PomodoroTimer.prototype.reset = function () {
    this._stopTicking();
    this.phase = PHASE.IDLE;
    this._loadCurrentMode();
    this._emit('change', null);
  };

  /**
   * Jump to the next period immediately.
   * A skipped focus block does NOT earn a Pomodoro, so a skipped focus always
   * leads to a short break and never to a long break.
   */
  PomodoroTimer.prototype.skip = function () {
    this._stopTicking();
    this.mode = this.mode === MODE.FOCUS ? MODE.SHORT_BREAK : MODE.FOCUS;
    this.phase = PHASE.IDLE;
    this._loadCurrentMode();
    this._emit('change', null);
  };

  /** Forget the finished-Pomodoro count as well. */
  PomodoroTimer.prototype.resetCount = function () {
    this.completedPomodoros = 0;
    this._emit('change', null);
  };

  /* ---------- Settings (requirement 20) ---------- */

  /**
   * Update one or more durations. A change made while a period is running
   * only takes effect from the next period, which avoids a running countdown
   * suddenly jumping.
   */
  PomodoroTimer.prototype.setDurations = function (partial) {
    var next = partial || {};
    if (next.focus !== undefined) this.durations.focus = clampMinutes(next.focus);
    if (next.shortBreak !== undefined) this.durations.shortBreak = clampMinutes(next.shortBreak);
    if (next.longBreak !== undefined) this.durations.longBreak = clampMinutes(next.longBreak);

    if (this.phase === PHASE.IDLE) this._loadCurrentMode();
    this._emit('change', null);
  };

  PomodoroTimer.prototype.setAutoStartNext = function (enabled) {
    this.autoStartNext = !!enabled;
    this._emit('change', null);
  };

  function clampMinutes(value) {
    var number = Number(value);
    if (!isFinite(number)) return DEFAULT_DURATIONS.focus;
    return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(number)));
  }

  /* ---------- Automatic transitions (requirements 12–13) ---------- */

  PomodoroTimer.prototype._finishPeriod = function () {
    var finishedMode = this.mode;
    // Capture the full length of the period before _loadCurrentMode()
    // replaces totalMs. Subscribers (the study session) use this to count
    // Pomodoros and break time.
    var finishedDurationMs = this.totalMs;

    this._stopTicking();
    this.remainingMs = 0;
    this._endTime = null;

    if (finishedMode === MODE.FOCUS) {
      this.completedPomodoros += 1;
      var reachedCycle = this.completedPomodoros % this.cyclesBeforeLongBreak === 0;
      this.mode = reachedCycle ? MODE.LONG_BREAK : MODE.SHORT_BREAK;
    } else {
      // Any break hands over to the next focus block.
      this.mode = MODE.FOCUS;
    }

    this.phase = PHASE.IDLE;
    this._loadCurrentMode();

    // Let the UI announce the finished period (chime, highlight, ...).
    this._emit('complete', {
      finishedMode: finishedMode,
      nextMode: this.mode,
      completedPomodoros: this.completedPomodoros,
      durationMs: finishedDurationMs,
    });

    if (this.autoStartNext) this.start();
    else this._emit('change', null);
  };

  /* ---------- Teardown ---------- */

  PomodoroTimer.prototype.destroy = function () {
    this._stopTicking();
    this._handlers = { tick: [], change: [], complete: [] };
  };

  /* ---------- Exports ---------- */

  global.FocusGuardTimer = {
    PomodoroTimer: PomodoroTimer,
    MODE: MODE,
    PHASE: PHASE,
    DEFAULT_DURATIONS: DEFAULT_DURATIONS,
    MIN_MINUTES: MIN_MINUTES,
    MAX_MINUTES: MAX_MINUTES,
    formatClock: formatClock,
  };
})(window);
