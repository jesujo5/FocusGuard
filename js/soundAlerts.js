/* =====================================================================
   FocusGuard — js/soundAlerts.js
   Prompt 10.5: unobtrusive sound cues for attention drift.

   The distraction engine (js/distraction.js) already knows when attention
   drifts; it just never made a sound. This module listens to its state
   changes and plays a short, synthesised cue:

     GRACE        → a soft "attention" cue (you looked away, the grace
                    period is running)
     DISTRACTED   → a firmer "distraction" cue (the grace period expired)
     FACE_MISSING → the same "distraction" cue (the face left the frame)
     back FOCUSED → an optional "return" cue, only after a distraction cue

   Nothing here records anything, and no audio file is downloaded: every
   tone is generated with the Web Audio API, exactly like the Pomodoro
   chime in js/timer-ui.js. It is one more synthesiser, not a second timer.

   ---- Cooldown --------------------------------------------------------
   Each cue kind has its own cooldown (default ALERT_COOLDOWN_MS = 15 s),
   so a GRACE cue and the DISTRACTED cue that follows it are both heard,
   while a burst of flickering states cannot nag. Tests can shrink the
   cooldown with setCooldownMs().

   ---- Privacy / non-regression ---------------------------------------
     * reads js/distraction.js state only — no camera, no network;
     * never touches the timer, the session, the score or the coins;
     * respects its own "Attention sound alerts" switch, stored with the
       other settings (see js/sync.js).

   Console:
     FocusGuard.soundAlerts.play('distraction')
     FocusGuard.soundAlerts.setEnabled(false)
     FocusGuard.soundAlerts.setCooldownMs(0)
   ===================================================================== */

(function (global) {
  'use strict';

  var ALERT_COOLDOWN_MS = 15000;

  var KINDS = {
    ATTENTION: 'attention',
    DISTRACTION: 'distraction',
    RETURN: 'return',
  };

  /** Rising, gentle: "you drifted". Descending, firmer: "you are away". */
  var VALID_KINDS = [KINDS.ATTENTION, KINDS.DISTRACTION, KINDS.RETURN];

  var TONES = {
    attention: [{ f: 660, t: 0 }, { f: 784, t: 0.14 }],
    distraction: [{ f: 520, t: 0 }, { f: 392, t: 0.16 }],
    return: [{ f: 880, t: 0 }],
  };

  var enabled = true;
  var cooldownMs = ALERT_COOLDOWN_MS;
  var lastPlayed = { attention: 0, distraction: 0, return: 0 };
  var lastKind = null;
  var lastState = null;
  var playedCount = 0;

  var context = null;
  var attached = false;
  var tries = 0;
  var handlers = { play: [] };

  /* ---------- Small helpers ---------------------------------------- */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
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

  /* ---------- Audio ------------------------------------------------- */

  function ensureContext() {
    if (context) {
      if (context.state === 'suspended' && typeof context.resume === 'function') {
        context.resume();
      }
      return context;
    }
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return null;    // very old browser — fail quietly
    context = new Ctor();
    return context;
  }

  /**
   * Plays one cue, honouring the switch and the per-kind cooldown.
   * @returns {boolean} true when a sound was actually produced
   */
  function play(kind, now) {
    var sound = VALID_KINDS.indexOf(kind) !== -1 ? kind : KINDS.ATTENTION;
    now = now || Date.now();

    if (!enabled) return false;
    if (lastPlayed[sound] && now - lastPlayed[sound] < cooldownMs) return false;

    lastPlayed[sound] = now;
    lastKind = sound;
    playedCount += 1;
    emit('play', { kind: sound, at: now, count: playedCount });

    var ctx = ensureContext();
    if (!ctx) return true;    // counted as played even without an audio device

    var notes = TONES[sound];
    var start = ctx.currentTime;
    notes.forEach(function (note) {
      var oscillator = ctx.createOscillator();
      var gain = ctx.createGain();
      var at = start + note.t;

      oscillator.type = 'sine';
      oscillator.frequency.value = note.f;

      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.1, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);

      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.5);
    });

    return true;
  }

  /* ---------- Following the distraction engine ---------------------- */

  /**
   * Decide, from a state transition, which cue (if any) to play. The
   * mapping is deliberately conservative:
   *   GRACE                      → attention cue
   *   DISTRACTED / FACE_MISSING  → distraction cue
   *   FOCUSED / DOWNWARD_STUDY   → return cue, only after a distraction cue
   */
  function handleChange(snapshot) {
    if (!snapshot) return;
    var state = snapshot.state;

    if (state === lastState) return;
    var previous = lastState;
    lastState = state;

    if (previous === null) return;   // first reading is not a transition

    if (state === 'grace') {
      // A downward *candidate* is a legitimate notebook switch being timed,
      // not a drift — it must never chirp at the user.
      if (snapshot.downwardCandidate) return;
      if (previous === 'focused' || previous === 'downward-study') {
        play(KINDS.ATTENTION);
      }
      return;
    }

    if (state === 'distracted' || state === 'face-missing') {
      play(KINDS.DISTRACTION);
      return;
    }

    if (state === 'focused' || state === 'downward-study') {
      if (previous === 'distracted' || previous === 'face-missing') {
        play(KINDS.RETURN);
      }
    }
  }

  function attach() {
    var distraction = module('distraction');
    if (!distraction || typeof distraction.on !== 'function') {
      if (tries < 25) {
        tries += 1;
        global.setTimeout(attach, 120);
      }
      return;
    }
    attached = true;
    distraction.on('change', handleChange);
    var current = typeof distraction.getState === 'function' ? distraction.getState() : null;
    lastState = current ? current.state : null;
  }

  /* ---------- Settings binding -------------------------------------- */

  function bindSettings() {
    each('[data-alert-setting="enabled"]', function (el) {
      el.checked = enabled;
      el.addEventListener('change', function () { setEnabled(el.checked); });
    });
  }

  function setEnabled(next) {
    enabled = !!next;
    each('[data-alert-setting="enabled"]', function (el) { el.checked = enabled; });
    if (enabled) ensureContext();
    return enabled;
  }

  function setCooldownMs(ms) {
    var parsed = parseFloat(ms);
    if (isFinite(parsed) && parsed >= 0) cooldownMs = parsed;
    return cooldownMs;
  }

  function reset() {
    lastPlayed = { attention: 0, distraction: 0, return: 0 };
    lastKind = null;
    lastState = null;
    playedCount = 0;
  }

  /* ---------- Wiring ------------------------------------------------ */

  var api = {
    KINDS: KINDS,
    DEFAULT_COOLDOWN_MS: ALERT_COOLDOWN_MS,
    isImplemented: function () { return true; },
    play: play,
    on: on,
    isEnabled: function () { return enabled; },
    setEnabled: setEnabled,
    getCooldownMs: function () { return cooldownMs; },
    setCooldownMs: setCooldownMs,
    getLastKind: function () { return lastKind; },
    getPlayedCount: function () { return playedCount; },
    getLastPlayed: function () { return Object.assign({}, lastPlayed); },
    reset: reset,
    // Exposed for the settings layer (js/sync.js) and for tests.
    dispatch: handleChange,
  };

  global.FocusGuardSoundAlerts = api;
  if (global.FocusGuard) global.FocusGuard.soundAlerts = api;
  else global.FocusGuard = { soundAlerts: api };

  function init() {
    bindSettings();
    attach();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
