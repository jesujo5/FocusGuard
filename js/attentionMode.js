/* =====================================================================
   FocusGuard — js/attentionMode.js
   Prompt 10.5: the Attention Mode control (Screen study ⇄ Notebook).
   Prompt 11:  retired. Monitoring is automatic, so there is nothing left
               for the user to choose.

   This module used to own the radio group that switched the attention
   engine between "Screen study" and "Notebook / downward study". The new
   rule is that FocusGuard reads the study posture *automatically*: facing
   the laptop, reading a notebook and writing on paper are all studied by
   the same camera pipeline (js/camera.js → js/faceDetection.js →
   js/attention.js → js/distraction.js), with no switch to press.

   So the file now does exactly one job: present that single automatic
   mode, and stay compatible with anything that still asks for the old
   API (js/sync.js, the stored `attention_mode` setting, the console).

   ---- DOM contract ----------------------------------------------------
     [data-attention-mode-status]   short label of the active mode
     [data-attention-mode-help]     the one-line helper text

   Anything still exposing the legacy `[data-attention-mode]` radios,
   `[data-attention-switch]` buttons or `[data-attention-quick-toggle]`
   simply resolves to the one mode — the attributes are tolerated, not
   required. See index.html: the selectors were replaced by a short
   "Intelligent monitoring" note in Study Session, Focus Mode and Settings.

   ---- What this never does -------------------------------------------
   It never ends a session, never resets the Pomodoro, the elapsed time,
   the Focus Score or the Focus Coins. It only labels how the engine reads
   the head posture — and that reading is now always automatic.

   Console:
     FocusGuard.attentionMode.get()            // always 'intelligent'
     FocusGuard.attentionMode.help()
   ===================================================================== */

(function (global) {
  'use strict';

  /** The one monitoring mode. Kept in the settings schema for compatibility. */
  var DEFAULT_MODE = 'intelligent';

  var HELP = {
    intelligent: 'Automatic: FocusGuard reads your posture itself — laptop ' +
      'screen, notebook or handwriting all count as studying. Phone use ' +
      'during a session is counted as distracted.',
  };

  var LABEL = 'Intelligent monitoring';

  var mode = DEFAULT_MODE;
  var bound = false;

  /* ---------- Small helpers ---------------------------------------- */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
  }

  /** The display label of the (single) mode. */
  function label() {
    var flags = module('distraction');
    if (flags && flags.MODE_LABELS && flags.MODE_LABELS[mode]) {
      return flags.MODE_LABELS[mode];
    }
    return LABEL;
  }

  /** The helper copy under the label. */
  function help() {
    return HELP[mode] || HELP[DEFAULT_MODE];
  }

  /* ---------- Reading / writing the mode ---------------------------- */

  function get() {
    return mode;
  }

  /**
   * Legacy setter. Monitoring is automatic, so there is nothing to switch:
   * any requested value resolves to the one mode. The engine is told (a
   * no-op there too) so an old console snippet cannot leave the page and
   * the engine disagreeing.
   */
  function set() {
    mode = DEFAULT_MODE;

    var distraction = module('distraction');
    if (distraction && typeof distraction.setAttentionMode === 'function') {
      distraction.setAttentionMode(mode);
    }

    renderControls();
    return mode;
  }

  function toggle() {
    return set();
  }

  /* ---------- Rendering --------------------------------------------- */

  function renderControls() {
    // Tolerate a leftover legacy radio/checkbox, without depending on one.
    // Scoped to inputs on purpose: the <html> element itself carries a
    // data-attention-mode attribute for CSS, and must not be matched here.
    each('input[data-attention-mode]', function (el) {
      el.checked = true;
      el.classList.add('is-active');
    });

    each('[data-attention-mode-status]', function (el) {
      el.textContent = label();
    });

    each('[data-attention-mode-help]', function (el) {
      el.textContent = help();
    });

    var root = document.documentElement;
    if (root) {
      root.dataset.attentionMode = mode;
      root.dataset.monitoringMode = mode;
    }
  }

  /* ---------- Wiring ------------------------------------------------ */

  function bind() {
    if (bound) return;
    bound = true;

    // Adopt whatever mode the engine is already running (it is the single
    // automatic one), then paint every label once.
    var distraction = module('distraction');
    if (distraction && typeof distraction.getAttentionMode === 'function') {
      var current = distraction.getAttentionMode();
      if (current) mode = current;
    }
    set();
  }

  /**
   * Called by js/sync.js after stored settings are applied. Older rows may
   * still hold 'screen' or 'notebook' — both now mean the same automatic
   * mode, so nothing needs migrating by hand.
   */
  function applyFromSettings() {
    mode = DEFAULT_MODE;
    var distraction = module('distraction');
    if (distraction && typeof distraction.setAttentionMode === 'function') {
      distraction.setAttentionMode(mode);
    }
    renderControls();
    return mode;
  }

  var api = {
    DEFAULT_MODE: DEFAULT_MODE,
    HELP: HELP,
    isImplemented: function () { return true; },
    get: get,
    set: set,
    toggle: toggle,
    applyFromSettings: applyFromSettings,
    render: renderControls,
    label: label,
    help: help,
  };

  global.FocusGuardAttentionMode = api;
  if (global.FocusGuard) global.FocusGuard.attentionMode = api;
  else global.FocusGuard = { attentionMode: api };

  function init() {
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
