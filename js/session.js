/* =====================================================================
   FocusGuard — js/session.js
   Phase 3: Study session logic.

   This file contains NO DOM code, NO sound and NO storage. It is a small
   state machine that tracks one study session at a time, exactly like
   js/timer.js tracks one Pomodoro period.

   A "session" is a stretch of studying with a subject and a goal. While it
   runs, the Pomodoro timer is associated with it, so every finished focus
   block adds to the session's Pomodoro count.

   ---- The session record --------------------------------------------
   When a session ends it is turned into a plain object and kept in memory:

     {
       id:                "s-1a2b3c4d",   // unique id
       subject:           "Linear algebra",
       goal:              "Finish chapter 4 exercises",

       startTime:         1759480200000,  // epoch ms, when it started
       endTime:           1759483800000,  // epoch ms, when it ended
       totalDurationMs:   3600000,        // end - start (wall clock)
       activeDurationMs:  3540000,        // total minus paused time
       pausedDurationMs:  60000,          // time spent paused

       focusedDurationMs: null,           // placeholder — camera phase
       breakDurationMs:   900000,         // time the timer spent in breaks
       pomodorosCompleted: 3,             // finished focus blocks

       status:            "completed",    // "completed" | "endedEarly"
       createdAt:         1759480200000,  // when the record was created
     }

   `focusedDurationMs` stays null on purpose: real focused time needs camera
   monitoring, which is a later phase. The field is reserved now so nothing
   has to change when it arrives.

   ---- Using it from the console --------------------------------------
     const s = window.FocusGuard.session;
     s.on('change', console.log);
     s.start({ subject: 'Physics', goal: 'Revise optics' });
     s.pause(); s.resume(); s.end();

   The UI controller lives in js/session-ui.js.
   ===================================================================== */

(function (global) {
  'use strict';

  /* ---------- Public constants ---------- */

  /** Lifecycle of a study session. */
  var SESSION_STATUS = {
    IDLE: 'idle',             // no session has been started
    RUNNING: 'running',       // the clock is ticking
    PAUSED: 'paused',         // paused by the user
    ENDED: 'ended',           // finished, summary shown
  };

  /** Status stored on a finished record. */
  var RECORD_STATUS = {
    COMPLETED: 'completed',
    ENDED_EARLY: 'endedEarly',
  };

  /** How long a focus block must last before it counts as a real Pomodoro. */
  var MIN_FOCUS_BLOCK_MS = 60 * 1000;

  var MAX_TEXT_LENGTH = 120;
  var MAX_HISTORY = 100;

  /* ---------- Helpers ---------- */

  function trimText(value, fallback) {
    if (typeof value !== 'string') return fallback;
    var text = value.trim().replace(/\s+/g, ' ');
    if (!text) return fallback;
    return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
  }

  function makeId() {
    // Good enough to be unique within one browser tab's memory.
    var random = Math.random().toString(16).slice(2, 8);
    return 's-' + Date.now().toString(16) + random;
  }

  function cloneRecord(record) {
    if (!record) return null;
    return Object.assign({}, record);
  }

  /* ---------- The session manager ---------- */

  function SessionManager(options) {
    options = options || {};

    this.tickMs = options.tickMs || 1000;

    // Live (in-progress) session. Null when nothing is running.
    this.active = null;

    // Finished records, newest first.
    this.history = [];

    this._intervalId = null;
    this._pomodoroUnsubscribe = null;

    this._handlers = {
      change: [],   // any state change (start, tick, pause, end, ...)
      tick: [],     // the elapsed clock moved
      end: [],      // a session finished (gets the finished record)
    };
  }

  /* ---------- Events ---------- */

  /** Subscribe to 'change', 'tick' or 'end'. Returns an unsubscribe fn. */
  SessionManager.prototype.on = function (eventName, handler) {
    if (!this._handlers[eventName]) return function () {};
    this._handlers[eventName].push(handler);
    var self = this;
    return function () {
      var list = self._handlers[eventName];
      var index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    };
  };

  SessionManager.prototype._emit = function (eventName, payload) {
    var state = this.getState();
    var list = this._handlers[eventName] || [];
    for (var i = 0; i < list.length; i += 1) {
      list[i](state, payload);
    }
  };

  /* ---------- Reading state ---------- */

  /**
   * A plain snapshot the UI can render from. This is the "live session"
   * view of the data — the finished record is built by _buildRecord().
   */
  SessionManager.prototype.getState = function () {
    var active = this.active;

    return {
      status: active ? active.status : SESSION_STATUS.IDLE,
      isActive: !!active,
      subject: active ? active.subject : '',
      goal: active ? active.goal : '',
      startTime: active ? active.startTime : null,

      // How long the session has existed, including paused time.
      totalDurationMs: active ? this._elapsedTotal() : 0,
      // How long it was actually running, excluding paused time.
      activeDurationMs: active ? this._elapsedActive() : 0,
      pausedDurationMs: active ? active.pausedDurationMs : 0,

      // Reserved for the camera-monitoring phase.
      focusedDurationMs: active ? active.focusedDurationMs : null,
      breakDurationMs: active ? active.breakDurationMs : 0,

      pomodorosCompleted: active ? active.pomodorosCompleted : 0,

      sessionCount: this.history.length,
      history: this.history.slice(),
    };
  };

  /** Wall-clock time since the session started. */
  SessionManager.prototype._elapsedTotal = function () {
    if (!this.active) return 0;
    return Math.max(0, Date.now() - this.active.startTime);
  };

  /** Running time only, so pausing genuinely stops the elapsed clock. */
  SessionManager.prototype._elapsedActive = function () {
    var active = this.active;
    if (!active) return 0;
    var extra = active.status === SESSION_STATUS.RUNNING
      ? Math.max(0, Date.now() - active.lastResumeTime)
      : 0;
    return active.accumulatedActiveMs + extra;
  };

  /* ---------- The session clock ---------- */

  SessionManager.prototype._startTicking = function () {
    if (this._intervalId !== null) return;
    var self = this;
    this._intervalId = global.setInterval(function () {
      self._emit('tick', null);
    }, this.tickMs);
  };

  SessionManager.prototype._stopTicking = function () {
    if (this._intervalId === null) return;
    global.clearInterval(this._intervalId);
    this._intervalId = null;
  };

  /* ---------- Lifecycle ---------- */

  /**
   * Begin a study session.
   * @param {object} details
   * @param {string} details.subject
   * @param {string} [details.goal]
   * @returns {object|null} the new state, or null if a session is running
   */
  SessionManager.prototype.start = function (details) {
    details = details || {};
    if (this.active) return null; // one session at a time

    var subject = trimText(details.subject, 'Study session');
    var goal = trimText(details.goal, '');

    var now = Date.now();
    this.active = {
      id: makeId(),
      subject: subject,
      goal: goal,

      startTime: now,
      endTime: null,

      // Wall-clock start of the current running stretch.
      lastResumeTime: now,
      // Running time accumulated across previous stretches.
      accumulatedActiveMs: 0,
      pausedDurationMs: 0,

      focusedDurationMs: null, // camera phase
      breakDurationMs: 0,
      pomodorosCompleted: 0,

      status: SESSION_STATUS.RUNNING,
      createdAt: now,
    };

    this._startTicking();
    this._emit('change', null);
    return this.getState();
  };

  /** Stop the elapsed clock without ending the session. */
  SessionManager.prototype.pause = function () {
    if (!this.active || this.active.status !== SESSION_STATUS.RUNNING) return null;

    var now = Date.now();
    this.active.accumulatedActiveMs += Math.max(0, now - this.active.lastResumeTime);
    this.active.lastPauseTime = now;
    this.active.status = SESSION_STATUS.PAUSED;

    this._stopTicking();
    this._emit('change', null);
    return this.getState();
  };

  /** Continue a paused session. */
  SessionManager.prototype.resume = function () {
    if (!this.active || this.active.status !== SESSION_STATUS.PAUSED) return null;

    var now = Date.now();
    this.active.pausedDurationMs += Math.max(0, now - (this.active.lastPauseTime || now));
    this.active.lastResumeTime = now;
    this.active.status = SESSION_STATUS.RUNNING;

    this._startTicking();
    this._emit('change', null);
    return this.getState();
  };

  /** Pause if running, resume if paused — for a single toggle button. */
  SessionManager.prototype.togglePause = function () {
    if (!this.active) return null;
    return this.active.status === SESSION_STATUS.RUNNING ? this.pause() : this.resume();
  };

  /**
   * Finish the session and file it in history.
   * @returns {object|null} the finished record
   */
  SessionManager.prototype.end = function () {
    if (!this.active) return null;

    if (this.active.status === SESSION_STATUS.RUNNING) {
      this.active.accumulatedActiveMs +=
        Math.max(0, Date.now() - this.active.lastResumeTime);
    }

    this._stopTicking();
    this._detachTimer();

    var record = this._buildRecord();
    this.active = null;

    this.history.unshift(record);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;

    this._emit('change', null);
    this._emit('end', record);
    return record;
  };

  /** Turn the live session into the frozen record described at the top. */
  SessionManager.prototype._buildRecord = function () {
    var active = this.active;
    var now = Date.now();

    var totalDurationMs = Math.max(0, now - active.startTime);
    var activeDurationMs = Math.round(active.accumulatedActiveMs);

    return {
      id: active.id,
      subject: active.subject,
      goal: active.goal,

      startTime: active.startTime,
      endTime: now,
      totalDurationMs: totalDurationMs,
      activeDurationMs: activeDurationMs,
      pausedDurationMs: Math.max(0, totalDurationMs - activeDurationMs),

      focusedDurationMs: active.focusedDurationMs, // placeholder (camera phase)
      breakDurationMs: Math.round(active.breakDurationMs),
      pomodorosCompleted: active.pomodorosCompleted,

      status: active.pomodorosCompleted > 0
        ? RECORD_STATUS.COMPLETED
        : RECORD_STATUS.ENDED_EARLY,

      createdAt: active.createdAt,
    };
  };

  /** Throw away the in-progress session without filing it. */
  SessionManager.prototype.discard = function () {
    if (!this.active) return;
    this._stopTicking();
    this._detachTimer();
    this.active = null;
    this._emit('change', null);
  };

  SessionManager.prototype.clearHistory = function () {
    this.history = [];
    this._emit('change', null);
  };

  /* ---------- Associating the Pomodoro timer ---------- */

  /**
   * Listen to a PomodoroTimer instance so the session can count its own
   * Pomodoros and break time. Called once by the UI controller.
   *
   * @param {object} timer a FocusGuardTimer.PomodoroTimer instance
   */
  SessionManager.prototype.attachTimer = function (timer) {
    this._detachTimer();
    if (!timer || typeof timer.on !== 'function') return;

    var self = this;

    var unsubscribe = timer.on('complete', function (state, detail) {
      if (!self.active) return;
      self._registerPeriod(detail);
    });

    this._pomodoroUnsubscribe = unsubscribe;
    this._timer = timer;
  };

  SessionManager.prototype._detachTimer = function () {
    if (typeof this._pomodoroUnsubscribe === 'function') {
      this._pomodoroUnsubscribe();
    }
    this._pomodoroUnsubscribe = null;
  };

  /**
   * A Pomodoro period finished while a session is running. Count focus
   * blocks and accumulate break time. Focus time is deliberately NOT added
   * to focusedDurationMs — that field waits for camera monitoring.
   */
  SessionManager.prototype._registerPeriod = function (detail) {
    if (!this.active || !detail) return;

    var durationMs = Math.max(0, Number(detail.durationMs) || 0);

    if (detail.finishedMode === 'focus') {
      if (durationMs >= MIN_FOCUS_BLOCK_MS) {
        this.active.pomodorosCompleted += 1;
      }
    } else if (detail.finishedMode === 'shortBreak' || detail.finishedMode === 'longBreak') {
      this.active.breakDurationMs += durationMs;
    }

    this._emit('change', null);
  };

  /* ---------- Teardown ---------- */

  SessionManager.prototype.destroy = function () {
    this._stopTicking();
    this._detachTimer();
    this._handlers = { change: [], tick: [], end: [] };
  };

  /* ---------- Exports ---------- */

  global.FocusGuardSession = {
    SessionManager: SessionManager,
    SESSION_STATUS: SESSION_STATUS,
    RECORD_STATUS: RECORD_STATUS,
    MIN_FOCUS_BLOCK_MS: MIN_FOCUS_BLOCK_MS,
  };
})(window);
