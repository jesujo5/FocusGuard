/* =====================================================================
   FocusGuard — js/attentionMode.js
   Prompt 10.5: the Attention Mode control (Screen study ⇄ Notebook).

   This module owns *only* the interface for the attention mode. The
   interpretation itself lives in js/distraction.js (setAttentionMode);
   this file just lets the user choose it and keeps every control on the
   page in agreement.

   ---- DOM contract ----------------------------------------------------
     input[type=radio][data-attention-mode]   value "screen" | "notebook"
     [data-attention-switch="screen"|"notebook"]   quick-switch buttons
     [data-attention-mode-help]    the one-line helper text (updated)
     [data-attention-mode-status]  short label of the active mode

   Several elements may carry the same attribute (Study Session, Focus
   Mode, Settings) — they are all kept in sync.

   ---- What a switch does — and does not do ---------------------------
   Switching mid-session is free: it never ends the session, never resets
   the Pomodoro, the elapsed time, the Focus Score or the Focus Coins. It
   only tells the attention engine how to read the head posture.

   Console:
     FocusGuard.attentionMode.set('notebook')
     FocusGuard.attentionMode.get()
     FocusGuard.attentionMode.toggle()
   ===================================================================== */

(function (global) {
  'use strict';

  var DEFAULT_MODE = 'screen';

  var HELP = {
    screen: 'Best when you study mainly from the laptop screen.',
    notebook: 'Allows focused downward posture while writing or reading on paper.',
  };

  var mode = DEFAULT_MODE;
  var bound = false;

  /* ---------- Small helpers ---------------------------------------- */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
  }

  function label(text) {
    var flags = module('distraction');
    if (flags && flags.MODE_LABELS && flags.MODE_LABELS[text]) return flags.MODE_LABELS[text];
    return text === 'notebook' ? 'Notebook / downward study' : 'Screen study';
  }

  /* ---------- Reading / writing the mode ---------------------------- */

  function get() {
    return mode;
  }

  /**
   * Set the mode. Updates the engine, every control on the page, and the
   * helper text, then asks the settings layer to persist it. Touches no
   * timer, session or score.
   */
  function set(next, options) {
    var wanted = next === 'notebook' ? 'notebook' : 'screen';
    mode = wanted;

    var distraction = module('distraction');
    if (distraction && typeof distraction.setAttentionMode === 'function') {
      distraction.setAttentionMode(wanted);
    }

    renderControls();

    if (!(options && options.silent)) persist();
    return mode;
  }

  function toggle() {
    return set(mode === 'notebook' ? 'screen' : 'notebook');
  }

  /** Persist through js/sync.js (the settings row). Safe when unavailable. */
  function persist() {
    var sync = module('sync');
    if (sync && typeof sync.saveSettingsSoon === 'function') sync.saveSettingsSoon();
  }

  /* ---------- Rendering --------------------------------------------- */

  function renderControls() {
    each('[data-attention-mode]', function (el) {
      // Works for radio inputs and anything else carrying the attribute.
      if (el.type === 'checkbox') el.checked = mode === 'notebook';
      else if ('checked' in el) el.checked = el.value === mode;
      el.classList.toggle('is-active', el.value === mode);
      if (el.hasAttribute('aria-checked')) {
        el.setAttribute('aria-checked', el.value === mode ? 'true' : 'false');
      }
    });

    each('[data-attention-switch]', function (el) {
      el.classList.toggle('is-active', el.dataset.attentionSwitch === mode);
      el.setAttribute('aria-pressed', el.dataset.attentionSwitch === mode ? 'true' : 'false');
    });

    each('[data-attention-mode-help]', function (el) {
      el.textContent = HELP[mode];
    });

    each('[data-attention-mode-status]', function (el) {
      el.textContent = label(mode);
    });

    // The quick toggle button shows what you would switch *to*.
    each('[data-attention-quick-toggle]', function (el) {
      var other = mode === 'notebook' ? 'screen' : 'notebook';
      el.textContent = label(other);
      el.dataset.attentionTarget = other;
      el.setAttribute('aria-label', 'Switch to ' + label(other));
    });

    var root = document.documentElement;
    if (root) root.dataset.attentionMode = mode;
  }

  /* ---------- Wiring ------------------------------------------------ */

  function bind() {
    if (bound) return;
    bound = true;

    each('[data-attention-mode]', function (el) {
      var handler = function () {
        if ('checked' in el && !el.checked) return;
        set(el.value);
      };
      el.addEventListener('change', handler);
    });

    each('[data-attention-switch]', function (el) {
      el.addEventListener('click', function () {
        set(el.dataset.attentionSwitch);
      });
    });

    each('[data-attention-quick-toggle]', function (el) {
      el.addEventListener('click', function () { toggle(); });
    });

    // The distraction engine may already know a mode (e.g. restored by
    // time the settings were applied) — adopt it without re-persisting.
    var distraction = module('distraction');
    if (distraction && typeof distraction.getAttentionMode === 'function') {
      var current = distraction.getAttentionMode();
      if (current && current !== mode) mode = current;
    }
    renderControls();
  }

  /** Called by js/sync.js after stored settings are applied. */
  function applyFromSettings(value) {
    var wanted = value === 'notebook' ? 'notebook' : 'screen';
    mode = wanted;
    var distraction = module('distraction');
    if (distraction && typeof distraction.setAttentionMode === 'function') {
      distraction.setAttentionMode(wanted);
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
