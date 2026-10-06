/* =====================================================================
   FocusGuard — app.js
   App shell wiring.

   This file does a few small, well-separated jobs:
     1. Switch between the sidebar views.
     2. Ask the focus engine to paint the measured dashboard values.
     3. Open / close Focus Mode.
     4. Toggle browser fullscreen (Fullscreen API only, no CSS fake).

   Other concerns live elsewhere:
     js/timer.js      Pomodoro timing (source of truth)
     js/timer-ui.js   timer DOM, sand clock, chime, settings
     js/session.js    study session logic
     js/session-ui.js study session DOM
     js/clock.js      real-world clock
     js/camera.js     webcam lifecycle
     js/focusEngine.js measured attention, focus score, Focus Coins
   ===================================================================== */

/* Human-readable labels for each view, used by the topbar. */
const viewMeta = {
  dashboard: { title: 'Dashboard',     subtitle: 'Your focus at a glance' },
  session:   { title: 'Study Session', subtitle: 'Plan and run focus blocks' },
  world:     { title: 'My World',      subtitle: 'A space that grows with you' },
  analytics: { title: 'Analytics',     subtitle: 'How you actually spend your time' },
  history:   { title: 'History',       subtitle: 'Your logged study sessions' },
  settings:  { title: 'Settings',      subtitle: 'Tune FocusGuard to your habits' },
};

/* ---------------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------------- */


/** Look up an element, or throw so mistakes are obvious while developing. */
function getEl(id) {
  const el = document.getElementById(id);
  if (!el) console.warn(`FocusGuard: missing element #${id}`);
  return el;
}

/* ---------------------------------------------------------------------
   1. View switching
   --------------------------------------------------------------------- */
function showView(viewName) {
  const name = viewMeta[viewName] ? viewName : 'dashboard';

  // Toggle the visible section.
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('is-visible', section.id === `view-${name}`);
  });

  // Highlight the matching nav button, and sync aria state.
  document.querySelectorAll('.nav__item').forEach((button) => {
    const isActive = button.dataset.view === name;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  // Update the topbar text.
  const meta = viewMeta[name];
  const titleEl = getEl('viewTitle');
  const subtitleEl = getEl('viewSubtitle');
  if (titleEl) titleEl.textContent = meta.title;
  if (subtitleEl) subtitleEl.textContent = meta.subtitle;

  // Give the page a sensible title for tabs and history.
  document.title = `${meta.title} · FocusGuard`;

  closeSidebar();
}

function initNavigation() {
  document.querySelectorAll('.nav__item').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view));
  });

  // Any element with data-goto acts as a shortcut link.
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => showView(el.dataset.goto));
  });
}

/* ---------------------------------------------------------------------
   2. Sidebar drawer (mobile / tablet)
   --------------------------------------------------------------------- */
function openSidebar() {
  const sidebar = getEl('sidebar');
  const backdrop = getEl('sidebarBackdrop');
  const menuBtn = getEl('menuBtn');
  if (!sidebar) return;
  sidebar.classList.add('is-open');
  if (backdrop) backdrop.hidden = false;
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  const sidebar = getEl('sidebar');
  const backdrop = getEl('sidebarBackdrop');
  const menuBtn = getEl('menuBtn');
  if (!sidebar) return;
  sidebar.classList.remove('is-open');
  if (backdrop) backdrop.hidden = true;
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
}

function initSidebarDrawer() {
  const menuBtn = getEl('menuBtn');
  const backdrop = getEl('sidebarBackdrop');
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      const isOpen = getEl('sidebar')?.classList.contains('is-open');
      isOpen ? closeSidebar() : openSidebar();
    });
  }
  if (backdrop) backdrop.addEventListener('click', closeSidebar);

  // Escape closes the drawer on small screens.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });
}

/* ---------------------------------------------------------------------
   3. Focus Mode
   A distraction-minimised study screen. It reuses the same data-timer-*
   and data-session-* attributes as the dashboard, so the timer UI keeps
   it in sync for free — there is no second clock anywhere.
   --------------------------------------------------------------------- */
let focusModeEnteredByFullscreen = false;

function isFocusModeOpen() {
  const panel = document.querySelector('[data-focus-mode]');
  return !!panel && !panel.hidden;
}

function openFocusMode() {
  const panel = document.querySelector('[data-focus-mode]');
  if (!panel) return;
  panel.hidden = false;
  document.body.classList.add('is-focus-mode');
  // Give keyboard users somewhere sensible to land.
  const exit = panel.querySelector('[data-focus-exit]');
  if (exit) exit.focus();
}

function closeFocusMode() {
  const panel = document.querySelector('[data-focus-mode]');
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.body.classList.remove('is-focus-mode');
  focusModeEnteredByFullscreen = false;
}

function initFocusMode() {
  document.querySelectorAll('[data-focus-open]').forEach((el) => {
    el.addEventListener('click', openFocusMode);
  });
  document.querySelectorAll('[data-focus-exit]').forEach((el) => {
    el.addEventListener('click', () => {
      closeFocusMode();
      // Leaving Focus Mode should also leave fullscreen if we got here
      // through the fullscreen button.
      if (document.fullscreenElement) document.exitFullscreen();
    });
  });

  // Ending a session returns you to the normal dashboard so the summary
  // dialog is the thing you are looking at.
  const session = window.FocusGuard && window.FocusGuard.session;
  if (session && typeof session.on === 'function') {
    session.on('end', closeFocusMode);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // The browser already handles Escape while fullscreen; fullscreenchange
    // will close Focus Mode for us.
    if (document.fullscreenElement) return;
    if (isFocusModeOpen()) closeFocusMode();
  });
}

/* ---------------------------------------------------------------------
   4. Fullscreen (browser Fullscreen API — never a CSS imitation)
   --------------------------------------------------------------------- */
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
  const root = document.documentElement;
  if (isFullscreen()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  const enter = root.requestFullscreen || root.webkitRequestFullscreen;
  // Browsers reject this unless it comes from a user gesture — which is
  // exactly how it is called (a button click).
  if (enter) enter.call(root).catch(() => {});
}

function syncFullscreenButtons() {
  const active = isFullscreen();
  document.body.classList.toggle('is-fullscreen', active);

  document.querySelectorAll('[data-fullscreen-toggle]').forEach((btn) => {
    btn.setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
    btn.setAttribute('title', active ? 'Exit full screen' : 'Full screen');
    btn.classList.toggle('is-active', active);
    const icon = btn.querySelector('[data-fullscreen-icon]');
    if (icon) icon.textContent = active ? '⤢' : '⛶';
    const label = btn.querySelector('[data-fullscreen-text]');
    if (label) label.textContent = active ? 'Exit full screen' : 'Full screen';
  });
}

function initFullscreen() {
  document.querySelectorAll('[data-fullscreen-toggle]').forEach((btn) => {
    btn.addEventListener('click', toggleFullscreen);
  });

  const onChange = () => {
    const active = isFullscreen();
    syncFullscreenButtons();

    if (active) {
      // Fullscreen hides the usual navigation, so make sure the screen is
      // showing something useful: the study timer.
      if (!isFocusModeOpen()) {
        focusModeEnteredByFullscreen = true;
        openFocusMode();
      }
    } else if (focusModeEnteredByFullscreen) {
      // Leaving fullscreen restores the normal dashboard.
      focusModeEnteredByFullscreen = false;
      closeFocusMode();
    }
  };

  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  syncFullscreenButtons();
}

/* ---------------------------------------------------------------------
   5. Dashboard values
   ---------------------------------------------------------------------
   Every measured number on the dashboard — today's focused time, the
   estimated Focus Score, Focus Coins, the daily goal — is owned by
   js/focusEngine.js, which renders it from real timestamp-based data.
   Keeping a single owner means the dashboard can never drift away from
   what the session summary reports.
   --------------------------------------------------------------------- */
function renderDashboard() {
  const engine = window.FocusGuard && window.FocusGuard.focusEngine;
  if (engine && typeof engine.render === 'function') engine.render();
}

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
function init() {
  initNavigation();
  initSidebarDrawer();
  initFocusMode();
  initFullscreen();
  renderDashboard();
  showView('dashboard');
}

document.addEventListener('DOMContentLoaded', init);

/* Expose a tiny namespace for future phases / debugging in the console.
   Merge rather than overwrite: each module adds its own key
   (FocusGuard.timer, .session, .camera, .faceDetection). */
window.FocusGuard = Object.assign(window.FocusGuard || {}, {
  showView,
  renderDashboard,
  openFocusMode,
  closeFocusMode,
  toggleFullscreen,
});
