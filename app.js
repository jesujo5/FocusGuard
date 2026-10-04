/* =====================================================================
   FocusGuard — app.js
   App shell wiring.

   This file does a few small, well-separated jobs:
     1. Switch between the sidebar views.
     2. Render the remaining placeholder dashboard values.
     3. Open / close Focus Mode.
     4. Toggle browser fullscreen (Fullscreen API only, no CSS fake).

   Other concerns live elsewhere:
     js/timer.js      Pomodoro timing (source of truth)
     js/timer-ui.js   timer DOM, sand clock, chime, settings
     js/session.js    study session logic
     js/session-ui.js study session DOM
     js/clock.js      real-world clock
     js/camera.js     webcam lifecycle
   ===================================================================== */

/* ---------------------------------------------------------------------
   Placeholder state
   These numbers are fake for now. Later phases will replace this object
   with real data coming from the session logger.
   --------------------------------------------------------------------- */
const placeholderState = {
  status: 'idle',            // 'idle' | 'focusing' | 'break'
  focusPercent: 0,           // 0 - 100
  todayFocusedMinutes: 0,
  todayGoalMinutes: 120,     // 2 hours
  sessionsToday: 0,
  longestMinutes: 0,
  weeklyAverageMinutes: 0,
  coins: 0,
  coinsToday: 0,
  streakDays: 0,
};

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

/** Format a number of minutes as "1h 05m" / "45m". */
function formatMinutes(minutes) {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

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
   4. Render placeholder dashboard values
   --------------------------------------------------------------------- */
function renderDashboard(state) {
  const ringLength = 327; // matches stroke-dasharray in style.css

  // Focus status ring + pill.
  const ring = getEl('focusRing');
  if (ring) {
    const offset = ringLength - (ringLength * state.focusPercent) / 100;
    ring.style.strokeDashoffset = String(offset);
  }
  const percent = getEl('focusPercent');
  if (percent) percent.textContent = `${state.focusPercent}%`;

  const meterFill = getEl('focusMeterFill');
  if (meterFill) meterFill.style.width = `${state.focusPercent}%`;

  // The focus status pill and the two status lines are owned by the
  // Pomodoro timer (see data-timer-state in js/timer-ui.js).

  // Today's goal progress.
  const goalDoneEl = getEl('goalDone');
  if (goalDoneEl) goalDoneEl.textContent = formatMinutes(state.todayFocusedMinutes);

  const goalPill = getEl('goalPill');
  if (goalPill) goalPill.textContent = `Goal: ${formatMinutes(state.todayGoalMinutes)}`;

  const goalPercent = state.todayGoalMinutes
    ? Math.min(100, Math.round((state.todayFocusedMinutes / state.todayGoalMinutes) * 100))
    : 0;

  const goalFill = getEl('goalProgressFill');
  if (goalFill) goalFill.style.width = `${goalPercent}%`;

  const goalBar = getEl('goalProgressBar');
  if (goalBar) goalBar.setAttribute('aria-valuenow', String(goalPercent));

  const goalCaption = getEl('goalCaption');
  if (goalCaption) {
    goalCaption.textContent = goalPercent === 0
      ? 'No focused time logged yet today.'
      : `${goalPercent}% complete — keep going.`;
  }

  // Coins.
  const coinValue = getEl('coinValue');
  if (coinValue) coinValue.textContent = String(state.coins);
  const coinToday = getEl('coinToday');
  if (coinToday) coinToday.textContent = `+${state.coinsToday}`;

  // Stat strip.
  const statFocused = getEl('statFocused');
  if (statFocused) statFocused.textContent = formatMinutes(state.todayFocusedMinutes);
  const statSessions = getEl('statSessions');
  if (statSessions) statSessions.textContent = String(state.sessionsToday);
  const statLongest = getEl('statLongest');
  if (statLongest) statLongest.textContent = formatMinutes(state.longestMinutes);
  const statAverage = getEl('statAverage');
  if (statAverage) statAverage.textContent = formatMinutes(state.weeklyAverageMinutes);

  // Streak chip in the sidebar.
  const streak = document.querySelector('.streak-chip strong');
  if (streak) streak.textContent = String(state.streakDays);
}

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
function init() {
  initNavigation();
  initSidebarDrawer();
  initFocusMode();
  initFullscreen();
  renderDashboard(placeholderState);
  showView('dashboard');
}

document.addEventListener('DOMContentLoaded', init);

/* Expose a tiny namespace for future phases / debugging in the console.
   Merge rather than overwrite: each module adds its own key
   (FocusGuard.timer, .session, .camera, .faceDetection). */
window.FocusGuard = Object.assign(window.FocusGuard || {}, {
  showView,
  renderDashboard,
  state: placeholderState,
  openFocusMode,
  closeFocusMode,
  toggleFullscreen,
});
