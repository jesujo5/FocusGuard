/* =====================================================================
   FocusGuard — js/distraction.js
   Phase 7: Attention / distraction engine.

   This module turns the camera signals we already have into one honest
   answer: "is the user facing the study screen right now?"

     camera.js ── video ──▶ faceDetection.js ── landmarks ──▶ attention.js
                                                                  │
                                                          distraction.js
                                                                  │
                                                          focus status

   It does NOT know whether the user is mentally focused. It only
   measures screen-facing attention (face present + head forward) and how
   long attention has been away from the screen. Nothing here is sent
   anywhere: no frame, no landmark and no image leaves the browser.

   ---- What it reuses (nothing new is created) ------------------------
     * no second webcam stream        — camera.js owns the stream
     * no second face detector        — faceDetection.js owns the model
     * no second detection loop       — faceDetection.js owns the rAF loop

   The engine is event-driven: it reads the *latest* result from the
   modules above and evaluates on a light 250 ms heartbeat. Every duration
   comes from timestamps, so the heartbeat only affects how quickly a
   change is noticed, never the numbers themselves.

   ---- States ---------------------------------------------------------
     FOCUSED      face detected, head forward, stable for ~1.2 s
     GRACE        was focused, looked away, grace period not over yet
     DISTRACTED   looked away for longer than the grace period
     FACE_MISSING no face in frame (already debounced by faceDetection)
     UNKNOWN      camera off, model loading/failed — nothing reliable

   ---- What it measures ----------------------------------------------
   While a study session runs (and the Pomodoro is not paused or on a
   break, and the tab is visible) every measured millisecond is filed into
   exactly one bucket with timestamps:

     FOCUSED       → focused time
     DISTRACTED    → distracted time   (also the distraction events)
     FACE_MISSING  → face-missing time (kept apart from head-away time)
     GRACE/UNKNOWN → unclassified time (never counted as focused)

   js/focusEngine.js turns those buckets into a Focus Score, a rating and
   Focus Coins. This file owns *timing*, that one owns *scoring*.

   ---- Distraction events ---------------------------------------------"
   Exactly ONE event per away episode, created when GRACE becomes
   DISTRACTED and closed when the user is FOCUSED again (or when the
   camera stops / the session ends). Metadata only, kept in memory:

     { id, startTime, endTime, duration, reason: 'HEAD_AWAY' | 'FACE_MISSING' }

   ---- Session integration --------------------------------------------
   Camera on, no study session → status monitoring only, no records.
   Camera on, session active   → focused time and distraction events are
                                 accumulated for that session.

   The Pomodoro timer is never touched: this module has no reference to
   js/timer.js at all.

   ---- Console --------------------------------------------------------
     const d = window.FocusGuard.distraction;
     d.on('change', console.log);
     d.on('event', console.log);
     d.getState(); d.getSessionData(); d.getEvents();
     d.setGracePeriod(8);
   ===================================================================== */

(function (global) {
  'use strict';

  /* ---------- Public constants ---------- */

  /** The attention states this engine can report. */
  var STATE = {
    FOCUSED: 'focused',
    GRACE: 'grace',
    DISTRACTED: 'distracted',
    FACE_MISSING: 'face-missing',
    UNKNOWN: 'unknown',
  };

  /**
   * Neutral, screen-facing wording. We measure whether the user looks at
   * the screen — never whether they are "concentrating".
   */
  var LABELS = {
    focused: 'Focused',
    grace: 'Attention drifting',
    distracted: 'Distracted',
    'face-missing': 'Face not detected',
    unknown: 'Detection unavailable',
  };

  /** Why an away episode happened. */
  var REASON = {
    HEAD_AWAY: 'HEAD_AWAY',
    FACE_MISSING: 'FACE_MISSING',
  };

  /** Fixed second line of the status row (the distracted one is live). */
  var DETAILS = {
    focused: '',
    grace: 'Returning to screen…',
    distracted: '',
    'face-missing': '',
    unknown: '',
  };

  var DEFAULT_GRACE_S = 5;      // spec default
  var GRACE_MIN_S = 2;
  var GRACE_MAX_S = 15;

  /** How long "forward" must hold before we call it FOCUSED. */
  var DEFAULT_STABLE_MS = 1200;

  /** Light heartbeat: used for grace expiry and the live seconds readout. */
  var TICK_MS = 250;

  var TURN_DIRECTIONS = ['left', 'right', 'up', 'down'];

  /* ---------- Module state ---------- */

  var state = STATE.UNKNOWN;
  var stateSince = 0;

  var awaySince = null;         // start of the current not-facing episode
  var awayReason = null;        // HEAD_AWAY | FACE_MISSING (current condition)
  var forwardSince = null;      // when the head started facing forward again

  // Measurement gate + one time bucket per attention category. Every
  // measured millisecond lands in exactly one bucket, or in none at all
  // when study time is not being measured.
  var measuring = false;
  var gates = { sessionPaused: false, visible: true, timerPaused: false, onBreak: false };
  var bucket = null;            // 'focused' | 'distracted' | 'face-missing' | 'unclassified' | null
  var bucketSince = 0;

  var graceMs = DEFAULT_GRACE_S * 1000;
  var stableMs = DEFAULT_STABLE_MS;

  // Latest signals (mirrors, never duplicated sources of truth).
  var cameraActive = false;
  var cameraState = 'off';
  var sessionActive = false;
  var tracking = false;         // camera on AND session active

  // Accumulators (milliseconds, in memory only).
  var focusedMs = 0;
  var distractedMs = 0;
  var faceMissingMs = 0;
  var unclassifiedMs = 0;
  var events = [];
  var openEvent = null;
  var tracked = false;          // the engine saw camera + session at the same time
  var lastSessionData = null;   // frozen snapshot of the session that just ended

  var tickId = null;
  var attached = false;
  var unsubscribers = [];
  var handlers = { change: [], event: [] };
  var lastSignature = '';
  var eventSeq = 0;

  /* ---------- Small helpers ---------- */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function clamp(value, min, max) {
    if (!isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  function seconds(ms) {
    return Math.max(0, Math.round(ms / 1000));
  }

  function makeEventId() {
    eventSeq += 1;
    return 'd-' + Date.now().toString(16) + '-' + eventSeq;
  }

  function isTurn(direction) {
    return TURN_DIRECTIONS.indexOf(direction) !== -1;
  }

  function on(eventName, handler) {
    if (!handlers[eventName]) return function () {};
    handlers[eventName].push(handler);
    return function () {
      var list = handlers[eventName];
      var index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    };
  }

  function emit(eventName, payload) {
    (handlers[eventName] || []).forEach(function (fn) { fn(payload); });
  }

  /* ---------- Reading the existing pipeline ---------------------------- */

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
  }

  /** Latest camera state ('off' | 'starting' | 'active' | 'denied' | 'error'). */
  function readCamera() {
    var camera = module('camera');
    if (!camera || typeof camera.getState !== 'function') return 'off';
    return camera.getState().state || 'off';
  }

  /** Latest head direction from attention.js. */
  function readDirection() {
    var attention = module('attention');
    if (!attention || typeof attention.getState !== 'function') return 'unknown';
    return attention.getState().direction || 'unknown';
  }

  /**
   * Is face detection giving us a usable answer right now?
   * @returns {'present'|'missing'|'unknown'}
   */
  function readDetection() {
    if (!cameraActive) return 'unknown';

    var detection = module('faceDetection');
    if (!detection || typeof detection.getState !== 'function') return 'unknown';

    var snapshot = detection.getState();
    if (snapshot.cameraState !== 'active') return 'unknown';
    if (snapshot.face === 'present') return 'present';
    if (snapshot.face === 'missing') return 'missing';
    return 'unknown';
  }

  function readSessionActive() {
    var session = module('session');
    if (!session || typeof session.getState !== 'function') return false;
    return session.getState().isActive === true;
  }

  /* ---------- Accumulators -------------------------------------------- */

  /* ---------- Measurement gate + buckets ------------------------------ */

  /**
   * Read the gates that decide whether time is measured at all. All three
   * are read-only: this module never pauses a timer or a session.
   *   - the study session must be running (a paused session measures nothing)
   *   - the Pomodoro must not be paused and must not be in a break
   *   - the tab must be visible (a hidden tab cannot be measured honestly)
   */
  function readGates() {
    var session = module('session');
    var sessionState = session && typeof session.getState === 'function'
      ? session.getState() : null;
    gates.sessionPaused = !!(sessionState && sessionState.status === 'paused');

    var timer = module('timer');
    var timerState = timer && typeof timer.getState === 'function'
      ? timer.getState() : null;
    gates.timerPaused = !!(timerState && timerState.phase === 'paused');
    gates.onBreak = !!(timerState &&
      (timerState.mode === 'shortBreak' || timerState.mode === 'longBreak'));

    gates.visible = !document.hidden;
  }

  function measurementOpen() {
    readGates();
    return tracking &&
      !gates.sessionPaused &&
      !gates.timerPaused &&
      !gates.onBreak &&
      gates.visible;
  }

  /** Which bucket an attention state belongs in. */
  function bucketFor(stateName) {
    if (stateName === STATE.FOCUSED) return 'focused';
    if (stateName === STATE.DISTRACTED) return 'distracted';
    if (stateName === STATE.FACE_MISSING) return 'face-missing';
    // GRACE only lasts a few seconds and UNKNOWN has no verdict at all, so
    // neither is allowed to inflate a positive number.
    return 'unclassified';
  }

  function currentBucket() {
    if (!measuring) return null;
    return bucketFor(state);
  }

  function commitBucket(now) {
    if (bucket === null) return;
    var ms = Math.max(0, now - bucketSince);
    if (bucket === 'focused') focusedMs += ms;
    else if (bucket === 'distracted') distractedMs += ms;
    else if (bucket === 'face-missing') faceMissingMs += ms;
    else unclassifiedMs += ms;
  }

  /** Close the current interval and start a new one at `now`. */
  function setBucket(next, now) {
    if (next === bucket) return;
    commitBucket(now);
    bucket = next;
    bucketSince = now;
  }

  /** Stop measuring: close the interval, then count nothing at all. */
  function freezeBucket(now) {
    commitBucket(now);
    bucket = null;
    bucketSince = now;
  }

  function liveBucketMs(name, now) {
    var total = name === 'focused' ? focusedMs
      : name === 'distracted' ? distractedMs
      : name === 'face-missing' ? faceMissingMs
      : unclassifiedMs;
    if (bucket === name) total += Math.max(0, now - bucketSince);
    return Math.round(total);
  }

  function liveFocusedMs(now) { return liveBucketMs('focused', now); }
  function liveDistractionMs(now) { return liveBucketMs('distracted', now); }
  function liveFaceMissingMs(now) { return liveBucketMs('face-missing', now); }
  function liveUnclassifiedMs(now) { return liveBucketMs('unclassified', now); }

  function openDistraction(now) {
    if (!measuring || openEvent || !awaySince) return;
    openEvent = {
      id: makeEventId(),
      startTime: now,
      endTime: null,
      duration: 0,
      reason: awayReason === REASON.FACE_MISSING ? REASON.FACE_MISSING : REASON.HEAD_AWAY,
    };
    emit('event', { type: 'open', event: cloneEvent(openEvent) });
  }

  function closeDistraction(now) {
    if (!openEvent) return;
    openEvent.endTime = now;
    openEvent.duration = Math.max(0, now - openEvent.startTime);
    events.push(openEvent);
    var closed = cloneEvent(openEvent);
    openEvent = null;
    emit('event', { type: 'close', event: closed });
  }

  function cloneEvent(event) {
    return {
      id: event.id,
      startTime: event.startTime,
      endTime: event.endTime,
      duration: event.duration,
      reason: event.reason,
    };
  }

  function resetAccumulators() {
    focusedMs = 0;
    distractedMs = 0;
    faceMissingMs = 0;
    unclassifiedMs = 0;
    events = [];
    openEvent = null;
    tracked = false;
  }

  /* ---------- The state machine --------------------------------------- */

  function clearEpisode(now) {
    awaySince = null;
    awayReason = null;
    closeDistraction(now);
  }

  /** Enter FOCUSED / leave FOCUSED bookkeeping lives here. */
  function setState(next, now) {
    if (next === state) return;

    if (next === STATE.FOCUSED) {
      closeDistraction(now);          // the away episode is over
    }

    state = next;
    stateSince = now;

    // Switch the measured bucket at the exact instant the state changed, so
    // the buckets agree with the distraction events to the millisecond.
    setBucket(currentBucket(), now);
  }

  /**
   * One evaluation pass over the latest signals. Every duration is derived
   * from timestamps, so calling this more or less often never changes a
   * recorded number.
   */
  function evaluate(now) {
    now = now || Date.now();

    // Refresh the measurement gate first: a paused session, a break or a
    // hidden tab has to stop the clock at this exact timestamp.
    measuring = measurementOpen();
    setBucket(currentBucket(), now);

    if (!cameraActive) {
      standby(now);
      return;
    }

    var detection = readDetection();
    if (detection === 'unknown') {
      // Model loading/failed or no verdict yet: say so instead of guessing.
      clearEpisode(now);
      forwardSince = null;
      setState(STATE.UNKNOWN, now);
      publish(now);
      return;
    }

    var direction = readDirection();
    var facing = detection === 'present' && direction === 'forward';

    if (facing) {
      awaySince = null;
      awayReason = null;
      if (forwardSince === null) forwardSince = now;

      if (state !== STATE.FOCUSED && now - forwardSince >= stableMs) {
        setState(STATE.FOCUSED, now);
      }
      publish(now);
      return;
    }

    forwardSince = null;

    // Face is there but no trustworthy direction yet — stay neutral.
    if (detection === 'present' && direction !== 'forward' && !isTurn(direction)) {
      clearEpisode(now);
      setState(STATE.UNKNOWN, now);
      publish(now);
      return;
    }

    // Face missing is its own condition, and its own reason.
    var condition = detection === 'missing' ? REASON.FACE_MISSING : REASON.HEAD_AWAY;
    if (awaySince === null) {
      awaySince = now;
      awayReason = condition;
    } else if (awayReason !== condition && openEvent) {
      // The reason changed mid-episode (a turned head, then the face left
      // the frame). Close the old event so every event's duration matches
      // the time really spent in that condition.
      closeDistraction(now);
      awayReason = condition;
    }

    if (now - awaySince >= graceMs) {
      openDistraction(now);
      setState(condition === REASON.FACE_MISSING ? STATE.FACE_MISSING : STATE.DISTRACTED, now);
    } else {
      setState(condition === REASON.FACE_MISSING ? STATE.FACE_MISSING : STATE.GRACE, now);
    }

    publish(now);
  }

  /** Camera off (or unusable): nothing to report, nothing to keep open. */
  function standby(now) {
    closeDistraction(now);
    freezeBucket(now);
    awaySince = null;
    awayReason = null;
    forwardSince = null;
    state = STATE.UNKNOWN;
    publish(now);
  }

  /* ---------- Tracking (camera on + session active) -------------------- */

  function setTracking(next, now) {
    if (next === tracking) return;

    if (next) {
      resetAccumulators();
      tracking = true;
      tracked = true;
      lastSessionData = null;
      measuring = measurementOpen();
      if (state !== STATE.FOCUSED) awaySince = now;   // fresh away episode
      bucket = currentBucket();
      bucketSince = now;
    } else {
      closeDistraction(now);
      freezeBucket(now);
      lastSessionData = snapshotSession(now);
      tracking = false;
      resetAccumulators();
      awaySince = null;
      awayReason = null;
      forwardSince = null;
      bucket = null;
      bucketSince = now;
    }

    publish(now);
  }

  /* ---------- Status & rendering -------------------------------------- */

  function detailText(now) {
    if (state === STATE.DISTRACTED) {
      var from = awaySince !== null ? awaySince : stateSince;
      return 'Attention has been away for ' + seconds(now - from) + 's';
    }
    return DETAILS[state] || '';
  }

  function getState(now) {
    now = now || Date.now();
    var detection = readDetection();

    return {
      state: state,
      label: LABELS[state] || 'Unknown',
      detail: detailText(now),

      reason: openEvent ? openEvent.reason : awayReason,
      stateSince: stateSince,
      stateDurationMs: stateSince ? Math.max(0, now - stateSince) : 0,
      awaySince: awaySince,
      awayDurationMs: awaySince !== null ? Math.max(0, now - awaySince) : 0,

      graceMs: graceMs,
      graceSeconds: Math.round(graceMs / 1000),
      stableMs: stableMs,

      monitoring: cameraActive,
      tracking: tracking,
      cameraState: cameraState,
      sessionActive: sessionActive,
      headDirection: readDirection(),
      faceDetection: detection,

      measuring: measuring,
      gates: {
        sessionPaused: gates.sessionPaused, timerPaused: gates.timerPaused,
        onBreak: gates.onBreak, visible: gates.visible,
      },
      bucket: bucket,
      focusedDurationMs: Math.round(liveFocusedMs(now)),
      distractedDurationMs: Math.round(liveDistractionMs(now)),
      faceMissingDurationMs: Math.round(liveFaceMissingMs(now)),
      unclassifiedDurationMs: Math.round(liveUnclassifiedMs(now)),
      distractionDurationMs: Math.round(liveDistractionMs(now)),
      distractionCount: events.length + (openEvent ? 1 : 0),
      currentDistractionDurationMs: openEvent ? Math.max(0, now - openEvent.startTime) : 0,
      hasOpenEvent: !!openEvent,

      isImplemented: true,
      signature: [state, awayReason || '-', tracking ? 'tracking' : 'status'].join('|'),
    };
  }

  /** The contract later phases (Focus Score, analytics) can build on. */
  function getSessionData(now) {
    now = now || Date.now();
    return {
      state: state,
      focusedDuration: seconds(liveFocusedMs(now)),
      distractedDuration: seconds(liveDistractionMs(now)),
      faceMissingDuration: seconds(liveFaceMissingMs(now)),
      unclassifiedDuration: seconds(liveUnclassifiedMs(now)),
      distractionDuration: seconds(liveDistractionMs(now)),
      distractionCount: events.length + (openEvent ? 1 : 0),
      currentDistractionDuration: openEvent ? seconds(now - openEvent.startTime) : 0,

      // Millisecond precision for modules that need it.
      focusedDurationMs: Math.round(liveFocusedMs(now)),
      distractedDurationMs: Math.round(liveDistractionMs(now)),
      faceMissingDurationMs: Math.round(liveFaceMissingMs(now)),
      unclassifiedDurationMs: Math.round(liveUnclassifiedMs(now)),
      distractionDurationMs: Math.round(liveDistractionMs(now)),
      currentDistractionDurationMs: openEvent ? Math.max(0, now - openEvent.startTime) : 0,

      // Seconds: the unit the focus engine and the coin rule speak.
      focusedSeconds: seconds(liveFocusedMs(now)),
      distractedSeconds: seconds(liveDistractionMs(now)),
      faceMissingSeconds: seconds(liveFaceMissingMs(now)),

      measuring: measuring,
      tracked: tracked,
      tracking: tracking,
      monitoring: cameraActive,
      sessionActive: sessionActive,
    };
  }

  /**
   * Frozen copy of the session that just ended: the aggregate numbers plus
   * the individual distraction events. The live accumulators are cleared
   * afterwards, so the next session starts from zero while this snapshot
   * stays available (getLastSessionData()) for later phases.
   */
  function snapshotSession(now) {
    var data = getSessionData(now);
    data.finishedAt = now;
    data.events = events.map(cloneEvent);
    return data;
  }

  function publish(now) {
    render(now);
    var snapshot = getState(now);
    if (snapshot.signature === lastSignature) return;
    lastSignature = snapshot.signature;
    emit('change', snapshot);
  }

  function render(now) {
    now = now || Date.now();
    var snapshot = getState(now);
    var detail = snapshot.detail;

    each('[data-focus-status]', function (el) {
      el.dataset.focusState = snapshot.state;
      el.dataset.focusTracking = snapshot.tracking ? 'on' : 'off';
    });
    each('[data-focus-status-text]', function (el) {
      if (el.textContent !== snapshot.label) el.textContent = snapshot.label;
    });
    each('[data-focus-status-detail]', function (el) {
      if (el.textContent !== detail) el.textContent = detail;
      el.hidden = !detail;
    });
  }

  /* ---------- Wiring --------------------------------------------------- */

  function react() {
    var now = Date.now();
    syncCamera(now);
    syncSession(now);
    evaluate(now);
  }

  function syncCamera(now) {
    var next = readCamera();
    cameraState = next;
    var active = next === 'active';

    if (active !== cameraActive) {
      cameraActive = active;
      if (cameraActive) startTicker();
      else stopTicker();
    }

    return now;
  }

  function syncSession(now) {
    sessionActive = readSessionActive();
    setTracking(cameraActive && sessionActive, now);
  }

  function startTicker() {
    if (tickId !== null) return;              // never two heartbeats
    tickId = global.setInterval(function () {
      if (!cameraActive) return;
      evaluate(Date.now());
    }, TICK_MS);
  }

  function stopTicker() {
    if (tickId === null) return;
    global.clearInterval(tickId);
    tickId = null;
  }

  function subscribe(api, eventName, handler) {
    if (!api || typeof api.on !== 'function') return;
    var off = api.on(eventName, handler);
    if (typeof off === 'function') unsubscribers.push(off);
  }

  function attach(tries) {
    var camera = module('camera');
    var detection = module('faceDetection');
    var attention = module('attention');
    var session = module('session');

    if (!camera || !detection || !attention || attached) {
      if (!attached && tries < 25) {
        global.setTimeout(function () { attach(tries + 1); }, 120);
      }
      return;
    }

    attached = true;

    subscribe(camera, 'change', react);
    subscribe(detection, 'change', react);
    subscribe(attention, 'change', react);
    subscribe(session, 'change', react);
    subscribe(session, 'end', react);
    subscribe(module('timer'), 'change', react);
    document.addEventListener('visibilitychange', react);

    react();
  }

  function bindSettings() {
    each('[data-distraction-setting="grace"]', function (el) {
      el.value = String(Math.round(graceMs / 1000));
      el.addEventListener('change', function () { setGracePeriod(el.value); });
      el.addEventListener('input', function () { setGracePeriod(el.value); });
    });
  }

  function setGracePeriod(value) {
    var parsed = parseFloat(value);
    if (!isFinite(parsed)) parsed = DEFAULT_GRACE_S;
    var nextMs = clamp(Math.round(parsed), GRACE_MIN_S, GRACE_MAX_S) * 1000;
    if (nextMs === graceMs) return graceMs;

    graceMs = nextMs;

    // A new grace period applies to the episode in progress too: if the
    // user has already been away for longer than the new value, the next
    // evaluation promotes GRACE to DISTRACTED (or drops back to GRACE).
    each('[data-distraction-setting="grace"]', function (el) {
      if (el.value !== String(Math.round(graceMs / 1000))) {
        el.value = String(Math.round(graceMs / 1000));
      }
    });

    react();
    return graceMs;
  }

  function onPageHide(event) {
    if (event && event.persisted) return;     // bfcache keeps the page alive
    var now = Date.now();
    stopTicker();
    cameraActive = false;
    cameraState = 'off';
    measuring = false;
    closeDistraction(now);
    freezeBucket(now);
    awaySince = null;
    forwardSince = null;
    state = STATE.UNKNOWN;
    render();
  }

  /** Full reset: used by cleanup and from the console. */
  function reset() {
    var now = Date.now();
    stopTicker();
    cameraActive = false;
    sessionActive = false;
    tracking = false;
    measuring = false;
    lastSignature = '';
    closeDistraction(now);
    resetAccumulators();
    lastSessionData = null;
    awaySince = null;
    awayReason = null;
    forwardSince = null;
    bucket = null;
    bucketSince = now;
    state = STATE.UNKNOWN;
    stateSince = now;
    render(now);
  }

  /** Detach every listener this module added (used on unload). */
  function dispose() {
    unsubscribers.forEach(function (off) { off(); });
    unsubscribers = [];
    document.removeEventListener('visibilitychange', react);
    attached = false;
    stopTicker();
  }

  /* ---------- Exports --------------------------------------------------- */

  var PIPELINE = [
    'camera.js',
    'faceDetection.js',
    'attention.js',
    'distraction.js',
    'focusEngine.js',
  ];

  var api = {
    STATE: STATE,
    REASON: REASON,
    LABELS: LABELS,
    DEFAULT_GRACE_SECONDS: DEFAULT_GRACE_S,
    GRACE_MIN_SECONDS: GRACE_MIN_S,
    GRACE_MAX_SECONDS: GRACE_MAX_S,

    isImplemented: function () { return true; },
    getState: getState,
    getSessionData: getSessionData,
    isMeasuring: function (now) { return getSessionData(now).measuring === true; },
    getLastSessionData: function () {
      return lastSessionData ? Object.assign({}, lastSessionData) : null;
    },
    getEvents: function () { return events.map(cloneEvent); },
    getOpenEvent: function () { return openEvent ? cloneEvent(openEvent) : null; },
    getConfig: function () {
      return { graceMs: graceMs, stableMs: stableMs, tickMs: TICK_MS, tracking: tracking };
    },
    setGracePeriod: setGracePeriod,

    on: on,
    render: render,
    reset: reset,
    dispose: dispose,
    pipeline: PIPELINE.slice(),
  };

  global.FocusGuardDistraction = api;
  if (global.FocusGuard) global.FocusGuard.distraction = api;
  else global.FocusGuard = { distraction: api };

  function init() {
    bindSettings();
    render();
    attach(0);
    global.addEventListener('pagehide', onPageHide);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
