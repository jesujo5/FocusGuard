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

       focusedDurationMs:     2460000,   // screen-facing time (measured)
       distractedDurationMs:   240000,   // attention elsewhere (head away)
       faceMissingDurationMs:  150000,   // face not in frame
       unclassifiedDurationMs: 300000,   // grace / detection unavailable
       distractionCount:            3,   // one event per away episode

       focusScore:                 79,   // estimated, 0-100 (null if unmeasured)
       focusRating:         'Strong',    // Excellent / Strong / Moderate / ...
       focusCoinsEarned:           41,   // 1 focused minute = 1 coin
       measured:                 true,   // was the camera on during the session?

       breakDurationMs:   900000,         // time the timer spent in breaks
       pomodorosCompleted: 3,             // finished focus blocks

       status:            "completed",    // "completed" | "endedEarly"
       createdAt:         1759480200000,  // when the record was created
     }

   The measured attention fields come from js/distraction.js (timing) and
   js/focusEngine.js (score, rating, coins). They stay null/0 when the
   camera was off for the whole session — the history table and the summary
   then show a dash instead of a number. The session never measures or
   scores anything itself, so attention timing has one single owner.

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

  /**
   * The measured attention numbers for the live session.
   *
   * js/distraction.js owns the timing buckets (focused / distracted /
   * face-missing) and js/focusEngine.js turns them into a Focus Score, a
   * rating and Focus Coins. The session only reads the result, so exactly
   * one module measures attention for a session. Returns null when nothing
   * was measured (for example the camera was off the whole time).
   */
  function attentionSnapshot() {
    var engine = global.FocusGuard && global.FocusGuard.focusEngine;
    if (!engine || typeof engine.getSessionSnapshot !== 'function') return null;
    return engine.getSessionSnapshot();
  }

  /**
   * A side-effect-free peek at the live attention numbers (no coin awarding).
   * Returns null when nothing is measurable yet.
   */
  function liveAttention() {
    var engine = global.FocusGuard && global.FocusGuard.focusEngine;
    if (!engine || typeof engine.peekSession !== 'function') return null;
    var live = engine.peekSession();
    if (!live.sessionActive || !live.measured) return null;
    return {
      focusedDurationMs: live.focusedMs,
      distractedDurationMs: live.distractedMs,
      faceMissingDurationMs: live.faceMissingMs,
      focusScore: live.score,
      focusRating: live.rating,
      focusCoinsEarned: live.coinsEarned,
      currentState: live.currentState,
    };
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
    var attention = active ? liveAttention() : null;

    return {
      id: active ? active.id : null,
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

      // Measured by the attention engine while the camera monitors the session.
      focusedDurationMs: attention ? attention.focusedDurationMs : null,
      distractedDurationMs: attention ? attention.distractedDurationMs : null,
      faceMissingDurationMs: attention ? attention.faceMissingDurationMs : null,
      focusScore: attention ? attention.focusScore : null,
      focusRating: attention ? attention.focusRating : null,
      focusCoinsEarned: attention ? attention.focusCoinsEarned : 0,

      // Where the attention state currently stands (FOCUSED, GRACE, ...).
      attentionState: attention ? attention.currentState : null,
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
    var attention = attentionSnapshot();

    return {
      id: active.id,
      subject: active.subject,
      goal: active.goal,

      startTime: active.startTime,
      endTime: now,
      totalDurationMs: totalDurationMs,
      activeDurationMs: activeDurationMs,
      pausedDurationMs: Math.max(0, totalDurationMs - activeDurationMs),

      // ---- measured attention (null/0 when the camera was off) --------
      // Screen-facing time and the time the attention was elsewhere. Every
      // measured second belongs to exactly one of these, so they never
      // overlap. See js/focusEngine.js for the score and coin rules.
      focusedDurationMs: attention ? attention.focusedDurationMs : null,
      distractedDurationMs: attention ? attention.distractedDurationMs : null,
      faceMissingDurationMs: attention ? attention.faceMissingDurationMs : null,
      unclassifiedDurationMs: attention ? attention.unclassifiedDurationMs : null,
      distractionCount: attention ? attention.distractionCount : 0,
      measured: attention ? attention.measured === true : false,

      // Estimated productivity for this session (null = not measurable).
      focusScore: attention ? attention.focusScore : null,
      focusRating: attention ? attention.focusRating : null,
      focusCoinsEarned: attention ? attention.focusCoinsEarned : 0,

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

  /* ---------- Persistence hooks (Phase 9) -----------------------------
     js/sync.js owns storage. These three methods are the only way it
     needs to touch the session manager: read the live session to save it,
     put it back after a reload, and fill the history list with the
     records that were loaded from IndexedDB.
     ------------------------------------------------------------------- */

  /**
   * A small, storable picture of the live session. Returns null when
   * nothing is running. Used to offer "resume / end / discard" after a
   * browser restart without ever touching the camera.
   */
  SessionManager.prototype.snapshot = function () {
    var active = this.active;
    if (!active) return null;
    return {
      id: active.id,
      subject: active.subject,
      goal: active.goal,
      startTime: active.startTime,
      createdAt: active.createdAt,
      accumulatedActiveMs: Math.round(this._elapsedActive()),
      pausedDurationMs: Math.round(active.pausedDurationMs || 0),
      breakDurationMs: Math.round(active.breakDurationMs || 0),
      pomodorosCompleted: active.pomodorosCompleted || 0,
      status: active.status,
    };
  };

  /**
   * Put a saved session back as the live one. It always comes back
   * PAUSED: FocusGuard never restarts camera monitoring on its own, and
   * never asks for webcam permission after a page load.
   *
   * The session keeps its original id, so re-saving it can only ever
   * update the same stored/remote record — never create a duplicate.
   */
  SessionManager.prototype.restore = function (saved) {
    if (!saved || !saved.id) return null;
    if (this.active) return null;

    var now = Date.now();
    var startTime = Number(saved.startTime) || now;
    var accumulated = Math.max(0, Number(saved.accumulatedActiveMs) || 0);

    this.active = {
      id: saved.id,
      subject: trimText(saved.subject, 'Recovered session'),
      goal: trimText(saved.goal, ''),

      startTime: startTime,
      endTime: null,

      lastResumeTime: now,
      lastPauseTime: now,
      accumulatedActiveMs: accumulated,
      // Whatever is not measured running time counts as paused time, so
      // "total elapsed = active + paused" always stays true.
      pausedDurationMs: Math.max(0, now - startTime - accumulated),

      focusedDurationMs: null,
      breakDurationMs: Math.max(0, Number(saved.breakDurationMs) || 0),
      pomodorosCompleted: Math.max(0, Math.floor(Number(saved.pomodorosCompleted) || 0)),

      restored: true,
      status: SESSION_STATUS.PAUSED,
      createdAt: Number(saved.createdAt) || startTime,
    };

    this._emit('change', null);
    return this.getState();
  };

  /**
   * Seed the history list from stored records (newest first). The manager
   * still keeps them in memory only — it is the UI that renders them.
   */
  SessionManager.prototype.restoreHistory = function (records) {
    var list = (records || [])
      .filter(function (record) { return record && record.id; })
      .map(cloneRecord);

    list.sort(function (a, b) { return (b.startTime || 0) - (a.startTime || 0); });
    this.history = list.slice(0, MAX_HISTORY);
    this._emit('change', null);
    return this.getState();
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
