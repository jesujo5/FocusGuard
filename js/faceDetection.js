/* =====================================================================
   FocusGuard — js/faceDetection.js
   Phase 5: real, on-device face presence detection (public API kept).
   Phase 6: the underlying model is now MediaPipe Tasks Vision
            "FaceLandmarker" (BlazeFace short-range detector + 478-point
            face landmarks + an optional facial transformation matrix).
            Presence still works exactly as before; the extra landmark
            and matrix data is exposed to js/attention.js, which turns it
            into an approximate head direction.

   PRIVACY — what this file actually does:
     * It loads a pretrained face landmark model into this browser tab
       (MediaPipe Tasks Vision "FaceLandmarker").
       The library is fetched once from a public CDN and the model file
       once from Google's public model host; after that the browser
       caches them and everything runs offline.
     * Every frame is read straight out of the <video> element that
       js/camera.js already filled with the local webcam stream.
     * Inference runs inside this tab (WebAssembly + WebGL). No frame,
       no crop, no thumbnail and no detection result is ever uploaded:
       there is no fetch/POST/WebSocket in this file, no AI API, no
       Supabase, no external server.

   What it can honestly report:
       FACE_PRESENT  →  "Face Detected"
       FACE_MISSING  →  "Face Not Detected"

   It does NOT know whether the user is looking at the screen or whether
   they are focused. It only reports presence and hands raw, local
   landmarks to js/attention.js, which estimates head direction.

   ---- Pipeline --------------------------------------------------------
     js/camera.js           webcam lifecycle → MediaStream
         ↓  attaches the stream to [data-camera-video]
     js/faceDetection.js    ← this file. Reads frames locally at ~5 Hz
         ↓  FACE_PRESENT | FACE_MISSING  +  landmarks / pose matrix
     js/attention.js        → FORWARD | LEFT | RIGHT | UP | DOWN
     (later: distraction.js → focusEngine.js)

   ---- DOM contract ----------------------------------------------------
     [data-camera-video]       frames are read from these <video>s
     [data-camera-panel]       gets data-face-state (colours the dot)
     [data-face-status]        small status row, gets data-face-state
     [data-face-status-text]   the status label itself
     [data-face-note]          model line: loading / ready / unavailable

   States used by the CSS:
     off | starting | camera-active | loading | detecting |
     detected | missing | error

   Console:
     FocusGuard.faceDetection.getState()
     FocusGuard.faceDetection.getSample()   // landmarks + pose matrix
     FocusGuard.faceDetection.start() / .stop() / .detect(video)

   Events:
     on('change', fn)   the status snapshot shown by the UI
     on('sample', fn)   one per processed frame: { present, landmarks, matrix }
   ===================================================================== */

(function (global) {
  'use strict';

  /* ---------- Configuration ---------------------------------------- */

  // Pinned, so a CDN release can never change behaviour under our feet.
  var TASKS_VISION_VERSION = '0.10.14';
  var TASKS_VISION_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' +
    TASKS_VISION_VERSION;
  var MODULE_URL = TASKS_VISION_BASE + '/vision_bundle.mjs';
  var WASM_PATH = TASKS_VISION_BASE + '/wasm';
  var MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/' +
    'face_landmarker/face_landmarker/float16/1/face_landmarker.task';

  var DETECT_INTERVAL_MS = 200;   // ≈5 detections per second — smooth and light
  var MIN_DETECTION_CONFIDENCE = 0.5;
  var MIN_PRESENCE_CONFIDENCE = 0.5;
  var MIN_TRACKING_CONFIDENCE = 0.5;
  var PRESENT_CONFIRM = 2;        // consecutive frames before "detected"
  var MISSING_CONFIRM = 3;        // consecutive frames before "not detected"
  var MAX_INFERENCE_ERRORS = 3;   // then the layer gives up (the app keeps going)
  var CAMERA_RETRY_MS = 120;      // waiting for camera.js during boot
  var CAMERA_RETRY_LIMIT = 25;

  /** What we know about the user's face. */
  var FACE = { PRESENT: 'present', MISSING: 'missing', UNKNOWN: 'unknown' };

  /** The status the UI shows. */
  var STATE = {
    OFF: 'off',
    STARTING: 'starting',
    CAMERA_ACTIVE: 'camera-active',
    LOADING: 'loading',
    DETECTING: 'detecting',
    DETECTED: 'detected',
    MISSING: 'missing',
    ERROR: 'error',
  };

  var LABELS = {
    off: 'Camera Off',
    starting: 'Camera Starting',
    'camera-active': 'Camera Active',
    loading: 'Detection Loading',
    detecting: 'Detecting Face',
    detected: 'Face Detected',
    missing: 'Face Not Detected',
    error: 'Detection Error',
  };

  /* ---------- Live state ------------------------------------------- */

  var cameraState = 'off';     // mirrored from js/camera.js
  var modelState = 'idle';     // idle | loading | ready | error
  var face = FACE.UNKNOWN;     // present | missing | unknown
  var faceCount = 0;
  var errorMessage = '';

  var running = false;         // is the detection layer supposed to run?
  var loopHandle = 0;          // exactly one rAF handle — never more
  var lastFrameAt = 0;         // throttles inference to DETECT_INTERVAL_MS
  var lastTimestamp = 0;       // model timestamps must always increase

  var detector = null;
  var detectorPromise = null;  // in-flight init, so we never build it twice
  var cpuFallbackTried = false;
  var lastSample = null;       // { at, present, landmarks, matrix }

  var presentStreak = 0;
  var missingStreak = 0;
  var inferenceErrors = 0;
  var framesProcessed = 0;
  var lastVerdictAt = 0;
  var lastSignature = '';

  var handlers = { change: [], sample: [] };

  /* ---------- Tiny helpers ----------------------------------------- */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function clock() {
    return (global.performance && global.performance.now)
      ? global.performance.now()
      : Date.now();
  }

  function nextTimestamp() {
    var now = clock();
    if (now <= lastTimestamp) now = lastTimestamp + 1;
    lastTimestamp = now;
    return lastTimestamp;
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

  /* ---------- Model loading (once per page) ------------------------- */

  /**
   * Loads the detector the first time it is needed. Calling this again
   * reuses the same instance — the model is never built twice.
   * @returns {Promise<Object|null>} the detector, or null when unavailable
   */
  function ensureModel() {
    if (detector) return Promise.resolve(detector);
    if (detectorPromise) return detectorPromise;

    modelState = 'loading';
    errorMessage = '';
    emit();

    detectorPromise = createDetector().then(function (created) {
      detector = created;
      modelState = 'ready';
      errorMessage = '';
      emit();
      return created;
    }).catch(function (error) {
      // Reset so a later Start can retry (for example when the network is back).
      detectorPromise = null;
      modelState = 'error';
      errorMessage = describeError(error);
      console.warn('FocusGuard: face detection could not be loaded —', error);
      emit();
      return null;
    });

    return detectorPromise;
  }

  function createDetector() {
    return import(MODULE_URL).then(function (vision) {
      return vision.FilesetResolver.forVisionTasks(WASM_PATH).then(function (fileset) {
        return buildDetector(vision, fileset, 'GPU').catch(function () {
          // Plenty of machines only support the CPU (WASM) delegate.
          return buildDetector(vision, fileset, 'CPU');
        });
      });
    });
  }

  function buildDetector(vision, fileset, delegate) {
    var options = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: delegate },
      runningMode: 'VIDEO',            // frames come from a <video> element
      numFaces: 1,                     // the person in front of the screen
      minFaceDetectionConfidence: MIN_DETECTION_CONFIDENCE,
      minFacePresenceConfidence: MIN_PRESENCE_CONFIDENCE,
      minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
      outputFaceBlendshapes: false,
      // The 4x4 head-pose matrix js/attention.js reads its angles from.
      outputFacialTransformationMatrixes: true,
    };
    // The web build returns a promise; Promise.resolve also covers a
    // synchronous return, so both shapes work.
    return Promise.resolve(vision.FaceLandmarker.createFromOptions(fileset, options));
  }

  function describeError(error) {
    var text = (error && (error.message || error.name)) || '';
    text = String(text).replace(/\s+/g, ' ').trim();
    if (text.length > 90) text = text.slice(0, 87) + '…';
    return text;
  }

  /* ---------- The one detection loop -------------------------------- */

  function startLoop() {
    if (loopHandle) return;      // already looping — never start a second one
    loopHandle = global.requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (loopHandle) {
      global.cancelAnimationFrame(loopHandle);
      loopHandle = 0;
    }
  }

  function loop() {
    if (!running) { loopHandle = 0; return; }
    loopHandle = global.requestAnimationFrame(loop);

    var now = clock();
    if (now - lastFrameAt < DETECT_INTERVAL_MS) return;  // throttle
    lastFrameAt = now;

    // requestAnimationFrame already pauses in a hidden tab; this covers the rest.
    if (document.hidden) return;

    processFrame();
  }

  function processFrame() {
    if (!detector) return;                    // loading, or unavailable
    var video = pickVideo();
    if (!video || !videoHasFrames(video)) return;  // no camera frames yet

    try {
      var result = detector.detectForVideo(video, nextTimestamp());
      inferenceErrors = 0;
      framesProcessed += 1;
      applyResult(result);
    } catch (error) {
      handleInferenceError(error);
    }
  }

  function applyResult(result) {
    var marks = (result && result.faceLandmarks) ? result.faceLandmarks : [];
    var count = marks.length;
    var matrix = null;
    if (result && result.facialTransformationMatrixes &&
        result.facialTransformationMatrixes.length > 0) {
      matrix = result.facialTransformationMatrixes[0].data || null;
    }

    // One sample per processed frame: raw, local data for js/attention.js.
    lastSample = {
      at: Date.now(),
      present: count > 0,
      landmarks: count > 0 ? marks[0] : null,
      matrix: count > 0 ? matrix : null,
    };
    emitSample(lastSample);

    if (count > 0) { presentStreak += 1; missingStreak = 0; }
    else { missingStreak += 1; presentStreak = 0; }

    // Requiring a couple of agreeing frames only removes flicker — it is
    // not an attention rule and it never gates the timer or the session.
    if (presentStreak >= PRESENT_CONFIRM) commit(FACE.PRESENT, count);
    else if (missingStreak >= MISSING_CONFIRM) commit(FACE.MISSING, 0);
    else emit();  // first frames: still "Detecting Face"
  }

  function emitSample(sample) {
    (handlers.sample || []).forEach(function (fn) { fn(sample); });
  }

  function commit(nextFace, count) {
    face = nextFace;
    faceCount = count;
    lastVerdictAt = Date.now();
    emit();
  }

  function handleInferenceError(error) {
    // The GPU delegate often fails on the very first frames on machines
    // without usable WebGL. Swap to the CPU delegate exactly once.
    if (!cpuFallbackTried) {
      console.warn('FocusGuard: face detection switching to the CPU delegate —', error);
      cpuFallbackTried = true;
      closeDetector();
      detectorPromise = null;
      modelState = 'idle';
      inferenceErrors = 0;
      ensureModel();
      return;
    }

    inferenceErrors += 1;
    if (inferenceErrors < MAX_INFERENCE_ERRORS) return;

    // Stop cleanly. The camera and every other FocusGuard system keep working.
    running = false;
    stopLoop();
    closeDetector();
    detectorPromise = null;
    cpuFallbackTried = false;
    modelState = 'error';
    errorMessage = 'Processing stopped after repeated errors.';
    console.warn('FocusGuard: face detection stopped —', error);
    emit();
  }

  function closeDetector() {
    if (detector && typeof detector.close === 'function') {
      try { detector.close(); } catch (error) { /* already unusable */ }
    }
    detector = null;
  }

  /* ---------- Reading the camera ------------------------------------ */

  function pickVideo() {
    var videos = document.querySelectorAll('[data-camera-video]');
    var fallback = null;
    for (var i = 0; i < videos.length; i += 1) {
      var video = videos[i];
      if (!video.srcObject) continue;
      // Prefer the visible panel (dashboard or Focus Mode).
      if (video.offsetParent || video.getClientRects().length) return video;
      if (!fallback) fallback = video;
    }
    return fallback;
  }

  function videoHasFrames(video) {
    return video.readyState >= 2 && video.videoWidth > 0 &&
      !video.paused && !video.ended;
  }

  /* ---------- Start / stop ------------------------------------------ */

  /**
   * Begins reading frames. Idempotent: calling it twice never creates a
   * second loop and never rebuilds the model.
   * @param {HTMLVideoElement} [videoEl] element supplied by camera.js
   * @returns {Promise<boolean>} true when frames are being processed
   */
  function start(videoEl) {
    if (running) return Promise.resolve(true);  // one loop per camera session

    var video = videoEl || pickVideo();
    if (!video) return Promise.resolve(false);  // no stream to read yet

    running = true;
    presentStreak = 0;
    missingStreak = 0;
    inferenceErrors = 0;
    face = FACE.UNKNOWN;      // a fresh camera session starts from scratch
    faceCount = 0;
    lastSample = null;
    emit();

    return ensureModel().then(function (created) {
      if (!created) {          // model unavailable — the camera still works
        running = false;
        emit();
        return false;
      }
      if (!running) return false;  // stopped while the model was loading
      startLoop();
      emit();
      return true;
    });
  }

  /**
   * Stops processing and clears the verdict. The webcam itself is owned by
   * js/camera.js. The loaded model stays warm on purpose: rebuilding it on
   * every Start would re-download and re-initialise it. dispose() is the
   * full teardown.
   */
  function stop() {
    running = false;
    stopLoop();
    presentStreak = 0;
    missingStreak = 0;
    inferenceErrors = 0;
    face = FACE.UNKNOWN;
    faceCount = 0;
    lastVerdictAt = 0;
    lastSample = null;
    emit();
  }

  /** Full teardown, including the model. Used when the page is unloaded. */
  function dispose() {
    stop();
    closeDetector();
    detectorPromise = null;
    cpuFallbackTried = false;
    modelState = 'idle';
    errorMessage = '';
    framesProcessed = 0;
    emit();
  }

  /**
   * One-shot detection, handy in the console. The loop is the normal path.
   * @param {HTMLVideoElement} [videoEl] defaults to the live camera element
   * @param {function} [callback] optional, receives the result
   * @returns {Promise<{face: string, count: number, at: number}|null>}
   */
  function detect(videoEl, callback) {
    var video = videoEl || pickVideo();
    var promise;

    if (!video || !videoHasFrames(video)) {
      promise = Promise.resolve(null);
    } else {
      promise = ensureModel().then(function (created) {
        if (!created) return null;
        try {
          return summarize(created.detectForVideo(video, nextTimestamp()));
        } catch (error) {
          console.warn('FocusGuard: one-shot face detection failed —', error);
          return null;
        }
      });
    }

    if (typeof callback === 'function') {
      promise.then(function (result) { callback(result); });
    }
    return promise;
  }

  function summarize(result) {
    var count = (result && result.faceLandmarks) ? result.faceLandmarks.length : 0;
    return { face: count > 0 ? FACE.PRESENT : FACE.MISSING, count: count, at: Date.now() };
  }

  /** The latest raw sample (landmarks + pose matrix) from the model. */
  function getSample() {
    return lastSample;
  }

  /* ---------- Status & rendering ------------------------------------ */

  /** The single source of truth for what the UI shows. */
  function currentStatus() {
    if (cameraState === 'starting') return STATE.STARTING;
    if (cameraState !== 'active') return STATE.OFF;
    if (modelState === 'error') return STATE.ERROR;
    if (modelState === 'loading') return STATE.LOADING;
    if (face === FACE.PRESENT) return STATE.DETECTED;
    if (face === FACE.MISSING) return STATE.MISSING;
    if (running) return STATE.DETECTING;
    return STATE.CAMERA_ACTIVE;   // camera live, this layer not engaged
  }

  function noteText() {
    if (modelState === 'loading') return 'Loading face detection…';
    if (modelState === 'error') {
      return errorMessage
        ? 'Face detection unavailable — ' + errorMessage
        : 'Face detection unavailable';
    }
    if (modelState === 'ready') return 'Face detection ready';
    if (running) return 'Starting face detection…';
    if (cameraState === 'active') return 'Camera is on — face detection is not running.';
    return 'Face detection is off.';
  }

  function getState() {
    var status = currentStatus();
    return {
      status: status,
      label: LABELS[status],
      note: noteText(),
      face: face,                 // present | missing | unknown
      faceCount: faceCount,
      cameraState: cameraState,
      modelState: modelState,
      modelUrl: MODEL_URL,
      isRunning: running,
      loopActive: loopHandle !== 0,
      isImplemented: true,
      hasSample: lastSample !== null,
      sampleAt: lastSample ? lastSample.at : 0,
      matrixAvailable: !!(lastSample && lastSample.matrix),
      framesProcessed: framesProcessed,
      lastVerdictAt: lastVerdictAt,
      errorMessage: errorMessage,
      signature: [status, face, faceCount, cameraState, modelState,
        running ? 1 : 0, errorMessage].join('|'),
    };
  }

  function emit() {
    var snapshot = getState();
    if (snapshot.signature === lastSignature) return;  // no needless DOM churn
    lastSignature = snapshot.signature;
    render(snapshot);
    (handlers.change || []).forEach(function (fn) { fn(snapshot); });
  }

  function render(snapshot) {
    var data = snapshot || getState();

    each('[data-camera-panel]', function (panel) {
      panel.dataset.faceState = data.status;
    });

    each('[data-face-status]', function (el) {
      el.dataset.faceState = data.status;
      el.classList.toggle('is-error', data.status === STATE.ERROR);
    });

    each('[data-face-status-text]', function (el) {
      el.textContent = data.label;
    });

    each('[data-face-note]', function (el) {
      el.textContent = data.note;
      el.classList.toggle('is-error', data.status === STATE.ERROR);
    });
  }

  /* ---------- Camera integration ------------------------------------ */

  /**
   * camera.js owns the webcam. We simply follow its state: whenever it
   * reports "active" we start reading frames, whenever it leaves that
   * state we stop processing and reset the verdict.
   */
  function syncFromCamera(snapshot) {
    cameraState = (snapshot && snapshot.state) ? snapshot.state : 'off';

    if (cameraState === 'active') {
      if (!running) start();     // idempotent — never a duplicate loop
    } else if (running) {
      stop();
    }
    emit();
  }

  function attachCamera(tries) {
    var camera = global.FocusGuard && global.FocusGuard.camera;
    if (!camera || typeof camera.on !== 'function') {
      // camera.js boots in the same tick, but stay defensive.
      if (tries < CAMERA_RETRY_LIMIT) {
        global.setTimeout(function () { attachCamera(tries + 1); }, CAMERA_RETRY_MS);
      }
      return;
    }
    camera.on('change', syncFromCamera);
    syncFromCamera(camera.getState());
  }

  function onPageHide(event) {
    if (event && event.persisted) return;  // bfcache keeps the page alive
    dispose();
  }

  /* ---------- Wiring ------------------------------------------------- */

  var PIPELINE = [
    'camera.js',
    'faceDetection.js',
    'attention.js',
    'distraction.js',
    'focusEngine.js',
  ];

  var api = {
    STATE: STATE,
    FACE: FACE,
    isImplemented: function () { return true; },
    start: start,
    stop: stop,
    dispose: dispose,
    detect: detect,
    on: on,
    getSample: getSample,
    getState: getState,
    render: render,
    pipeline: PIPELINE.slice(),
  };

  global.FocusGuardFaceDetection = api;
  if (global.FocusGuard) global.FocusGuard.faceDetection = api;
  else global.FocusGuard = { faceDetection: api };

  function init() {
    render();
    attachCamera(0);
    global.addEventListener('pagehide', onPageHide);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
