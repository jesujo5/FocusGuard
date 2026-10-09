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
     FOCUSED        face detected, head at the screen, stable ~1.2 s
     DOWNWARD_STUDY the same focused time through a *moderate* downward
                    posture — paper, a notebook, handwriting — accepted
                    automatically from the very same camera pipeline
     GRACE          was focused, looked away, grace period not over yet
     DISTRACTED     looked away for longer than the grace period
     PHONE_USE      the user pressed "Using phone"; it is distraction,
                    pinned until they press "Resume study" — or the
                    session ends. Never claimed to be automatic.
     FACE_MISSING   no face in frame (already debounced by faceDetection)
     UNKNOWN        camera off, model loading/failed — nothing reliable

   ---- ONE automatic mode (Prompt 11) ---------------------------------
   There is no Screen/Notebook switch any more. Facing the screen and a
   stable, *moderate* downward posture are both read as studying, from the
   same camera → faceDetection → attention signals. Only an extreme
   downward angle (past STUDY_PITCH_MAX_DEG) or a downward angle whose
   orientation estimate is not reliable enough falls back to the normal
   head-away handling. Switching between the screen and the page is not a
   lapse: an interval that is already focused keeps its focused time and
   simply continues under the new posture.

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

     { id, startTime, endTime, duration,
       reason: 'HEAD_AWAY' | 'FACE_MISSING' | 'PHONE_USE' }

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
    // A *different* way of being focused: a stable, moderate downward
    // posture while writing on paper or reading a notebook. Accepted
    // automatically — there is no mode to pick.
    DOWNWARD_STUDY: 'downward-study',
    GRACE: 'grace',
    DISTRACTED: 'distracted',
    // The user told us directly that they picked up their phone. This is a
    // declared distraction, never a detected one.
    PHONE_USE: 'phone-use',
    FACE_MISSING: 'face-missing',
    UNKNOWN: 'unknown',
  };

  /**
   * Neutral, screen-facing wording. We measure whether the user looks at
   * the screen — never whether they are "concentrating".
   */
  var LABELS = {
    focused: 'Focused',
    'downward-study': 'Downward study',
    grace: 'Attention drifting',
    distracted: 'Distracted',
    'phone-use': 'Distracted — Phone Use',
    'face-missing': 'Face not detected',
    unknown: 'Detection unavailable',
  };

  /** Why an away episode happened. */
  var REASON = {
    HEAD_AWAY: 'HEAD_AWAY',
    FACE_MISSING: 'FACE_MISSING',
    PHONE_USE: 'PHONE_USE',
  };

  /** Fixed second line of the status row (the distracted one is live). */
  var DETAILS = {
    focused: '',
    'downward-study': 'Downward posture — paper, notebook or handwriting',
    grace: 'Returning to screen…',
    distracted: '',
    // Honest wording: the user marked this, the camera did not detect it.
    'phone-use': 'You marked this — not detected by the camera',
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

  /**
   * Monitoring mode. There is exactly one — INTELLIGENT — and the legacy
   * SCREEN / NOTEBOOK names are kept only so old stored settings, console
   * snippets and tests keep working. Every value resolves to the same
   * automatic reading, so nothing here asks the user to choose.
   */
  var MODES = {
    SCREEN: 'screen',
    NOTEBOOK: 'notebook',
    INTELLIGENT: 'intelligent',
  };
  var MODE_LABELS = {
    screen: 'Intelligent monitoring',
    notebook: 'Intelligent monitoring',
    intelligent: 'Intelligent monitoring',
  };
  var MONITORING_MODE = MODES.INTELLIGENT;

  /**
   * Automatic notebook-posture recognition.
   *
   * js/attention.js only reports DOWN once the pitch is past ~20°, so any
   * "down" reading already clears that floor. A downward posture counts as
   * studying while the head is still *moderately* down:
   *
   *   STUDY_PITCH_ENTER_DEG           the most a posture may be tilted to
   *                                   be ACCEPTED as studying at all
   *   STUDY_PITCH_LANDMARK_ENTER_DEG  the same for the coarser landmark
   *                                   fallback (no pose matrix) — stricter,
   *                                   because that angle is less reliable
   *   STUDY_PITCH_MAX_DEG             once accepted, the posture is only
   *                                   released past this angle. That gap is
   *                                   hysteresis: a head hovering on the
   *                                   boundary cannot flicker between
   *                                   focused and distracted.
   *
   * Past STUDY_PITCH_MAX_DEG (chin on chest, phone below the desk…) the
   * posture is deliberately NOT studying and falls back to the normal
   * head-away handling.
   */
  var STUDY_PITCH_ENTER_DEG = 42;
  var STUDY_PITCH_LANDMARK_ENTER_DEG = 34;
  var STUDY_PITCH_MAX_DEG = 48;

  /**
   * A very short face loss — the kind you get while leaning over a page —
   * is held back instead of being reported as "Face Not Detected". This
   * applies in every posture, automatically (Prompt 11).
   */
  var DEFAULT_PARTIAL_FACE_HOLD_MS = 1500;

  /* ---------- Module state ---------- */

  var state = STATE.UNKNOWN;
  var stateSince = 0;

  var awaySince = null;         // start of the current not-facing episode
  var awayReason = null;        // HEAD_AWAY | FACE_MISSING (current condition)
  var postureSince = null;      // when the current accepted posture began
  var acceptedPosture = null;   // 'forward' | 'downward' (the posture being timed)
  var studySince = null;        // start of the current run of study postures

  // Automatic monitoring + the manual phone override.
  var attentionMode = MONITORING_MODE;
  var partialFaceHoldMs = DEFAULT_PARTIAL_FACE_HOLD_MS;
  var missingHoldSince = null;   // when the face first left the frame
  var lastPosture = 'none';      // forward | downward | away | none
  var downwardCandidate = false; // downward posture, not yet accepted as study
  var phoneOverride = false;     // the user pressed "Using phone"
  var phoneOverrideSince = null; // the exact timestamp it started

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
  var handlers = { change: [], event: [], mode: [], override: [] };
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

  /** Latest smoothed pitch (degrees, + = looking up) from attention.js. */
  function readPitch() {
    var attention = module('attention');
    if (!attention || typeof attention.getState !== 'function') return null;
    var snapshot = attention.getState();
    return typeof snapshot.pitch === 'number' ? snapshot.pitch : null;
  }

  /** Where the latest head angles came from ('matrix' | 'landmarks' | null). */
  function readPoseSource() {
    var attention = module('attention');
    if (!attention || typeof attention.getState !== 'function') return null;
    var snapshot = attention.getState();
    return snapshot.poseSource || null;
  }

  /**
   * The study posture the current head reading represents.
   *   'forward'  the head is aimed at the screen
   *   'downward' a moderate, reliable downward angle — notebook or paper
   *   'away'     a deliberate turn, or a downward angle too steep / not
   *              reliable enough to call studying
   *   'none'     no face / no usable reading
   * Automatic: no mode is consulted, and the raw signals still come from
   * the one camera → faceDetection → attention pipeline.
   */
  function readPosture(direction) {
    if (direction === 'forward') return 'forward';
    if (direction !== 'down') return 'away';

    // No numerical angle → no verdict. We never invent a pitch.
    var pitch = readPitch();
    if (pitch === null) return 'away';

    // Hysteresis: a posture that is already accepted stays accepted until it
    // passes the wider release angle; a new one has to clear the stricter
    // entry angle first.
    var alreadyAccepted = acceptedPosture === 'downward' ||
      state === STATE.DOWNWARD_STUDY;
    var source = readPoseSource();
    var limit = alreadyAccepted
      ? STUDY_PITCH_MAX_DEG
      : (source === 'landmarks' ? STUDY_PITCH_LANDMARK_ENTER_DEG : STUDY_PITCH_ENTER_DEG);

    return Math.abs(pitch) <= limit ? 'downward' : 'away';
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
    // Downward study is real focused time — it just arrived through a
    // different posture. It feeds the same bucket as FOCUSED.
    if (stateName === STATE.DOWNWARD_STUDY) return 'focused';
    if (stateName === STATE.DISTRACTED) return 'distracted';
    // Declared phone use is distraction, and nothing else: no focused
    // time, no Focus Coins for the interval.
    if (stateName === STATE.PHONE_USE) return 'distracted';
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
      reason: awayReason === REASON.FACE_MISSING ? REASON.FACE_MISSING
        : awayReason === REASON.PHONE_USE ? REASON.PHONE_USE
        : REASON.HEAD_AWAY,
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

    if (next === STATE.FOCUSED || next === STATE.DOWNWARD_STUDY) {
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

    // The manual phone override outranks the camera. While it is on, the
    // state stays "Distracted — Phone Use" whatever the posture says — a
    // camera update can never clear it, only the user or the session end.
    if (phoneOverride) {
      if (awaySince === null) {
        awaySince = phoneOverrideSince || now;
        awayReason = REASON.PHONE_USE;
      }
      openDistraction(now);
      setState(STATE.PHONE_USE, now);
      publish(now);
      return;
    }

    var detection = readDetection();
    if (detection === 'unknown') {
      // Model loading/failed or no verdict yet: say so instead of guessing.
      clearEpisode(now);
      postureSince = null;
      setState(STATE.UNKNOWN, now);
      publish(now);
      return;
    }

    var direction = readDirection();
    var posture = detection === 'present' ? readPosture(direction) : 'none';
    lastPosture = posture;

    // A study posture — facing the screen, or a moderate downward angle —
    // is a focus candidate. Nothing about the session, the Pomodoro, the
    // score or the coins is touched here.
    if (posture === 'forward' || posture === 'downward') {
      awaySince = null;
      awayReason = null;
      missingHoldSince = null;

      // Two clocks:
      //   studySince    how long *any* study posture has been held without
      //                 a break — the "~1-2 s of stable posture" gate.
      //   postureSince  how long this particular posture has been held.
      if (studySince === null) studySince = now;
      if (postureSince === null || acceptedPosture !== posture) postureSince = now;
      acceptedPosture = posture;

      // Switching between the screen and the page is not a lapse in
      // attention: an interval that is already focused keeps its focused
      // time and simply carries on under the new posture — so wobbling the
      // head while writing never ends a distraction or restarts the clock.
      // A fresh interval, or one coming back from an away episode, still
      // has to hold a study posture steadily before it counts.
      var focusedAlready = state === STATE.FOCUSED || state === STATE.DOWNWARD_STUDY;
      var studyStable = now - studySince >= stableMs;
      var canFocus = focusedAlready || studyStable;

      downwardCandidate = posture === 'downward' && !canFocus;

      if (canFocus) {
        setState(posture === 'downward' ? STATE.DOWNWARD_STUDY : STATE.FOCUSED, now);
      } else if (state === STATE.DISTRACTED || state === STATE.FACE_MISSING ||
                 state === STATE.GRACE) {
        // On the way back: a candidate posture, not a verdict yet.
        setState(STATE.GRACE, now);
      }

      publish(now);
      return;
    }

    postureSince = null;
    acceptedPosture = null;
    studySince = null;
    downwardCandidate = false;

    // Face is there but no trustworthy direction yet — stay neutral.
    if (detection === 'present' && !isTurn(direction)) {
      clearEpisode(now);
      setState(STATE.UNKNOWN, now);
      publish(now);
      return;
    }

    // Face missing is its own condition, and its own reason.
    var condition = detection === 'missing' ? REASON.FACE_MISSING : REASON.HEAD_AWAY;

    // Partial-face tolerance: while writing or reading, the face often
    // half-leaves the frame for a moment (this is what used to flash "Face
    // Not Detected" the instant you bent further down). Such a short loss is
    // held back — no reading, so no verdict, no alarm, no distraction event
    // — instead of counting as face-missing. It applies to every posture now.
    // A loss longer than the hold is still honestly face-missing: a face the
    // camera cannot observe must never earn focused time.
    if (condition === REASON.FACE_MISSING) {
      if (missingHoldSince === null) missingHoldSince = now;
    } else {
      missingHoldSince = null;
    }

    if (condition === REASON.FACE_MISSING &&
        missingHoldSince !== null &&
        now - missingHoldSince < partialFaceHoldMs) {
      awaySince = null;
      awayReason = null;
      clearEpisode(now);
      setState(STATE.UNKNOWN, now);
      publish(now);
      return;
    }

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
    postureSince = null;
    acceptedPosture = null;
    studySince = null;
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
      postureSince = null;
      acceptedPosture = null;
      studySince = null;
      missingHoldSince = null;
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
      postureSince = null;
      acceptedPosture = null;
      studySince = null;
      // The session (or the camera) ended: a phone declaration does not
      // outlive it.
      phoneOverride = false;
      phoneOverrideSince = null;
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

      // The automatic monitoring mode + the posture it is interpreting.
      // attentionMode/attentionModeLabel are legacy names kept for the UI
      // and the stored settings; they always read as the one mode now.
      attentionMode: attentionMode,
      attentionModeLabel: MODE_LABELS[attentionMode],
      monitoringMode: MONITORING_MODE,
      monitoringModeLabel: MODE_LABELS[MONITORING_MODE],
      posture: lastPosture,
      downwardCandidate: downwardCandidate,
      studyPitchEnterDeg: STUDY_PITCH_ENTER_DEG,
      studyPitchLandmarkEnterDeg: STUDY_PITCH_LANDMARK_ENTER_DEG,
      studyPitchMaxDeg: STUDY_PITCH_MAX_DEG,
      notebookPitchMaxDeg: STUDY_PITCH_MAX_DEG,   // legacy name
      partialFaceHoldMs: partialFaceHoldMs,

      // The manual phone declaration.
      phoneOverride: phoneOverride,
      phoneOverrideSince: phoneOverrideSince,
      phoneOverrideDurationMs: phoneOverrideSince
        ? Math.max(0, now - phoneOverrideSince) : 0,

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
      signature: [state, awayReason || '-', tracking ? 'tracking' : 'status',
        attentionMode, phoneOverride ? 'phone' : ''].join('|'),
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

      // The mode the session ran in — kept for the in-memory snapshot.
      attentionMode: attentionMode,
      monitoringMode: MONITORING_MODE,
      phoneOverride: phoneOverride,
      phoneUseDuration: phoneOverrideSince ? seconds(now - phoneOverrideSince) : 0,
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

  /**
   * Legacy hook from Prompt 10.5, when the user could pick Screen study or
   * Notebook study. Monitoring is automatic now, so every value simply
   * resolves to the one intelligent mode; passing 'notebook' or 'screen'
   * can therefore never break the automatic reading, an old stored setting
   * or a console snippet. It touches no timer, session, score or coin.
   */
  function setAttentionMode(mode) {
    if (attentionMode !== MONITORING_MODE) {
      attentionMode = MONITORING_MODE;
      emit('mode', { mode: attentionMode, label: MODE_LABELS[attentionMode] });
      react();
    }
    return attentionMode;
  }

  /**
   * The manual "Using phone" distraction (Prompt 11).
   *
   * The camera genuinely cannot tell a phone from a notebook, so this never
   * pretends to detect one: the user says so, and the engine records it as
   * distraction from the exact timestamp the switch flipped.
   *
   *   on = true   stop counting focused time at `when`, open ONE distraction
   *               event with reason PHONE_USE, pin the state to PHONE_USE.
   *   on = false  close that event at `when`, then let the normal posture
   *               state machine re-decide from the *current* camera reading.
   *
   * While it is on, evaluate() short-circuits, so no camera update can
   * cancel it. It is cleared only here or when the session ends.
   */
  function setPhoneOverride(on, when) {
    var next = !!on;
    var now = when || Date.now();

    if (next === phoneOverride) {
      react();
      return phoneOverride;
    }

    phoneOverride = next;

    if (next) {
      phoneOverrideSince = now;
      // Bypass the grace period: the user declared this, we do not wait.
      awaySince = now;
      awayReason = REASON.PHONE_USE;
      // Drop any half-confirmed posture reading.
      postureSince = null;
      acceptedPosture = null;
      studySince = null;
      missingHoldSince = null;
      downwardCandidate = false;
      // Close any episode already in progress (e.g. a look-away that was
      // already distracted) at this exact instant, so the phone-use event
      // that follows carries its own reason and its own duration.
      closeDistraction(now);
      // Move the measured bucket at this instant, so the focused time stops
      // at the switch and the distraction time starts there.
      setState(STATE.PHONE_USE, now);
      openDistraction(now);
    } else {
      // Close the phone-use interval at the exact clear timestamp: the
      // distraction duration is the time really spent on the phone.
      closeDistraction(now);
      phoneOverrideSince = null;
      awaySince = null;
      awayReason = null;
      postureSince = null;
      acceptedPosture = null;
      studySince = null;
      missingHoldSince = null;
      // Hand back to the existing grace/distraction machine. The state goes
      // to GRACE — unclassified, never wrongly focused — and only a stable,
      // reliable study posture promotes it to FOCUSED from there.
      if (state === STATE.PHONE_USE) setState(STATE.GRACE, now);
      emit('override', { active: false, since: null });
      evaluate(now);
      return phoneOverride;
    }

    emit('override', { active: true, since: phoneOverrideSince });
    publish(now);
    return phoneOverride;
  }

  function setPartialFaceHold(ms) {
    var parsed = parseFloat(ms);
    if (!isFinite(parsed)) parsed = DEFAULT_PARTIAL_FACE_HOLD_MS;
    partialFaceHoldMs = clamp(Math.round(parsed), 0, 10000);
    react();
    return partialFaceHoldMs;
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
    awayReason = null;
    postureSince = null;
    acceptedPosture = null;
    studySince = null;
    missingHoldSince = null;
    downwardCandidate = false;
    phoneOverride = false;
    phoneOverrideSince = null;
    lastPosture = 'none';
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
    postureSince = null;
    acceptedPosture = null;
    studySince = null;
    missingHoldSince = null;
    downwardCandidate = false;
    phoneOverride = false;
    phoneOverrideSince = null;
    lastPosture = 'none';
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
    MODES: MODES,
    MODE_LABELS: MODE_LABELS,
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
      return {
        graceMs: graceMs, stableMs: stableMs, tickMs: TICK_MS, tracking: tracking,
        attentionMode: attentionMode,
        monitoringMode: MONITORING_MODE,
        studyPitchEnterDeg: STUDY_PITCH_ENTER_DEG,
        studyPitchLandmarkEnterDeg: STUDY_PITCH_LANDMARK_ENTER_DEG,
        studyPitchMaxDeg: STUDY_PITCH_MAX_DEG,
        notebookPitchMaxDeg: STUDY_PITCH_MAX_DEG,   // legacy name
        partialFaceHoldMs: partialFaceHoldMs,
        phoneOverride: phoneOverride,
        phoneOverrideSince: phoneOverrideSince,
      };
    },
    setGracePeriod: setGracePeriod,

    getAttentionMode: function () { return attentionMode; },
    getMonitoringMode: function () { return MONITORING_MODE; },
    setAttentionMode: setAttentionMode,
    setPartialFaceHold: setPartialFaceHold,

    // Manual phone distraction (Prompt 11).
    setPhoneOverride: setPhoneOverride,
    isPhoneOverride: function () { return phoneOverride; },
    getPhoneOverrideSince: function () { return phoneOverrideSince; },

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
