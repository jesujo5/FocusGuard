/* =====================================================================
   FocusGuard — js/attention.js
   Phase 6: approximate HEAD DIRECTION from local face landmarks.

   What this file does — and what it refuses to claim:
     * It reads the raw, local landmark/pose samples that
       js/faceDetection.js already produced (MediaPipe FaceLandmarker).
     * It estimates an approximate head direction:
         FORWARD · LEFT · RIGHT · UP · DOWN
       plus FACE_MISSING (no face in frame) and UNKNOWN (no usable
       reading yet: camera off, model loading, first frames...).
     * It estimates the *direction of the head*, nothing else. It does
       not know where the eyes look, whether the user is reading,
       distracted or focused. No score, no timer, no alarm.

   Privacy: this file never touches the camera or the network. It only
   transforms numbers that are already in this tab.

   ---- Pipeline --------------------------------------------------------
     js/camera.js         webcam lifecycle → MediaStream
         ↓
     js/faceDetection.js  presence + landmarks + 4x4 pose matrix
         ↓  on('sample')                 on('change')
     js/attention.js      ← this file: angles → smoothing → direction
         ↓  [data-head-status] / [data-head-status-text]
     (later: distraction.js → focusEngine.js)

   ---- How the direction is estimated ---------------------------------
     1. The model's facial transformation matrix maps a canonical 3D
        face model into the camera. Its rotation part tells us where the
        face is pointing. MediaPipe stores that 4x4 matrix column-major
        (the translation row reads as 0,0,0 when read row-major), so the
        face-forward axis R · (0, 0, 1) lives at data[8..10]. Its
        horizontal component is yaw, its vertical component is pitch.
     2. If the matrix is missing, a landmark-ratio fallback is used:
        the nose position relative to the eyes/face oval gives the same
        two angles, coarser but workable.
     3. Both angles are smoothed (rolling median) and only a value that
        clearly leaves the forward zone is reported, so small natural
        movements cannot flicker the row.

   ---- DOM contract ----------------------------------------------------
     [data-head-status]        gets data-head-state (drives the colour)
     [data-head-status-text]   the label: Forward / Looking Left / ...

   Console:
     FocusGuard.attention.getState()   // direction, angles, sample counts
     FocusGuard.attention.getPose()    // latest smoothed angles
   ===================================================================== */

(function (global) {
  'use strict';

  /* ---------- Configuration ---------------------------------------- */

  // Zones in degrees. Between the two values sits a deliberate dead
  // zone that keeps the previous reading, so a head that hovers just
  // outside the forward zone cannot flip the label back and forth.
  // Calibrated against real photos: faces aimed at the screen measured
  // within ±2° of yaw, while the pitch reading carried a personal bias
  // (−2°..−18° across the reference photos), so the pitch zone is wider
  // on purpose — a natural downward bias must not read as DOWN.
  var YAW_FORWARD_DEG = 10;    // inside this: clearly facing the screen
  var YAW_TURN_DEG = 16;       // beyond this: a deliberate turn
  var PITCH_FORWARD_DEG = 14;
  var PITCH_TURN_DEG = 20;

  // Smoothing: median over a short rolling window (~1 s at 5 samples/s)
  // plus N consecutive agreeing classifications before the label moves.
  var SMOOTH_WINDOW = 5;
  var CONFIRM_FRAMES = 3;

  // Calibration constants: they only encode which way the model's axes
  // point, so the labels match the *user's* point of view. Verified
  // against the landmark model: a clock-wise head roll reads positive,
  // and the camera +x axis points to the right of the image, so the
  // user's left turn adds +x to the face-forward vector.
  var YAW_SIGN = 1;      // + = the user turned their head to their left
  var PITCH_SIGN = 1;    // + = the user is looking up

  var DIRECTION = {
    FORWARD: 'forward',
    LEFT: 'left',
    RIGHT: 'right',
    UP: 'up',
    DOWN: 'down',
    FACE_MISSING: 'face-missing',
    UNKNOWN: 'unknown',
  };

  var LABELS = {
    forward: 'Forward',
    left: 'Looking Left',
    right: 'Looking Right',
    up: 'Looking Up',
    down: 'Looking Down',
    'face-missing': 'Face Missing',
    unknown: 'Unknown',
  };

  /* ---------- Live state -------------------------------------------- */

  var direction = DIRECTION.UNKNOWN;
  var candidate = DIRECTION.UNKNOWN;
  var candidateStreak = 0;

  var yawWindow = [];
  var pitchWindow = [];

  var lastPose = null;       // { yaw, pitch, source, at }
  var samplesSeen = 0;
  var lastChangeAt = 0;
  var lastSignature = '';
  var lastFaceStatus = 'off';

  var handlers = { change: [] };

  /* ---------- Tiny helpers ------------------------------------------ */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function median(values) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function push(window, value) {
    window.push(value);
    if (window.length > SMOOTH_WINDOW) window.shift();
  }

  function degrees(radians) { return radians * 180 / Math.PI; }

  function on(eventName, handler) {
    if (!handlers[eventName]) return function () {};
    handlers[eventName].push(handler);
    return function () {
      var list = handlers[eventName];
      var index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    };
  }

  /* ---------- Pose estimation --------------------------------------- */

  /**
   * Head angles from the model's 4x4 facial transformation matrix.
   * The data is column-major (element (row, col) is data[col * 4 + row]),
   * so the rotation part is [[0,4,8],[1,5,9],[2,6,10]]. The canonical
   * face looks along its own +Z axis, so R · (0, 0, 1) — the third
   * column, data[8..10] — is the direction the face is pointing in
   * camera space. Its horizontal part is yaw, its vertical part pitch.
   * @returns {{yaw: number, pitch: number, source: string}|null}
   */
  function poseFromMatrix(data) {
    if (!data || data.length < 16) return null;

    var fx = data[8];
    var fy = data[9];
    var fz = data[10];

    // A rotation vector has unit length; anything else is not a pose.
    var norm = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (!(norm > 0.5 && norm < 1.5)) return null;

    var horizontal = Math.sqrt(fx * fx + fz * fz) || 1e-6;
    var yaw = degrees(Math.atan2(fx, Math.abs(fz))) * YAW_SIGN;
    var pitch = degrees(Math.atan2(fy, horizontal)) * PITCH_SIGN;

    return { yaw: yaw, pitch: pitch, source: 'matrix' };
  }

  /**
   * Coarser fallback when the pose matrix is unavailable: the nose
   * position relative to the eye line and the face oval. Only used to
   * keep the row alive; the matrix path is the one that is validated.
   */
  function poseFromLandmarks(marks) {
    if (!marks || marks.length < 264) return null;

    var leftEye = marks[33];
    var rightEye = marks[263];
    var nose = marks[1];
    var chin = marks[152];
    var crown = marks[10];
    if (!leftEye || !rightEye || !nose || !chin || !crown) return null;

    var eyeMidX = (leftEye.x + rightEye.x) / 2;
    var eyeMidY = (leftEye.y + rightEye.y) / 2;
    var eyeDist = Math.sqrt(Math.pow(rightEye.x - leftEye.x, 2) +
      Math.pow(rightEye.y - leftEye.y, 2));
    if (!(eyeDist > 0.001)) return null;

    // Frontal faces measure a small offset because the nose is not
    // exactly between the eye corners in 2D; on the reference photos the
    // vertical ratio sat at ~0.22 and grew when the head looked down.
    var yawRatio = (nose.x - eyeMidX) / eyeDist;
    var yaw = degrees(Math.atan2(yawRatio, 1)) * YAW_SIGN;

    var faceHeight = Math.abs(chin.y - crown.y) || 1e-6;
    var pitchRatio = (nose.y - eyeMidY) / faceHeight;
    var pitch = degrees(Math.atan2(0.22 - pitchRatio, 1)) * PITCH_SIGN;

    return { yaw: yaw, pitch: pitch, source: 'landmarks' };
  }

  /* ---------- Classification ---------------------------------------- */

  /**
   * Maps smoothed angles to a direction. The dead zone returns the
   * current reading so borderline poses never cause a flip-flop.
   */
  function classify(yaw, pitch, current) {
    var ay = Math.abs(yaw);
    var ap = Math.abs(pitch);

    if (ay <= YAW_FORWARD_DEG && ap <= PITCH_FORWARD_DEG) return DIRECTION.FORWARD;
    if (ay >= YAW_TURN_DEG && ay >= ap) {
      return yaw > 0 ? DIRECTION.LEFT : DIRECTION.RIGHT;
    }
    if (ap >= PITCH_TURN_DEG && ap > ay) {
      return pitch > 0 ? DIRECTION.UP : DIRECTION.DOWN;
    }
    if (current === DIRECTION.FORWARD || current === DIRECTION.LEFT ||
        current === DIRECTION.RIGHT || current === DIRECTION.UP ||
        current === DIRECTION.DOWN) {
      return current;
    }
    return DIRECTION.FORWARD;
  }

  /* ---------- The sample pipeline ----------------------------------- */

  function handleSample(sample) {
    if (!sample) return;

    if (!sample.present) {
      // Presence itself is debounced by faceDetection.js. The change
      // handler reports FACE_MISSING; here we only drop stale angles.
      resetWindows();
      return;
    }

    var pose = poseFromMatrix(sample.matrix) ||
      poseFromLandmarks(sample.landmarks);
    if (!pose) return;

    samplesSeen += 1;
    push(yawWindow, pose.yaw);
    push(pitchWindow, pose.pitch);

    var yaw = median(yawWindow);
    var pitch = median(pitchWindow);
    lastPose = {
      yaw: yaw, pitch: pitch, source: pose.source,
      rawYaw: pose.yaw, rawPitch: pose.pitch, at: sample.at || Date.now(),
    };

    var next = classify(yaw, pitch, direction);
    if (next === direction) {
      candidate = next;
      candidateStreak = 0;
    } else if (next === candidate) {
      candidateStreak += 1;
    } else {
      candidate = next;
      candidateStreak = 1;
    }

    if (candidateStreak >= CONFIRM_FRAMES && candidate !== direction) {
      commit(candidate);
    } else {
      render();   // keep the angle readout fresh for debugging
    }
  }

  function resetWindows() {
    yawWindow.length = 0;
    pitchWindow.length = 0;
    candidate = direction;
    candidateStreak = 0;
    lastPose = null;
  }

  function commit(next) {
    if (next === direction) return;
    direction = next;
    lastChangeAt = Date.now();
    candidate = next;
    candidateStreak = 0;
    emit();
  }

  /* ---------- Following faceDetection -------------------------------- */

  function handleFaceChange(snapshot) {
    lastFaceStatus = (snapshot && snapshot.status) ? snapshot.status : 'off';
    var face = snapshot && snapshot.face;

    if (lastFaceStatus === 'missing' || face === 'missing') {
      resetWindows();
      commit(DIRECTION.FACE_MISSING);
      return;
    }

    if (lastFaceStatus === 'detected') return;   // samples drive the row

    // Camera off / starting, model loading or failed, first frames.
    resetWindows();
    commit(DIRECTION.UNKNOWN);
  }

  function attach(tries) {
    var detection = global.FocusGuard && global.FocusGuard.faceDetection;
    if (!detection || typeof detection.on !== 'function') {
      if (tries < 25) {
        global.setTimeout(function () { attach(tries + 1); }, 120);
      }
      return;
    }
    detection.on('sample', handleSample);
    detection.on('change', handleFaceChange);
    handleFaceChange(detection.getState());
  }

  function onPageHide(event) {
    if (event && event.persisted) return;   // bfcache keeps the page alive
    resetWindows();
    direction = DIRECTION.UNKNOWN;
    emit();
  }

  /* ---------- Status & rendering ------------------------------------- */

  function getState() {
    return {
      direction: direction,
      label: LABELS[direction] || 'Unknown',
      faceStatus: lastFaceStatus,
      yaw: lastPose ? lastPose.yaw : null,
      pitch: lastPose ? lastPose.pitch : null,
      poseSource: lastPose ? lastPose.source : null,
      samplesSeen: samplesSeen,
      windowSize: SMOOTH_WINDOW,
      confirmFrames: CONFIRM_FRAMES,
      thresholds: {
        yawForward: YAW_FORWARD_DEG, yawTurn: YAW_TURN_DEG,
        pitchForward: PITCH_FORWARD_DEG, pitchTurn: PITCH_TURN_DEG,
      },
      lastChangeAt: lastChangeAt,
      isImplemented: true,
      signature: [direction, lastFaceStatus,
        lastPose ? lastPose.source : '-'].join('|'),
    };
  }

  function emit() {
    var snapshot = getState();
    if (snapshot.signature === lastSignature) return;
    lastSignature = snapshot.signature;
    render(snapshot);
    (handlers.change || []).forEach(function (fn) { fn(snapshot); });
  }

  function render(snapshot) {
    var data = snapshot || getState();

    each('[data-head-status]', function (el) {
      el.dataset.headState = data.direction;
    });

    each('[data-head-status-text]', function (el) {
      el.textContent = data.label;
    });
  }

  /* ---------- Wiring -------------------------------------------------- */

  var PIPELINE = [
    'camera.js',
    'faceDetection.js',
    'attention.js',
    'distraction.js',
    'focusEngine.js',
  ];

  var api = {
    DIRECTION: DIRECTION,
    isImplemented: function () { return true; },
    getState: getState,
    getPose: function () { return lastPose ? Object.assign({}, lastPose) : null; },
    reset: function () { resetWindows(); commit(DIRECTION.UNKNOWN); },
    on: on,
    render: render,
    pipeline: PIPELINE.slice(),
  };

  global.FocusGuardAttention = api;
  if (global.FocusGuard) global.FocusGuard.attention = api;
  else global.FocusGuard = { attention: api };

  function init() {
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
