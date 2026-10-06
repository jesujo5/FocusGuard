/* =====================================================================
   FocusGuard — js/session-ui.js
   Phase 3: everything that touches the page for the study session system.

   js/session.js holds the logic. This file renders it and wires buttons.
   Nothing here knows how a session is stored — it only reads state
   snapshots and finished records.

   ---- The DOM contract ----------------------------------------------
   Start form
     [data-session-form]                 the <form> element
     [data-session-field="subject"]      subject input
     [data-session-field="goal"]         goal input
     [data-session-form-error]           validation message

   Active / idle panels
     [data-session-idle]                 shown when no session is running
     [data-session-active]               shown while a session is running
     [data-session-subject]              current subject text
     [data-session-goal]                 current goal text
     [data-session-status]               status pill
     [data-session-elapsed]              elapsed clock (HH:MM:SS)
     [data-session-active-time]          running time
     [data-session-break-time]           break time
     [data-session-pomodoros]            pomodoros completed
     [data-session-pause]                pause / resume toggle
     [data-session-end]                  end session button

   Dashboard mirror
     [data-session-current-subject]      subject, or a placeholder
     [data-session-current-goal]         goal, or a placeholder
     [data-session-current-meta]         start time + elapsed
     [data-session-current-pomodoros]

   History + summary
     [data-session-history]              <tbody> for finished records
     [data-session-history-count]
     [data-summary="subject|goal|start|end|elapsed|active|break|pomodoros|status"]
     [data-summary-close]

   Load order in index.html: js/timer.js, js/timer-ui.js, js/session.js,
   this file, then app.js.
   ===================================================================== */

(function (global) {
  'use strict';

  var SessionApi = global.FocusGuardSession;
  if (!SessionApi) {
    console.warn('FocusGuard: js/session.js must be loaded before js/session-ui.js');
    return;
  }

  var STATUS_LABELS = {
    idle: 'No session',
    running: 'Running',
    paused: 'Paused',
  };

  var RECORD_LABELS = {
    completed: 'Completed',
    endedEarly: 'Ended early',
  };

  /* -------------------------------------------------------------------
     Formatting helpers
     ------------------------------------------------------------------- */

  /** "1h 05m" / "12m 30s" / "45s" — friendly, for summaries. */
  function formatDuration(ms) {
    var totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;

    if (hours > 0) return hours + 'h ' + String(minutes).padStart(2, '0') + 'm';
    if (minutes > 0) return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
    return seconds + 's';
  }

  /** "01:05:32" while a session runs; drops the hour part under an hour. */
  function formatElapsed(ms) {
    var totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    var clock = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    return hours > 0 ? String(hours).padStart(2, '0') + ':' + clock : clock;
  }

  /** "2 Oct, 14:05" for history rows. */
  function formatDateTime(epochMs) {
    if (!epochMs) return '—';
    var date = new Date(epochMs);
    var day = date.getDate();
    var month = date.toLocaleString(undefined, { month: 'short' });
    var time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return day + ' ' + month + ', ' + time;
  }

  function formatClockTime(epochMs) {
    if (!epochMs) return '—';
    return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /* -------------------------------------------------------------------
     Tiny DOM helpers (each one tolerates a missing element)
     ------------------------------------------------------------------- */
  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function setText(selector, text) {
    each(selector, function (el) { el.textContent = text; });
  }

  function setVisible(el, visible) {
    if (!el) return;
    el.hidden = !visible;
  }

  /* -------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------- */

  function render(state) {
    var isActive = state.isActive;
    var status = state.status;

    // Idle panel vs active panel.
    setVisible(document.querySelector('[data-session-idle]'), !isActive);
    setVisible(document.querySelector('[data-session-active]'), isActive);

    // Status pills everywhere.
    each('[data-session-status]', function (el) {
      el.textContent = STATUS_LABELS[status] || 'No session';
      el.classList.toggle('pill--soft', status === 'running');
      el.classList.toggle('pill--muted', status !== 'running');
    });

    // Active panel details.
    setText('[data-session-subject]', state.subject || 'Untitled session');
    setText('[data-session-goal]', state.goal || 'No goal set');
    setText('[data-session-elapsed]', formatElapsed(state.totalDurationMs));
    setText('[data-session-active-time]', formatDuration(state.activeDurationMs));
    setText('[data-session-break-time]', formatDuration(state.breakDurationMs));
    setText('[data-session-pomodoros]', String(state.pomodorosCompleted));

    // Pause / resume button label.
    each('[data-session-pause]', function (el) {
      el.textContent = status === 'paused' ? 'Resume session' : 'Pause session';
      el.disabled = !isActive;
    });
    each('[data-session-end]', function (el) { el.disabled = !isActive; });

    // Dashboard mirror.
    setText(
      '[data-session-current-subject]',
      isActive ? state.subject : 'No active session'
    );
    setText(
      '[data-session-current-goal]',
      isActive
        ? (state.goal || 'No goal set for this session')
        : 'Start a study session to set your subject and goal.'
    );
    setText(
      '[data-session-current-meta]',
      isActive
        ? 'Started ' + formatClockTime(state.startTime) + ' · ' + formatElapsed(state.totalDurationMs) + ' elapsed'
        : '—'
    );
    setText(
      '[data-session-current-pomodoros]',
      isActive ? String(state.pomodorosCompleted) : '0'
    );

    setText('[data-session-history-count]', String(state.sessionCount));

    renderHistory(state.history);
  }

  /**
   * One row per stored session. This is the table that used to empty
   * itself on every refresh — since Phase 9 the records come from
   * IndexedDB (and from the cloud once you are signed in).
   *
   * Columns: When · Subject (+ goal) · Duration · Focused (score/rating)
   *          · Distractions · Pomodoros · Coins · Status
   */
  function historyRowHtml(record) {
    var measured = record.measured === true && record.focusedDurationMs !== null;

    var focusCell = !measured
      ? '<span class="muted small">not measured</span>'
      : formatDuration(record.focusedDurationMs) +
        (record.focusScore === null || record.focusScore === undefined
          ? ''
          : '<br /><span class="muted small">Score ' + record.focusScore +
            (record.focusRating ? ' · ' + escapeHtml(record.focusRating) : '') + '</span>');

    var coins = record.focusCoinsEarned || 0;

    return (
      '<tr>' +
        '<td><span class="nowrap">' + formatDateTime(record.startTime) + '</span></td>' +
        '<td><strong>' + escapeHtml(record.subject) + '</strong>' +
          (record.goal ? '<br /><span class="muted small">' + escapeHtml(record.goal) + '</span>' : '') +
        '</td>' +
        '<td>' + formatDuration(record.totalDurationMs) + '</td>' +
        '<td>' + focusCell + '</td>' +
        '<td>' + (record.distractionCount || 0) + '</td>' +
        '<td>' + (record.pomodorosCompleted || 0) + '</td>' +
        '<td>' + coins + '</td>' +
        '<td><span class="pill pill--soft">' + (RECORD_LABELS[record.status] || record.status) + '</span></td>' +
      '</tr>'
    );
  }

  function renderHistory(history) {
    var tables = document.querySelectorAll('[data-session-history]');
    if (tables.length === 0) return;

    var records = history || [];

    tables.forEach(function (tbody) {
      var limit = parseInt(tbody.dataset.historyLimit, 10);
      var rows = isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;

      if (rows.length === 0) {
        tbody.innerHTML =
          '<tr class="table__empty"><td colspan="8">No sessions yet — finish one and it will be listed here.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map(historyRowHtml).join('');
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* -------------------------------------------------------------------
     Session summary
     ------------------------------------------------------------------- */

  /** "12m 30s", or a dash when the session was never measured. */
  function measuredOrDash(ms, measured) {
    if (!measured) return '—';
    return formatDuration(ms || 0);
  }

  function showSummary(record) {
    var modal = document.querySelector('[data-session-summary]');
    if (!modal) return;

    // Everything attention-related comes from the focus engine (Phase 8).
    // `measured` is false when the camera was off for the whole session.
    var measured = record.measured === true;
    var score = record.focusScore === null || record.focusScore === undefined
      ? '—'
      : String(record.focusScore);

    var fields = {
      subject: escapeHtml(record.subject),
      goal: record.goal ? escapeHtml(record.goal) : 'No goal set',
      start: formatClockTime(record.startTime),
      end: formatClockTime(record.endTime),
      elapsed: formatDuration(record.totalDurationMs),
      active: formatDuration(record.activeDurationMs),
      paused: formatDuration(record.pausedDurationMs),
      break: formatDuration(record.breakDurationMs),
      focus: measuredOrDash(record.focusedDurationMs, measured),
      distracted: measuredOrDash(record.distractedDurationMs, measured),
      'face-missing': measuredOrDash(record.faceMissingDurationMs, measured),
      distractions: String(record.distractionCount || 0),
      score: score,
      rating: record.focusRating || 'Not measured',
      coins: String(record.focusCoinsEarned || 0),
      pomodoros: String(record.pomodorosCompleted),
      status: RECORD_LABELS[record.status] || record.status,
    };

    Object.keys(fields).forEach(function (key) {
      var el = modal.querySelector('[data-summary="' + key + '"]');
      if (!el) return;
      el.innerHTML = fields[key];
      if (key === 'rating') el.dataset.rating = record.focusRatingKey || 'none';
    });

    modal.hidden = false;
    // Move focus to the close button so keyboard users land inside the dialog.
    var closeBtn = modal.querySelector('[data-summary-close]');
    if (closeBtn) closeBtn.focus();
  }

  function hideSummary() {
    var modal = document.querySelector('[data-session-summary]');
    if (modal) modal.hidden = true;
  }

  /* -------------------------------------------------------------------
     Wiring
     ------------------------------------------------------------------- */

  function bindForm(manager) {
    var form = document.querySelector('[data-session-form]');
    if (!form) return;

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      var subjectEl = document.querySelector('[data-session-field="subject"]');
      var goalEl = document.querySelector('[data-session-field="goal"]');
      var errorEl = document.querySelector('[data-session-form-error]');

      var subject = subjectEl ? subjectEl.value.trim() : '';
      if (!subject) {
        if (errorEl) {
          errorEl.textContent = 'Please enter a subject before starting.';
          errorEl.hidden = false;
        }
        if (subjectEl) subjectEl.focus();
        return;
      }

      if (errorEl) errorEl.hidden = true;

      var started = manager.start({
        subject: subject,
        goal: goalEl ? goalEl.value.trim() : '',
      });

      if (started) {
        form.reset();
        // Handy nudge: the session clock is now running.
        console.info('FocusGuard: study session started —', started.subject);
      }
    });
  }

  function bindControls(manager) {
    each('[data-session-pause]', function (el) {
      el.addEventListener('click', function () { manager.togglePause(); });
    });

    each('[data-session-end]', function (el) {
      el.addEventListener('click', function () { manager.end(); });
    });

    each('[data-summary-close]', function (el) {
      el.addEventListener('click', hideSummary);
    });

    // Clicking the dim backdrop closes the summary too.
    var modal = document.querySelector('[data-session-summary]');
    if (modal) {
      modal.addEventListener('click', function (event) {
        if (event.target === modal) hideSummary();
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') hideSummary();
    });
  }

  /**
   * The timer is created by js/timer-ui.js. Because that file is loaded
   * before this one, the instance is normally ready by the time we init.
   */
  function findTimer() {
    return global.FocusGuard && global.FocusGuard.timer ? global.FocusGuard.timer : null;
  }

  function init() {
    var manager = new SessionApi.SessionManager({ tickMs: 1000 });

    // Associate the Pomodoro timer with the study session so finished focus
    // blocks are counted on the session. If the timer is somehow not ready
    // yet, retry shortly.
    var timer = findTimer();
    if (timer) {
      manager.attachTimer(timer);
    } else {
      setTimeout(function () {
        var late = findTimer();
        if (late) manager.attachTimer(late);
      }, 300);
    }

    bindForm(manager);
    bindControls(manager);

    manager.on('change', render);
    manager.on('tick', render);
    manager.on('end', function (state, record) {
      console.info('FocusGuard: study session ended —', record);
      showSummary(record);
    });

    render(manager.getState());

    if (global.FocusGuard) global.FocusGuard.session = manager;
    else global.FocusGuard = { session: manager };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
