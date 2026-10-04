/* =====================================================================
   FocusGuard — js/timer-ui.js
   Phase 2: everything that touches the page for the Pomodoro timer.

   The DOM contract (any element can carry these attributes, and every
   matching element is kept in sync — that is how the compact dashboard
   card and the large Study Session panel share one timer):

     data-timer-display            shows "MM:SS"
     data-timer-mode-chip="focus"  gets .is-active for the current mode
     data-timer-mode-text          shows "Focus" / "Short break" / ...
     data-timer-state              shows "Idle" / "Running" / "Paused"
     data-timer-count              shows the completed Pomodoro count
     data-timer-progress           width is set to the period progress
     data-timer-toggle             Start / Pause / Resume button
     data-timer-action="reset"     reset button
     data-timer-action="skip"      skip button
     data-timer-setting="focus"    number input for a duration
     data-timer-setting="autoStartNext"  checkbox
     data-timer-setting="sound"          checkbox (UI only)
     data-timer-status-main / -hint / -pill   the focus status card

   Load order in index.html: js/timer.js, then this file, then app.js.
   ===================================================================== */

(function (global) {
  'use strict';

  var TimerApi = global.FocusGuardTimer;
  if (!TimerApi) {
    console.warn('FocusGuard: js/timer.js must be loaded before js/timer-ui.js');
    return;
  }

  var MODE = TimerApi.MODE;
  var PHASE = TimerApi.PHASE;
  var formatClock = TimerApi.formatClock;

  var MODE_LABELS = {
    focus: 'Focus',
    shortBreak: 'Short break',
    longBreak: 'Long break',
  };

  var PHASE_LABELS = {
    idle: 'Idle',
    running: 'Running',
    paused: 'Paused',
  };

  var HINTS = {
    focus: 'Stay with it — the timer will move you to a break on its own.',
    shortBreak: 'Short break: step away from the screen for a few minutes.',
    longBreak: 'Long break: you have earned a proper rest.',
  };

  /* -------------------------------------------------------------------
     Notification sound (requirement 14)
     Synthesised with the Web Audio API: no audio files, no downloads and
     nothing copyrighted. A soft two-note chime.
     ------------------------------------------------------------------- */
  var sound = {
    enabled: true,
    context: null,

    /** Lazily create the AudioContext (browsers require a user gesture). */
    ensureContext: function () {
      if (this.context) {
        if (this.context.state === 'suspended') this.context.resume();
        return this.context;
      }
      var Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) return null; // very old browser — fail quietly
      this.context = new Ctor();
      return this.context;
    },

    play: function () {
      if (!this.enabled) return;
      var ctx = this.ensureContext();
      if (!ctx) return;

      var start = ctx.currentTime;
      var notes = [880, 1174.66]; // A5 then D6

      notes.forEach(function (frequency, index) {
        var oscillator = ctx.createOscillator();
        var gain = ctx.createGain();
        var at = start + index * 0.18;

        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;

        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(0.14, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);

        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.55);
      });
    },
  };

  /* -------------------------------------------------------------------
     Sand clock / hourglass
     A pure visual: it never keeps time of its own. Every frame is derived
     from the Pomodoro state, so it can never drift from the countdown.

       is-running  sand falls
       is-paused   sand frozen
       is-done     period finished (brief, held by hourglassDoneUntil)

     --sand-top / --sand-bottom are percentages of each chamber.
     ------------------------------------------------------------------- */
  var HOURGLASS_MARKUP = [
    '<span class="hourglass__cap hourglass__cap--top"></span>',
    '<span class="hourglass__body">',
    '  <span class="hg-chamber hg-chamber--top">',
    '    <span class="hg-sand hg-sand--top"></span>',
    '  </span>',
    '  <span class="hg-stream" aria-hidden="true"></span>',
    '  <span class="hg-chamber hg-chamber--bottom">',
    '    <span class="hg-sand hg-sand--bottom"></span>',
    '  </span>',
    '</span>',
    '<span class="hourglass__cap hourglass__cap--bottom"></span>',
  ].join('');

  var HOURGLASS_DONE_MS = 900;
  var hourglassDoneUntil = 0;
  var hourglassDoneTimer = null;

  function injectHourglasses() {
    document.querySelectorAll('[data-hourglass-slot]').forEach(function (el) {
      if (el.querySelector('.hourglass')) return;
      el.innerHTML = '<div class="hourglass" data-hourglass>' + HOURGLASS_MARKUP + '</div>';
    });
  }

  function renderHourglass(state) {
    var done = Date.now() < hourglassDoneUntil;

    document.querySelectorAll('[data-hourglass]').forEach(function (el) {
      if (done) {
        // Finish the visual: every grain has landed, then we hand over to
        // the next period on the next render.
        el.classList.remove('is-running', 'is-paused');
        el.classList.add('is-done');
        el.style.setProperty('--sand-top', '0%');
        el.style.setProperty('--sand-bottom', '100%');
        return;
      }

      el.classList.remove('is-done');
      el.classList.toggle('is-running', state.phase === PHASE.RUNNING);
      el.classList.toggle('is-paused', state.phase === PHASE.PAUSED);
      el.style.setProperty('--sand-top', (100 - state.progress * 100).toFixed(2) + '%');
      el.style.setProperty('--sand-bottom', (state.progress * 100).toFixed(2) + '%');
    });
  }

  function completeHourglass() {
    hourglassDoneUntil = Date.now() + HOURGLASS_DONE_MS;
    if (hourglassDoneTimer) global.clearTimeout(hourglassDoneTimer);
    hourglassDoneTimer = global.setTimeout(function () {
      hourglassDoneTimer = null;
      hourglassDoneUntil = 0;
      var timer = global.FocusGuard && global.FocusGuard.timer;
      if (timer) renderHourglass(timer.getState());
    }, HOURGLASS_DONE_MS + 60);
  }

  /* -------------------------------------------------------------------
     Rendering: one function reads a state snapshot and updates every
     element that opts in via the data attributes above.
     ------------------------------------------------------------------- */
  function render(state) {
    renderHourglass(state);

    document.querySelectorAll('[data-timer-display]').forEach(function (el) {
      el.textContent = formatClock(state.remainingMs);
    });

    document.querySelectorAll('[data-timer-mode-chip]').forEach(function (el) {
      el.classList.toggle('is-active', el.dataset.timerModeChip === state.mode);
    });

    document.querySelectorAll('[data-timer-mode-text]').forEach(function (el) {
      el.textContent = MODE_LABELS[state.mode] || 'Focus';
    });

    document.querySelectorAll('[data-timer-state]').forEach(function (el) {
      el.textContent = PHASE_LABELS[state.phase] || 'Idle';
      el.classList.toggle('pill--soft', state.phase === PHASE.RUNNING);
      el.classList.toggle('pill--muted', state.phase !== PHASE.RUNNING);
    });

    document.querySelectorAll('[data-timer-count]').forEach(function (el) {
      el.textContent = String(state.completedPomodoros);
    });

    document.querySelectorAll('[data-timer-progress]').forEach(function (el) {
      el.style.width = (state.progress * 100).toFixed(1) + '%';
    });

    document.querySelectorAll('[data-timer-toggle]').forEach(function (el) {
      el.textContent = toggleLabel(state.phase);
      el.setAttribute('aria-label', toggleLabel(state.phase) + ' timer');
    });

    // The "Current focus status" card mirrors the timer.
    var statusMain = {
      idle: 'Ready: ' + (MODE_LABELS[state.mode] || 'Focus') + ' · ' + state.durations.focus + ' min',
      running: MODE_LABELS[state.mode] + ' in progress',
      paused: MODE_LABELS[state.mode] + ' paused',
    }[state.phase];

    document.querySelectorAll('[data-timer-status-main]').forEach(function (el) {
      el.textContent = statusMain;
    });
    document.querySelectorAll('[data-timer-status-hint]').forEach(function (el) {
      el.textContent = state.phase === PHASE.IDLE
        ? HINTS[state.mode]
        : 'Time remaining: ' + formatClock(state.remainingMs) +
          ' · completed pomodoros: ' + state.completedPomodoros + '.';
    });

    syncSettingsInputs(state);
  }

  function toggleLabel(phase) {
    if (phase === PHASE.RUNNING) return 'Pause';
    if (phase === PHASE.PAUSED) return 'Resume';
    return 'Start';
  }

  /** Push duration values back into inputs, without fighting active typing. */
  function syncSettingsInputs(state) {
    document.querySelectorAll('[data-timer-setting]').forEach(function (el) {
      var key = el.dataset.timerSetting;
      if (document.activeElement === el) return;
      if (key === 'autoStartNext') el.checked = !!state.autoStartNext;
      else if (key === 'sound') el.checked = sound.enabled;
      else if (state.durations[key] !== undefined) el.value = String(state.durations[key]);
    });
  }

  /* -------------------------------------------------------------------
     Wiring
     ------------------------------------------------------------------- */
  function bindControls(timer) {
    document.querySelectorAll('[data-timer-toggle]').forEach(function (el) {
      el.addEventListener('click', function () {
        timer.toggle();
      });
    });

    document.querySelectorAll('[data-timer-action]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (el.dataset.timerAction === 'reset') timer.reset();
        if (el.dataset.timerAction === 'skip') timer.skip();
      });
    });
  }

  function bindSettings(timer) {
    document.querySelectorAll('[data-timer-setting]').forEach(function (el) {
      var key = el.dataset.timerSetting;

      el.addEventListener('change', function () {
        if (key === 'sound') {
          sound.enabled = el.checked;
          if (sound.enabled) sound.ensureContext();
          return;
        }
        if (key === 'autoStartNext') {
          timer.setAutoStartNext(el.checked);
          return;
        }
        // A duration field.
        var patch = {};
        patch[key] = el.value;
        timer.setDurations(patch);
      });
    });
  }

  /** Browsers block audio until the user interacts. Unlock on first input. */
  function unlockAudio() {
    var unlock = function () {
      sound.ensureContext();
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }

  function init() {
    var timer = new TimerApi.PomodoroTimer({
      durations: TimerApi.DEFAULT_DURATIONS,
      autoStartNext: true,
      tickMs: 250,
    });

    bindControls(timer);
    bindSettings(timer);
    unlockAudio();
    injectHourglasses();

    // Cheap enough to do a full re-render on every event.
    timer.on('change', render);
    timer.on('tick', render);
    timer.on('complete', function (state, detail) {
      sound.play();
      completeHourglass();
      // A short visual pulse on whichever timer cards are on screen.
      document.querySelectorAll('.timer, .timer-panel').forEach(function (el) {
        el.classList.remove('timer--flash');
        // Reading offsetWidth restarts the CSS animation.
        void el.offsetWidth;
        el.classList.add('timer--flash');
      });
      console.info('FocusGuard: finished', detail.finishedMode, '→ next', detail.nextMode);
    });

    // Coming back to a backgrounded tab: redraw immediately.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) render(timer.getState());
    });

    render(timer.getState());

    // Handy for manual testing from the browser console.
    if (global.FocusGuard) global.FocusGuard.timer = timer;
    else global.FocusGuard = { timer: timer };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
