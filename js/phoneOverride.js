/* =====================================================================
   FocusGuard — js/phoneOverride.js
   Prompt 11: the honest "Using phone" distraction switch.

   ---- Why this exists ------------------------------------------------
   FocusGuard's rule is: notebook / paper = focused, phone during a study
   session = distracted. A laptop webcam genuinely cannot tell the two
   apart — a phone and a notebook look alike, and neither the head angle
   nor the landmarks reveal what is on the screen below the desk. So this
   module does NOT fake detection and never claims to.

   Instead it offers a one-click declaration, in Study Session and in the
   Mini Focus Window:

       [ Using phone — distraction ]   →  "Distracted — Phone Use"

   and a way back:

       [ Resume study ]

   ---- What pressing the button does ----------------------------------
     * enters the existing distraction pipeline with reason PHONE_USE;
     * stops counting focused time from that exact timestamp;
     * awards no Focus Coins for the interval;
     * plays the configured distraction sound (via js/soundAlerts.js);
     * leaves the Pomodoro running, the session active and the camera on;
     * keeps recording the distraction duration until it is cleared.
   Pressing Resume Study closes the phone-use interval at that timestamp and
   hands straight back to the existing grace/distraction machine, so a
   camera reading decides what happens next — never a guess.

   ---- What pressing the button never does ----------------------------
     * It never prints "Phone detected". The status line always says the
       user marked it.
     * It never touches the timer, the session or the score directly. The
       score and the coins follow from the measured buckets, as always.

   ---- DOM contract ---------------------------------------------------
     [data-phone-override]   the one-click "using phone" button
     [data-phone-resume]     the "resume study" button
     [data-phone-status]     short status line
     [data-phone-detail]     the honest second line

   Every element is optional and may appear more than once (Study Session,
   Mini Focus Window). bindWithin(root) also wires a panel that lives in a
   different document (the Picture-in-Picture window).

   Console:
     FocusGuard.phoneOverride.activate()
     FocusGuard.phoneOverride.resume()
     FocusGuard.phoneOverride.isActive()
   ===================================================================== */

(function (global) {
  'use strict';

  var LABEL_ACTIVE = 'Distracted — Phone Use';

  var HELP_IDLE = 'Phone use during a session counts as distracted. Mark it ' +
    'in one click — the camera cannot tell a phone from your notes.';
  var HELP_ACTIVE = 'You marked this. Focused time and Focus Coins are paused. ' +
    'Press Resume study when you are back.';

  var roots = [];      // every root this module has painted
  var bound = false;
  var attached = false;
  var tries = 0;

  /* ---------- Small helpers ---------------------------------------- */

  function each(selector, fn, root) {
    (root || document).querySelectorAll(selector).forEach(fn);
  }

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
  }

  function distraction() {
    return module('distraction');
  }

  /* ---------- Actions ---------------------------------------------- */

  function isActive() {
    var engine = distraction();
    if (engine && typeof engine.isPhoneOverride === 'function') {
      return engine.isPhoneOverride() === true;
    }
    var state = engine && typeof engine.getState === 'function' ? engine.getState() : null;
    return !!(state && state.phoneOverride);
  }

  function canMark() {
    var engine = distraction();
    if (!engine || typeof engine.getState !== 'function') return false;
    return engine.getState().sessionActive === true;
  }

  /** Mark the current interval as phone use (declared, never detected). */
  function activate() {
    var engine = distraction();
    if (!engine || typeof engine.setPhoneOverride !== 'function') return false;
    if (!canMark()) return false;          // nothing to distract from
    engine.setPhoneOverride(true);
    render();
    return true;
  }

  /** Clear the declaration and let the camera posture decide again. */
  function resume() {
    var engine = distraction();
    if (!engine || typeof engine.setPhoneOverride !== 'function') return false;
    engine.setPhoneOverride(false);
    render();
    return true;
  }

  function toggle() {
    return isActive() ? resume() : activate();
  }

  /* ---------- Rendering -------------------------------------------- */

  function renderWithin(root) {
    var active = isActive();
    var enabled = canMark() || active;

    each('[data-phone-override]', function (el) {
      el.hidden = active;
      el.disabled = !enabled;
      el.setAttribute('aria-pressed', 'false');
      el.classList.toggle('is-active', false);
    }, root);

    each('[data-phone-resume]', function (el) {
      el.hidden = !active;
      el.disabled = !enabled;
      el.setAttribute('aria-pressed', active ? 'true' : 'false');
      el.classList.toggle('is-active', active);
    }, root);

    each('[data-phone-status]', function (el) {
      el.textContent = active ? LABEL_ACTIVE : 'No phone use marked';
      el.dataset.phoneState = active ? 'phone-use' : 'clear';
    }, root);

    each('[data-phone-detail]', function (el) {
      el.textContent = active ? HELP_ACTIVE : HELP_IDLE;
    }, root);
  }

  function render() {
    renderWithin(document);
    // Drop roots that have gone away (a closed Picture-in-Picture window),
    // then repaint the rest.
    roots = roots.filter(function (root) {
      return root && (root === document || root.isConnected !== false);
    });
    roots.forEach(function (root) {
      if (root && root !== document) renderWithin(root);
    });
  }

  /* ---------- Wiring ------------------------------------------------ */

  /** Wire (and paint) the controls inside one root. Safe to call again. */
  function bindWithin(root) {
    var target = root || document;
    if (target !== document) {
      if (target.dataset.phoneBound === '1') {
        renderWithin(target);      // already wired — just repaint
        return target;
      }
      target.dataset.phoneBound = '1';
    }
    if (roots.indexOf(target) === -1) roots.push(target);

    each('[data-phone-override]', function (el) {
      el.addEventListener('click', function () { activate(); });
    }, target);

    each('[data-phone-resume]', function (el) {
      el.addEventListener('click', function () { resume(); });
    }, target);

    renderWithin(target);
    return target;
  }

  function attach() {
    if (attached) return;
    var engine = distraction();
    if (!engine || typeof engine.on !== 'function') {
      if (tries < 25) {
        tries += 1;
        global.setTimeout(attach, 120);
      }
      return;
    }
    attached = true;
    engine.on('change', render);
    engine.on('override', render);
  }

  /* ---------- Exports ---------------------------------------------- */

  var api = {
    LABEL_ACTIVE: LABEL_ACTIVE,
    isImplemented: function () { return true; },
    isActive: isActive,
    canMark: canMark,
    activate: activate,
    resume: resume,
    toggle: toggle,
    render: render,
    renderWithin: renderWithin,
    bindWithin: bindWithin,
    helpers: { idle: HELP_IDLE, active: HELP_ACTIVE },
  };

  global.FocusGuardPhoneOverride = api;
  if (global.FocusGuard) global.FocusGuard.phoneOverride = api;
  else global.FocusGuard = { phoneOverride: api };

  function init() {
    bindWithin(document);
    attach();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
