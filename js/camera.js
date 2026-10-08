/* =====================================================================
   FocusGuard — js/camera.js
   Webcam lifecycle: permission, start, stop, release.

   PRIVACY — what this file actually does:
     * getUserMedia() opens the local camera.
     * The resulting MediaStream is attached to <video> elements only.
     * Nothing in this file (or anywhere else in FocusGuard) uploads,
       posts, stores or transmits a frame. There is no network code here.
     * No face detection runs yet — that is js/faceDetection.js, still a
       placeholder for the next phase.

   ---- DOM contract -----------------------------------------------------
     [data-camera-panel]            the preview box; gets data-state
     [data-camera-video]            every <video> bound to the stream
     [data-camera-overlay-text]     message shown when the camera is off
     [data-camera-action="start"]   Start Camera button
     [data-camera-action="stop"]    Stop Camera button
     [data-camera-status]           status line
     [data-camera-status-pill]      status pill
     [data-camera-session-hint]     "monitoring available" note

   Possible states:
     off | starting | active | denied | error

   Console: FocusGuard.camera.start() / .stop() / .getState()
   ===================================================================== */

(function (global) {
  'use strict';

  var STATE = {
    OFF: 'off',
    STARTING: 'starting',
    ACTIVE: 'active',
    DENIED: 'denied',
    ERROR: 'error',
  };

  var LABELS = {
    off: 'Camera Off',
    starting: 'Camera Starting',
    active: 'Camera Active',
    denied: 'Camera Permission Denied',
    error: 'Camera Error',
  };

  var OVERLAY_TEXT = {
    off: 'Camera is off',
    starting: 'Starting camera…',
    active: 'Camera active',
    denied: 'Permission denied — allow the camera in your browser to continue.',
    error: 'Could not open the camera.',
  };

  var state = STATE.OFF;
  var stream = null;
  var errorMessage = '';
  // Bumped every time we start or stop, so a getUserMedia() that resolves
  // after the user hit Stop can never re-attach a stream we already gave up.
  var requestId = 0;

  var handlers = { change: [] };

  /* ---------- Events ---------- */

  function on(eventName, handler) {
    if (!handlers[eventName]) return function () {};
    handlers[eventName].push(handler);
    return function () {
      var list = handlers[eventName];
      var index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    };
  }

  function emit() {
    var snapshot = getState();
    (handlers.change || []).forEach(function (fn) {
      fn(snapshot);
    });
  }

  /* ---------- Reading state ---------- */

  function getState() {
    return {
      state: state,
      label: LABELS[state],
      isActive: state === STATE.ACTIVE,
      hasStream: !!stream,
      errorMessage: errorMessage,
      // Live monitoring only becomes relevant once a session is running.
      sessionActive: sessionIsActive(),
    };
  }

  /** True while a study session is running or paused. */
  function sessionIsActive() {
    var session = global.FocusGuard && global.FocusGuard.session;
    if (!session || typeof session.getState !== 'function') return false;
    return session.getState().isActive === true;
  }

  /* ---------- Render ---------- */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function render() {
    var snapshot = getState();

    each('[data-camera-panel]', function (panel) {
      panel.dataset.state = snapshot.state;
    });

    each('[data-camera-status]', function (el) {
      el.textContent = snapshot.state === STATE.ERROR && snapshot.errorMessage
        ? LABELS[snapshot.state] + ' — ' + snapshot.errorMessage
        : LABELS[snapshot.state];
      el.classList.toggle('is-error', snapshot.state === STATE.ERROR ||
        snapshot.state === STATE.DENIED);
    });

    each('[data-camera-status-pill]', function (el) {
      el.textContent = LABELS[snapshot.state];
      el.classList.toggle('pill--soft', snapshot.state === STATE.ACTIVE);
      el.classList.toggle('pill--muted', snapshot.state !== STATE.ACTIVE);
    });

    each('[data-camera-overlay-text]', function (el) {
      el.textContent = OVERLAY_TEXT[snapshot.state];
    });

    each('[data-camera-action="start"]', function (el) {
      el.disabled = snapshot.isActive || snapshot.state === STATE.STARTING;
    });
    each('[data-camera-action="stop"]', function (el) {
      // Available while a stream is live AND while the permission prompt is
      // still open, so the user can always back out.
      el.disabled = !snapshot.hasStream && snapshot.state !== STATE.STARTING;
    });

    each('[data-camera-session-hint]', function (el) {
      el.textContent = snapshot.sessionActive
        ? 'A study session is running — monitoring is available.'
        : 'Start a study session to make monitoring available.';
      el.classList.toggle('is-available', snapshot.sessionActive);
    });
  }

  /* ---------- Stream plumbing ---------- */

  function attachStream(mediaStream) {
    stream = mediaStream;
    each('[data-camera-video]', function (video) {
      video.srcObject = stream;
      // Some browsers need an explicit play() after assigning srcObject.
      var attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(function () {});
    });
  }

  function releaseStream() {
    if (stream) {
      stream.getTracks().forEach(function (track) {
        track.stop(); // turns the webcam light off
      });
      stream = null;
    }
    each('[data-camera-video]', function (video) {
      video.srcObject = null;
    });
  }

  /* ---------- Public controls ---------- */

  function start() {
    if (state === STATE.ACTIVE || state === STATE.STARTING) return Promise.resolve(null);

    errorMessage = '';
    state = STATE.STARTING;
    var id = ++requestId;
    emit();
    render();

    if (!global.navigator || !global.navigator.mediaDevices ||
        !global.navigator.mediaDevices.getUserMedia) {
      state = STATE.ERROR;
      errorMessage = 'Camera API not available in this browser.';
      emit();
      render();
      return Promise.resolve(null);
    }

    return global.navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 360 } },
      audio: false,
    }).then(function (mediaStream) {
      if (id !== requestId) {
        // The user pressed Stop (or left the session) while we were waiting.
        mediaStream.getTracks().forEach(function (track) { track.stop(); });
        return null;
      }

      attachStream(mediaStream);

      // If the user revokes permission from the browser UI mid-stream.
      mediaStream.getVideoTracks().forEach(function (track) {
        track.addEventListener('ended', function () {
          if (stream === mediaStream) stop();
        });
      });

      state = STATE.ACTIVE;
      emit();
      render();
      return mediaStream;
    }).catch(function (error) {
      if (id !== requestId) return null; // cancelled while the prompt was open

      var name = error && error.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' ||
          name === 'SecurityError') {
        state = STATE.DENIED;
        errorMessage = '';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        state = STATE.ERROR;
        errorMessage = 'No camera was found on this device.';
      } else {
        state = STATE.ERROR;
        errorMessage = 'The camera could not be started.';
      }
      releaseStream();
      emit();
      render();
      return null;
    });
  }

  function stop() {
    requestId += 1; // invalidate any request still waiting on the prompt
    releaseStream();
    state = STATE.OFF;
    errorMessage = '';
    emit();
    render();
  }

  function toggle() {
    if (state === STATE.ACTIVE || state === STATE.STARTING) stop();
    else start();
  }

  /* ---------- Wiring ---------- */

  function bind() {
    each('[data-camera-action="start"]', function (el) {
      el.addEventListener('click', start);
    });
    each('[data-camera-action="stop"]', function (el) {
      el.addEventListener('click', stop);
    });
  }

  function init() {
    bind();

    // Keep the "monitoring available" note in sync with the session, and
    // release the webcam when the user leaves the study session.
    var session = global.FocusGuard && global.FocusGuard.session;
    if (session && typeof session.on === 'function') {
      session.on('change', render);
      session.on('end', stop);
    }

    // Release the webcam when the tab is closed or navigated away.
    global.addEventListener('pagehide', stop);
    global.addEventListener('beforeunload', stop);

    render();

    if (global.FocusGuard) global.FocusGuard.camera = api;
    else global.FocusGuard = { camera: api };
  }

  var api = {
    STATE: STATE,
    start: start,
    stop: stop,
    toggle: toggle,
    on: on,
    getState: getState,
    render: render,
    /**
     * The ONE live MediaStream this module owns (Prompt 10.5). Other UI
     * (the Mini Focus Window) attaches this same object to its own
     * <video>, so showing the camera twice never opens a second webcam
     * capture — getUserMedia is still called exactly once here.
     * @returns {MediaStream|null}
     */
    getStream: function () { return stream; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
