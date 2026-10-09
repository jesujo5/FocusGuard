/* =====================================================================
   FocusGuard — js/sync.js
   Phase 9 (Part 12–16, 21, 26, 27, 30, 41): the persistence coordinator.

   This module is the bridge between the running app and storage:

     camera → attention → focusEngine → study session
                                              │
                                        LOCAL (IndexedDB)
                                              │
                                        SYNC QUEUE
                                              │
                                    SUPABASE (cloud, per user)

   ---- What it does ----------------------------------------------------
     * saves a finished session, its distraction events and its coin
       ledger entries into IndexedDB (never per camera frame — only at
       session level / coin awards)
     * queues those records in an outbox (LOCAL → PENDING → SYNCING →
       SYNCED) and pushes them to Supabase when a user is signed in
     * loads the cloud copy on login and merges it with the local copy
       without ever duplicating or deleting unsynced data
     * keeps FocusGuard fully usable offline, with a small status chip
     * namespaces every local record by user id, so two accounts on one
       browser never see each other's data

   ---- Duplicate prevention (Part 9/13) -------------------------------
   The same local record always carries the same id, and every cloud write
   is an idempotent UPSERT on that id, so syncing twice can never create a
   second row:

     study_sessions.id       the session id made by js/session.js
     distraction_events.id   'de-<sessionId>-<n>'
     coin_ledger.id          'cl-<sessionId>-<focusedSeconds>'
     daily_goals.id          '<userId>:<YYYY-MM-DD>'
     user_settings           primary key = user_id

   Coin totals are never sent as a balance: only ledger *entries* travel,
   each with its own stable id, so 41 coins can never become 123.

   ---- Console ---------------------------------------------------------
     const s = window.FocusGuard.sync;
     s.getState(); await s.flush(); await s.loadFromCloud();
   ===================================================================== */

(function (global) {
  'use strict';

  var cloud = global.FocusGuardCloud;
  var store = global.FocusGuardLocalStore;

  if (!cloud || !store) {
    console.warn('FocusGuard: js/supabase.js and js/localStore.js must load before js/sync.js');
    return;
  }

  /* -------------------------------------------------------------------
     1. Tables, priorities and idempotency keys
     -------------------------------------------------------------------
     Priority is the sync order required by Part 14: a session exists
     remotely before anything that points at it.
     ------------------------------------------------------------------- */

  var TABLES = {
    profiles:          { table: 'profiles',           conflict: 'user_id', priority: 0 },
    worlds:            { table: 'worlds',             conflict: 'id',      priority: 1 },
    sessions:          { table: 'study_sessions',     conflict: 'id',      priority: 1 },
    distractionEvents: { table: 'distraction_events', conflict: 'id',      priority: 2 },
    coinLedger:        { table: 'coin_ledger',        conflict: 'id',      priority: 3 },
    dailyGoals:        { table: 'daily_goals',        conflict: 'id',      priority: 4 },
    settings:          { table: 'user_settings',      conflict: 'user_id', priority: 5 },
    worldObjects:      { table: 'world_objects',      conflict: 'id',      priority: 6 },
    worldExpansions:   { table: 'world_expansions',   conflict: 'id',      priority: 7 },
  };

  var STATUS = {
    LOCAL: 'local',
    SYNCING: 'syncing',
    SYNCED: 'synced',
    OFFLINE: 'offline',
    ERROR: 'error',
    UNAVAILABLE: 'unavailable',
  };

  var SYNC_ORDER = ['worlds', 'sessions', 'distractionEvents', 'coinLedger', 'dailyGoals', 'settings', 'worldObjects', 'worldExpansions', 'profiles'];
  var FLUSH_DEBOUNCE_MS = 900;
  var RETRY_MS = 30000;
  var ACTIVE_SAVE_MS = 5000;
  var TOAST_MS = 3200;

  /* -------------------------------------------------------------------
     2. State
     ------------------------------------------------------------------- */

  var guestId = store.GUEST_ID;

  var userId = guestId;
  var status = STATUS.LOCAL;
  var lastError = '';
  var lastSyncAt = null;
  var pending = 0;
  var inflight = false;
  var ready = false;
  var lastActiveWrite = 0;
  var flushTimer = null;
  var retryTimer = null;
  var toastTimer = null;
  var recovery = null;

  var handlers = { change: [], sync: [] };
  var unsubscribers = [];

  /* -------------------------------------------------------------------
     3. Small helpers
     ------------------------------------------------------------------- */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function setText(selector, text) {
    each(selector, function (el) {
      if (el.textContent !== text) el.textContent = text;
    });
  }

  function setVisible(selector, visible) {
    each(selector, function (el) { el.hidden = !visible; });
  }

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
  }

  function clockMs(value) {
    var number = Number(value);
    return isFinite(number) && number > 0 ? Math.round(number) : 0;
  }

  function seconds(ms) {
    return Math.max(0, Math.round((Number(ms) || 0) / 1000));
  }

  function iso(value) {
    var ms = clockMs(value);
    return ms ? new Date(ms).toISOString() : null;
  }

  function fromIso(value, fallback) {
    if (!value) return fallback === undefined ? null : fallback;
    var ms = Date.parse(value);
    return isFinite(ms) ? ms : (fallback === undefined ? null : fallback);
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
  }

  /** Local calendar day, e.g. 2026-10-06 (dates are displayed in local time). */
  function dateKey(epochMs) {
    var date = new Date(clockMs(epochMs) || Date.now());
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + day;
  }

  function isSignedIn() {
    var auth = module('auth');
    return !!(auth && typeof auth.isSignedIn === 'function' && auth.isSignedIn());
  }

  function engine() { return module('focusEngine'); }

  function activeSessionKey(uid) { return 'active-session:' + (uid || userId); }

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

  function emit(eventName, payload) {
    (handlers[eventName] || []).forEach(function (fn) { fn(payload); });
  }

  /* -------------------------------------------------------------------
     4. Row mappers — local (camelCase, epoch ms) ⇄ cloud (snake_case, ISO)
     -------------------------------------------------------------------
     Local records are the app's own shape; the cloud rows are exactly the
     columns in supabase/schema.sql. Keeping the two apart means the rest
     of the app never has to think in snake_case.
     ------------------------------------------------------------------- */

  function sessionFromRecord(record, uid) {
    var measured = record.measured === true;
    return {
      id: record.id,
      userId: uid,
      subject: record.subject || '',
      goal: record.goal || '',
      startTime: clockMs(record.startTime),
      endTime: clockMs(record.endTime),
      elapsedDuration: seconds(record.totalDurationMs),
      activeDuration: seconds(record.activeDurationMs),
      pausedDuration: seconds(record.pausedDurationMs),
      focusedDuration: measured ? seconds(record.focusedDurationMs) : null,
      distractedDuration: measured ? seconds(record.distractedDurationMs) : null,
      faceMissingDuration: measured ? seconds(record.faceMissingDurationMs) : null,
      unclassifiedDuration: measured ? seconds(record.unclassifiedDurationMs) : null,
      distractionCount: Math.max(0, Math.floor(record.distractionCount || 0)),
      pomodorosCompleted: Math.max(0, Math.floor(record.pomodorosCompleted || 0)),
      focusScore: numberOrNull(record.focusScore),
      focusRating: record.focusRating || null,
      focusCoinsEarned: Math.max(0, Math.floor(record.focusCoinsEarned || 0)),
      measured: measured,
      status: record.status || 'completed',
      createdAt: clockMs(record.createdAt) || clockMs(record.startTime),
      updatedAt: Date.now(),
    };
  }

  function sessionToCloud(row) {
    return {
      id: row.id,
      user_id: row.userId,
      subject: row.subject,
      goal: row.goal,
      start_time: iso(row.startTime),
      end_time: iso(row.endTime),
      elapsed_duration: row.elapsedDuration,
      active_duration: row.activeDuration,
      paused_duration: row.pausedDuration,
      focused_duration: row.focusedDuration,
      distracted_duration: row.distractedDuration,
      face_missing_duration: row.faceMissingDuration,
      unclassified_duration: row.unclassifiedDuration,
      distraction_count: row.distractionCount,
      pomodoros_completed: row.pomodorosCompleted,
      focus_score: row.focusScore,
      focus_rating: row.focusRating,
      focus_coins_earned: row.focusCoinsEarned,
      measured: row.measured === true,
      status: row.status,
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt || Date.now()),
    };
  }

  function sessionFromCloud(row, uid) {
    return {
      id: row.id,
      userId: uid,
      subject: row.subject || '',
      goal: row.goal || '',
      startTime: fromIso(row.start_time, Date.now()),
      endTime: fromIso(row.end_time, Date.now()),
      elapsedDuration: numberOrNull(row.elapsed_duration) || 0,
      activeDuration: numberOrNull(row.active_duration) || 0,
      pausedDuration: numberOrNull(row.paused_duration) || 0,
      focusedDuration: numberOrNull(row.focused_duration),
      distractedDuration: numberOrNull(row.distracted_duration),
      faceMissingDuration: numberOrNull(row.face_missing_duration),
      unclassifiedDuration: numberOrNull(row.unclassified_duration),
      distractionCount: numberOrNull(row.distraction_count) || 0,
      pomodorosCompleted: numberOrNull(row.pomodoros_completed) || 0,
      focusScore: numberOrNull(row.focus_score),
      focusRating: row.focus_rating || null,
      focusCoinsEarned: numberOrNull(row.focus_coins_earned) || 0,
      measured: row.measured === true,
      status: row.status || 'completed',
      createdAt: fromIso(row.created_at, Date.now()),
      updatedAt: fromIso(row.updated_at, Date.now()),
    };
  }

  /** A stored session turned back into the record the session UI renders. */
  function sessionToViewRecord(row) {
    return {
      id: row.id,
      subject: row.subject,
      goal: row.goal,
      startTime: row.startTime,
      endTime: row.endTime,
      totalDurationMs: (row.elapsedDuration || 0) * 1000,
      activeDurationMs: (row.activeDuration || 0) * 1000,
      pausedDurationMs: (row.pausedDuration || 0) * 1000,
      focusedDurationMs: row.focusedDuration === null ? null : (row.focusedDuration || 0) * 1000,
      distractedDurationMs: row.distractedDuration === null ? null : (row.distractedDuration || 0) * 1000,
      faceMissingDurationMs: row.faceMissingDuration === null ? null : (row.faceMissingDuration || 0) * 1000,
      unclassifiedDurationMs: row.unclassifiedDuration === null ? null : (row.unclassifiedDuration || 0) * 1000,
      distractionCount: row.distractionCount || 0,
      pomodorosCompleted: row.pomodorosCompleted || 0,
      focusScore: row.focusScore,
      focusRating: row.focusRating,
      focusRatingKey: ratingKeyOf(row.focusRating),
      focusCoinsEarned: row.focusCoinsEarned || 0,
      breakDurationMs: 0,
      measured: row.measured === true,
      status: row.status,
      createdAt: row.createdAt,
      recovered: true,
      storedAt: row.updatedAt,
    };
  }

  function ratingKeyOf(label) {
    if (!label) return null;
    var engineApi = engine();
    var ratings = engineApi && engineApi.RATINGS ? engineApi.RATINGS : [];
    for (var i = 0; i < ratings.length; i += 1) {
      if (ratings[i].label === label) return ratings[i].key;
    }
    return null;
  }

  function eventsFromSession(record, uid) {
    var distraction = module('distraction');
    var data = distraction && distraction.getLastSessionData ? distraction.getLastSessionData() : null;
    var events = (data && data.events) || [];
    return events.map(function (event, index) {
      return {
        id: 'de-' + record.id + '-' + (index + 1),
        userId: uid,
        sessionId: record.id,
        startTime: clockMs(event.startTime),
        endTime: clockMs(event.endTime),
        duration: seconds(event.duration),
        reason: event.reason === 'FACE_MISSING' ? 'FACE_MISSING' : 'HEAD_AWAY',
        createdAt: clockMs(event.startTime),
        updatedAt: Date.now(),
      };
    });
  }

  function eventToCloud(row) {
    return {
      id: row.id,
      user_id: row.userId,
      session_id: row.sessionId,
      start_time: iso(row.startTime),
      end_time: iso(row.endTime),
      duration: row.duration,
      reason: row.reason,
      created_at: iso(row.createdAt),
    };
  }

  function eventFromCloud(row, uid) {
    return {
      id: row.id,
      userId: uid,
      sessionId: row.session_id || null,
      startTime: fromIso(row.start_time, Date.now()),
      endTime: fromIso(row.end_time, Date.now()),
      duration: numberOrNull(row.duration) || 0,
      reason: row.reason || 'HEAD_AWAY',
      createdAt: fromIso(row.created_at, Date.now()),
      updatedAt: fromIso(row.created_at, Date.now()),
    };
  }

  /**
   * The ledger id is derived from the session id and the focused seconds
   * at the moment of the award. It is stable (so re-syncing upserts the
   * same row) and unique per award (so nothing is ever double-paid).
   */
  function ledgerIdFor(entry) {
    // A world purchase carries its own stable id, so retrying a purchase
    // always lands on the same ledger row (never a second charge).
    if (entry.purchaseId) return 'wp-' + entry.purchaseId;
    if (entry.sessionId) {
      return 'cl-' + entry.sessionId + '-' + Math.max(0, Math.floor(entry.focusedSeconds || 0));
    }
    return 'cl-none-' + clockMs(entry.timestamp) + '-' + Math.max(0, Math.floor(entry.amount || 0));
  }

  function ledgerFromEntry(entry, uid) {
    return {
      id: ledgerIdFor(entry),
      userId: uid,
      sessionId: entry.sessionId || null,
      type: entry.type || 'FOCUSED_TIME',
      // Positive for focused time, negative for a Phase 10 world purchase.
      amount: Math.floor(entry.amount || 0),
      timestamp: clockMs(entry.timestamp) || Date.now(),
      focusedSeconds: Math.max(0, Math.floor(entry.focusedSeconds || 0)),
      rule: entry.rule || '1 focused minute = 1 Focus Coin',
      createdAt: clockMs(entry.timestamp) || Date.now(),
      updatedAt: Date.now(),
    };
  }

  function ledgerToCloud(row) {
    return {
      id: row.id,
      user_id: row.userId,
      session_id: row.sessionId,
      type: row.type,
      amount: row.amount,
      timestamp: iso(row.timestamp),
      focused_seconds: row.focusedSeconds,
      rule: row.rule,
      created_at: iso(row.createdAt),
    };
  }

  function ledgerFromCloud(row, uid) {
    return {
      id: row.id,
      userId: uid,
      sessionId: row.session_id || null,
      type: row.type || 'FOCUSED_TIME',
      amount: numberOrNull(row.amount) || 0,
      timestamp: fromIso(row.timestamp, Date.now()),
      focusedSeconds: numberOrNull(row.focused_seconds) || 0,
      rule: row.rule || '1 focused minute = 1 Focus Coin',
      createdAt: fromIso(row.created_at, Date.now()),
      updatedAt: fromIso(row.created_at, Date.now()),
    };
  }

  /** Back to the shape js/focusEngine.js keeps in its own ledger. */
  function ledgerToEngineEntry(row) {
    return {
      id: row.id,
      type: row.type,
      amount: row.amount,
      timestamp: row.timestamp,
      sessionId: row.sessionId,
      focusedSeconds: row.focusedSeconds,
      rule: row.rule,
    };
  }

  /* ---------- Focus World rows (Phase 10) ----------------------------- */

  function worldToCloud(row) {
    return {
      id: row.id,
      user_id: row.userId,
      grid_size: Math.max(5, Math.floor(row.gridSize || 5)),
      biome: row.biome || 'meadow',
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt || Date.now()),
    };
  }

  function worldFromCloud(row, uid) {
    return {
      id: row.id,
      userId: uid,
      gridSize: numberOrNull(row.grid_size) || 5,
      biome: row.biome || 'meadow',
      createdAt: fromIso(row.created_at, Date.now()),
      updatedAt: fromIso(row.updated_at, Date.now()),
    };
  }

  function objectToCloud(row) {
    return {
      id: row.id,
      world_id: row.worldId,
      user_id: row.userId,
      type: row.type,
      x: Math.floor(row.x || 0),
      y: Math.floor(row.y || 0),
      rotation: Math.floor(row.rotation || 0),
      deleted: row.deleted === true,
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt || Date.now()),
    };
  }

  function objectFromCloud(row, uid) {
    return {
      id: row.id,
      userId: uid,
      worldId: row.world_id || null,
      type: row.type,
      x: numberOrNull(row.x) || 0,
      y: numberOrNull(row.y) || 0,
      rotation: numberOrNull(row.rotation) || 0,
      deleted: row.deleted === true,
      createdAt: fromIso(row.created_at, Date.now()),
      updatedAt: fromIso(row.updated_at, Date.now()),
    };
  }

  function expansionToCloud(row) {
    return {
      id: row.id,
      world_id: row.worldId,
      user_id: row.userId,
      old_grid_size: Math.floor(row.oldGridSize || 0),
      new_grid_size: Math.floor(row.newGridSize || 0),
      cost: Math.floor(row.cost || 0),
      created_at: iso(row.createdAt),
    };
  }

  function expansionFromCloud(row, uid) {
    return {
      id: row.id,
      userId: uid,
      worldId: row.world_id || null,
      oldGridSize: numberOrNull(row.old_grid_size) || 0,
      newGridSize: numberOrNull(row.new_grid_size) || 0,
      cost: numberOrNull(row.cost) || 0,
      createdAt: fromIso(row.created_at, Date.now()),
      updatedAt: fromIso(row.created_at, Date.now()),
    };
  }

  function goalFromSettings(uid, targetMinutes) {
    var date = dateKey(Date.now());
    return {
      id: uid + ':' + date,
      userId: uid,
      date: date,
      targetMinutes: Math.max(0, Math.round(targetMinutes || 0)),
      completedMinutes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function goalToCloud(row) {
    return {
      id: row.id,
      user_id: row.userId,
      date: row.date,
      target_minutes: row.targetMinutes,
      completed_minutes: row.completedMinutes,
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt || Date.now()),
    };
  }

  function goalFromCloud(row, uid) {
    return {
      id: row.id || (uid + ':' + row.date),
      userId: uid,
      date: row.date,
      targetMinutes: numberOrNull(row.target_minutes) || 0,
      completedMinutes: numberOrNull(row.completed_minutes) || 0,
      createdAt: fromIso(row.created_at, Date.now()),
      updatedAt: fromIso(row.updated_at, Date.now()),
    };
  }

  /**
   * Prompt 11: monitoring is automatic, so new rows store 'intelligent'.
   * The Prompt 10.5 values ('screen' / 'notebook') are still carried through
   * verbatim for older rows — nothing is silently rewritten on the way out.
   */
  var LEGACY_ATTENTION_MODES = ['screen', 'notebook'];

  function normaliseAttentionMode(value) {
    if (LEGACY_ATTENTION_MODES.indexOf(value) !== -1) return value;
    return 'intelligent';
  }

  function settingsToCloud(row) {
    return {
      user_id: row.userId,
      focus_minutes: row.focusMinutes,
      short_break_minutes: row.shortBreakMinutes,
      long_break_minutes: row.longBreakMinutes,
      auto_start_next: row.autoStartNext === true,
      sound_enabled: row.soundEnabled === true,
      attention_mode: normaliseAttentionMode(row.attentionMode),
      alerts_enabled: row.alertsEnabled !== false,
      grace_seconds: row.graceSeconds,
      camera_preference: row.cameraPreference || 'ask',
      daily_goal_minutes: row.dailyGoalMinutes,
      updated_at: iso(row.updatedAt || Date.now()),
    };
  }

  function settingsFromCloud(row, uid) {
    return {
      userId: uid,
      focusMinutes: numberOrNull(row.focus_minutes) || 25,
      shortBreakMinutes: numberOrNull(row.short_break_minutes) || 5,
      longBreakMinutes: numberOrNull(row.long_break_minutes) || 15,
      autoStartNext: row.auto_start_next !== false,
      soundEnabled: row.sound_enabled !== false,
      attentionMode: normaliseAttentionMode(row.attention_mode),
      alertsEnabled: row.alerts_enabled !== false,
      graceSeconds: numberOrNull(row.grace_seconds) || 5,
      cameraPreference: row.camera_preference || 'ask',
      dailyGoalMinutes: numberOrNull(row.daily_goal_minutes) || 120,
      updatedAt: fromIso(row.updated_at, Date.now()),
    };
  }

  function profileToCloud(row) {
    return {
      user_id: row.userId,
      email: row.email || '',
      updated_at: iso(row.updatedAt || Date.now()),
    };
  }

  function profileFromCloud(row, uid) {
    return {
      userId: uid,
      email: row.email || '',
      createdAt: fromIso(row.created_at, Date.now()),
      updatedAt: fromIso(row.updated_at, Date.now()),
    };
  }

  /* -------------------------------------------------------------------
     5. The sync queue (the outbox)
     -------------------------------------------------------------------
     One queue row per entity + operation, so re-saving the same record
     updates the pending payload instead of adding a second row.
     ------------------------------------------------------------------- */

  function enqueue(entityType, entityId, operation, payload) {
    var def = TABLES[entityType];
    if (!def || !entityId) return Promise.resolve(null);

    var record = {
      id: 'q-' + entityType + '-' + entityId + '-' + (operation || 'upsert'),
      userId: userId,
      entityType: entityType,
      entityId: String(entityId),
      operation: operation || 'upsert',
      table: def.table,
      payload: payload,
      createdAt: Date.now(),
      retryCount: 0,
      status: 'PENDING',
    };

    return store.put('syncQueue', record)
      .then(refreshPending)
      .then(function () { return record; });
  }

  function refreshPending() {
    var uid = userId;
    return store.all('syncQueue', { userId: uid }).then(function (rows) {
      pending = rows.filter(function (row) { return row.status !== 'SYNCED'; }).length;
      render();
      return pending;
    });
  }

  function queueOrderKey(row) {
    var def = TABLES[row.entityType];
    var priority = def ? def.priority : 9;
    return String(priority) + '|' + String(row.createdAt || 0).padStart(15, '0') + '|' + row.id;
  }

  function pendingKeys(rows) {
    var keys = {};
    rows.forEach(function (row) { keys[row.entityType + ':' + row.entityId] = true; });
    return keys;
  }

  /* -------------------------------------------------------------------
     6. Flushing the queue to Supabase
     ------------------------------------------------------------------- */

  function pushQueueRow(row) {
    var def = TABLES[row.entityType];
    if (!def) return Promise.resolve({ ok: false, error: { message: 'Unknown entity' } });

    return cloud.upsert(def.table, row.payload, def.conflict).then(function (result) {
      if (result && result.error) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    });
  }

  function markFailed(row, error) {
    var updated = Object.assign({}, row, {
      status: navigatorOnLine() ? 'ERROR' : 'PENDING',
      retryCount: (row.retryCount || 0) + 1,
      lastError: cloud.message(error),
      lastAttemptAt: Date.now(),
    });
    lastError = updated.lastError || 'Sync failed';
    return store.put('syncQueue', updated);
  }

  function navigatorOnLine() {
    return global.navigator ? global.navigator.onLine !== false : true;
  }

  /**
   * Push everything waiting, oldest first, in the required order.
   * Stops at the first failure so a session never lands after the
   * distraction events that point at it.
   */
  function processQueue(rows, index) {
    if (index >= rows.length) return Promise.resolve(true);

    var row = rows[index];
    return pushQueueRow(row).then(function (result) {
      if (!result.ok) {
        return markFailed(row, result.error).then(function () {
          setStatus(navigatorOnLine() ? STATUS.ERROR : STATUS.OFFLINE,
            navigatorOnLine()
              ? 'Cloud sync failed for now — your data is saved locally.'
              : 'Cloud sync unavailable — your data is saved locally.');
          return false;
        });
      }
      return store.remove('syncQueue', row.id).then(function () {
        return processQueue(rows, index + 1);
      });
    });
  }

  function flush(reason) {
    if (inflight) return Promise.resolve(false);
    if (!isSignedIn()) {
      setStatus(STATUS.LOCAL, 'Local only — log in to sync your data.');
      return refreshPending().then(function () { return false; });
    }
    if (!cloud.isConfigured()) {
      setStatus(STATUS.UNAVAILABLE, 'Cloud sync is not configured — your data is saved locally.');
      return refreshPending().then(function () { return false; });
    }

    // Local-first during a session: a session's rows are pushed together
    // when it finishes, so a coin entry can never reach the cloud before
    // the session it belongs to. Nothing is lost — it waits in the queue.
    var session = module('session');
    if (session && typeof session.getState === 'function' && session.getState().isActive) {
      setStatus(STATUS.LOCAL, 'Saving locally during your session — syncing when it ends.');
      return refreshPending().then(function () { return false; });
    }

    inflight = true;
    setStatus(STATUS.SYNCING, 'Syncing…');

    return store.all('syncQueue', { userId: userId })
      .then(function (rows) {
        var waiting = rows
          .filter(function (row) { return row.status !== 'SYNCED'; })
          .sort(function (a, b) {
            return queueOrderKey(a) < queueOrderKey(b) ? -1 : 1;
          });

        if (waiting.length === 0) {
          inflight = false;
          setStatus(STATUS.SYNCED, 'Cloud sync complete.');
          return true;
        }

        return processQueue(waiting, 0).then(function (ok) {
          inflight = false;
          return refreshPending().then(function () {
            if (ok) {
              lastSyncAt = Date.now();
              lastError = '';
              setStatus(STATUS.SYNCED, 'Cloud sync complete.');
              emit('sync', { reason: reason || 'manual', ok: true });
              toast('Cloud sync complete.', 'ok');
            } else {
              emit('sync', { reason: reason || 'manual', ok: false, error: lastError });
            }
            return ok;
          });
        });
      })
      .catch(function (error) {
        inflight = false;
        setStatus(STATUS.ERROR, 'Cloud sync failed for now — your data is saved locally.');
        lastError = cloud.message(error);
        return false;
      });
  }

  function scheduleFlush(reason) {
    if (flushTimer !== null) global.clearTimeout(flushTimer);
    flushTimer = global.setTimeout(function () {
      flushTimer = null;
      flush(reason || 'scheduled');
    }, FLUSH_DEBOUNCE_MS);
  }
  /* -------------------------------------------------------------------
     7. Writing local records (the "save" half)
     ------------------------------------------------------------------- */

  function writeRows(entityType, rows) {
    if (!rows || rows.length === 0) return Promise.resolve(0);
    var toCloud = CLOUD_MAPPERS[entityType];
    var keyOf = KEY_OF[entityType];

    return store.bulkPut(entityType, rows).then(function () {
      return rows.reduce(function (chain, row) {
        return chain.then(function () {
          return enqueue(entityType, keyOf(row), 'upsert', toCloud(row));
        });
      }, Promise.resolve(true));
    }).then(function () { return rows.length; });
  }

  var KEY_OF = {
    profiles: function (row) { return row.userId; },
    sessions: function (row) { return row.id; },
    distractionEvents: function (row) { return row.id; },
    coinLedger: function (row) { return row.id; },
    dailyGoals: function (row) { return row.id; },
    settings: function (row) { return row.userId; },
    worlds: function (row) { return row.id; },
    worldObjects: function (row) { return row.id; },
    worldExpansions: function (row) { return row.id; },
  };

  var CLOUD_MAPPERS = {
    profiles: profileToCloud,
    sessions: sessionToCloud,
    distractionEvents: eventToCloud,
    coinLedger: ledgerToCloud,
    dailyGoals: goalToCloud,
    settings: settingsToCloud,
    worlds: worldToCloud,
    worldObjects: objectToCloud,
    worldExpansions: expansionToCloud,
  };

  var LOCAL_MAPPERS = {
    profiles: profileFromCloud,
    sessions: sessionFromCloud,
    distractionEvents: eventFromCloud,
    coinLedger: ledgerFromCloud,
    dailyGoals: goalFromCloud,
    settings: settingsFromCloud,
    worlds: worldFromCloud,
    worldObjects: objectFromCloud,
    worldExpansions: expansionFromCloud,
  };

  function storeKeyOf(entityType, localRow) {
    return entityType === 'settings' || entityType === 'profiles' ? localRow.userId : localRow.id;
  }

  /**
   * A finished study session: the session row, its distraction events and
   * its coin ledger entries. This is the only moment a whole session is
   * written — never once per camera frame.
   */
  function persistSession(record) {
    if (!record || !record.id) return Promise.resolve(null);
    var uid = userId;
    var sessionRow = sessionFromRecord(record, uid);
    var eventRows = eventsFromSession(record, uid);

    var engineApi = engine();
    var ledgerRows = (engineApi && engineApi.getLedger ? engineApi.getLedger() : [])
      .filter(function (entry) { return entry.sessionId === record.id; })
      .map(function (entry) { return ledgerFromEntry(entry, uid); });

    emit('session-saved', { sessionId: record.id, userId: uid });

    return writeRows('sessions', [sessionRow])
      .then(function () { return writeRows('distractionEvents', eventRows); })
      .then(function () { return writeRows('coinLedger', ledgerRows); })
      .then(function () { return clearActiveSession(uid); })
      .then(function () { return refreshDailyGoal(); })
      .then(function () {
        toast('Saved locally.', 'ok');
        emit('session-persisted', { session: sessionRow, events: eventRows.length, coinEntries: ledgerRows.length });
        return sessionRow;
      })
      .then(function (row) {
        scheduleFlush('session-end');
        return row;
      });
  }

  /** One coin award from the focus engine → one ledger row + queue row. */
  function persistLedgerEntry(entry) {
    if (!entry) return Promise.resolve(null);
    var row = ledgerFromEntry(entry, userId);
    return writeRows('coinLedger', [row]).then(function () {
      scheduleFlush('coin');
      return row;
    });
  }

  /* ---------- Focus World writing (Phase 10) --------------------------- */

  /** The world itself: one row per user (grid size + biome). */
  function persistWorld(row) {
    if (!row || !row.id) return Promise.resolve(null);
    return writeRows('worlds', [row]).then(function () {
      scheduleFlush('world');
      return row;
    });
  }

  /** One placed object (or its soft-delete tombstone). */
  function persistWorldObject(row) {
    if (!row || !row.id) return Promise.resolve(null);
    return writeRows('worldObjects', [row]).then(function () {
      scheduleFlush('world-object');
      return row;
    });
  }

  /** One purchased land expansion. */
  function persistWorldExpansion(row) {
    if (!row || !row.id) return Promise.resolve(null);
    return writeRows('worldExpansions', [row]).then(function () {
      scheduleFlush('world-expansion');
      return row;
    });
  }

  /* ---------- Session recovery note (Part 22) ---------- */

  function saveActiveSession(uid) {
    var session = module('session');
    if (!session || typeof session.snapshot !== 'function') return Promise.resolve(null);
    var snapshot = session.snapshot();
    if (!snapshot) return Promise.resolve(null);
    lastActiveWrite = Date.now();
    return store.setMeta(activeSessionKey(uid || userId), snapshot, uid || userId);
  }

  function clearActiveSession(uid) {
    lastActiveWrite = 0;
    return store.removeMeta(activeSessionKey(uid || userId));
  }

  /* -------------------------------------------------------------------
     8. Settings + daily goal
     ------------------------------------------------------------------- */

  function readNumberInput(selector, fallback) {
    var el = document.querySelector(selector);
    if (!el) return fallback;
    var value = parseFloat(el.value);
    return isFinite(value) ? value : fallback;
  }

  function collectSettings() {
    var timer = module('timer');
    var timerState = timer && typeof timer.getState === 'function' ? timer.getState() : null;
    var durations = (timerState && timerState.durations) || {};
    var soundEl = document.querySelector('[data-timer-setting="sound"]');
    var autoEl = document.querySelector('[data-timer-setting="autoStartNext"]');
    var attentionApi = module('attentionMode');
    var alertsEl = document.querySelector('[data-alert-setting="enabled"]');

    return {
      userId: userId,
      focusMinutes: Math.round(durations.focus || readNumberInput('[data-timer-setting="focus"]', 25)),
      shortBreakMinutes: Math.round(durations.shortBreak || readNumberInput('[data-timer-setting="shortBreak"]', 5)),
      longBreakMinutes: Math.round(durations.longBreak || readNumberInput('[data-timer-setting="longBreak"]', 15)),
      autoStartNext: autoEl ? !!autoEl.checked : true,
      soundEnabled: soundEl ? !!soundEl.checked : true,
      // Prompt 11: no selector any more — read the single automatic mode
      // from the module that presents it.
      attentionMode: (attentionApi && typeof attentionApi.get === 'function')
        ? attentionApi.get() : 'intelligent',
      alertsEnabled: alertsEl ? !!alertsEl.checked : true,
      graceSeconds: Math.round(readNumberInput('[data-distraction-setting="grace"]', 5)),
      cameraPreference: 'ask',
      dailyGoalMinutes: Math.round(readNumberInput('[data-setting="dailyGoalMinutes"]',
        (engine() && engine().getState().today.goalMinutes) || 120)),
      updatedAt: Date.now(),
    };
  }

  var settingsTimer = null;
  var applyingSettings = false;

  function saveSettings() {
    if (applyingSettings) return Promise.resolve(null);
    var row = collectSettings();
    return writeRows('settings', [row])
      .then(function () { return saveDailyGoal(row.dailyGoalMinutes); })
      .then(function () {
        scheduleFlush('settings');
        return row;
      });
  }

  function saveSettingsSoon() {
    if (applyingSettings) return;
    if (settingsTimer !== null) global.clearTimeout(settingsTimer);
    settingsTimer = global.setTimeout(function () {
      settingsTimer = null;
      saveSettings();
    }, 400);
  }

  /** Push stored settings back into the timer, the grace input and the goal. */
  function applySettings(row) {
    if (!row) return;
    applyingSettings = true;

    var values = {
      focus: row.focusMinutes,
      shortBreak: row.shortBreakMinutes,
      longBreak: row.longBreakMinutes,
      autoStartNext: row.autoStartNext,
      sound: row.soundEnabled,
    };

    each('[data-timer-setting]', function (el) {
      var key = el.dataset.timerSetting;
      if (!(key in values)) return;
      if (el.type === 'checkbox') {
        if (el.checked !== !!values[key]) {
          el.checked = !!values[key];
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (String(el.value) !== String(values[key])) {
        el.value = String(values[key]);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    each('[data-distraction-setting="grace"]', function (el) {
      if (String(el.value) !== String(row.graceSeconds)) {
        el.value = String(row.graceSeconds);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Prompt 10.5 — attention mode + attention sound alerts.
    var attentionMode = module('attentionMode');
    if (attentionMode && typeof attentionMode.applyFromSettings === 'function') {
      attentionMode.applyFromSettings(row.attentionMode || 'intelligent');
    }
    var alerts = module('soundAlerts');
    if (alerts && typeof alerts.setEnabled === 'function') {
      alerts.setEnabled(row.alertsEnabled !== false);
    }

    each('[data-setting="dailyGoalMinutes"]', function (el) {
      if (String(el.value) !== String(row.dailyGoalMinutes)) el.value = String(row.dailyGoalMinutes);
    });

    if (engine() && engine().setDailyGoalMinutes) engine().setDailyGoalMinutes(row.dailyGoalMinutes);
    applyingSettings = false;
    render();
  }

  /**
   * The daily goal row. `targetMinutes` is the user's choice; the
   * completed minutes are always derived from stored focused time, never
   * typed in (Part 20).
   */
  function saveDailyGoal(targetMinutes) {
    var uid = userId;
    var date = dateKey(Date.now());
    var id = uid + ':' + date;

    return store.get('dailyGoals', id).then(function (existing) {
      var engineApi = engine();
      var focusedMs = engineApi && engineApi.getState ? engineApi.getState().today.focusedMs : 0;
      var target = Math.max(0, Math.round(
        targetMinutes === undefined ? (existing ? existing.targetMinutes : 120) : targetMinutes));

      var row = {
        id: id,
        userId: uid,
        date: date,
        targetMinutes: target,
        completedMinutes: Math.floor((focusedMs || 0) / 60000),
        createdAt: existing ? existing.createdAt : Date.now(),
        updatedAt: Date.now(),
      };

      return writeRows('dailyGoals', [row]).then(function () { return row; });
    });
  }

  function refreshDailyGoal() {
    return saveDailyGoal(undefined);
  }

  /* -------------------------------------------------------------------
     9. Hydration — rebuilding the app from what is stored
     ------------------------------------------------------------------- */

  function todayTotals(rows, ledgerRows) {
    var today = dateKey(Date.now());
    var acc = { focusedMs: 0, distractedMs: 0, faceMissingMs: 0, sessions: 0, coins: 0, longestFocusedMs: 0 };

    rows.forEach(function (row) {
      if (dateKey(row.startTime) !== today) return;
      acc.sessions += 1;
      var focused = (row.focusedDuration || 0) * 1000;
      acc.focusedMs += focused;
      acc.distractedMs += (row.distractedDuration || 0) * 1000;
      acc.faceMissingMs += (row.faceMissingDuration || 0) * 1000;
      acc.longestFocusedMs = Math.max(acc.longestFocusedMs, focused);
    });

    // Coins come from the ledger (the source of truth), not from totals.
    // Earned today only: a world purchase is spending, not negative study.
    acc.coins = ledgerRows.reduce(function (sum, row) {
      return dateKey(row.timestamp) === today && row.amount > 0 ? sum + row.amount : sum;
    }, 0);

    return acc;
  }

  function hydrateFromLocal(uid) {
    return Promise.all([
      store.all('sessions', { userId: uid }),
      store.all('coinLedger', { userId: uid }),
      store.all('dailyGoals', { userId: uid }),
      store.get('settings', uid),
      store.getMeta(activeSessionKey(uid)),
      store.all('worlds', { userId: uid }),
      store.all('worldObjects', { userId: uid }),
      store.all('worldExpansions', { userId: uid }),
    ]).then(function (results) {
      var sessions = results[0] || [];
      var ledger = results[1] || [];
      var goals = results[2] || [];
      var settings = results[3] || null;
      var activeNote = results[4] || null;
      var worldRows = results[5] || [];
      var worldObjectRows = results[6] || [];
      var worldExpansionRows = results[7] || [];

      var engineApi = engine();
      if (engineApi && engineApi.hydrate) {
        engineApi.reset();
        engineApi.hydrate({
          ledger: ledger
            .slice()
            .sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); })
            .map(ledgerToEngineEntry),
          lifetimeFocusedClosedMs: sessions.reduce(function (sum, row) {
            return sum + (row.focusedDuration || 0) * 1000;
          }, 0),
          today: todayTotals(sessions, ledger),
          dailyGoalMinutes: settings ? settings.dailyGoalMinutes
            : (goals.length ? goals[goals.length - 1].targetMinutes : undefined),
        });
      }

      var session = module('session');
      if (session && typeof session.restoreHistory === 'function') {
        var records = sessions
          .slice()
          .sort(function (a, b) { return (b.startTime || 0) - (a.startTime || 0); })
          .map(sessionToViewRecord);
        session.restoreHistory(records);
      }

      if (settings) applySettings(settings);
      else if (goals.length) {
        var todayGoal = goals.filter(function (g) { return g.date === dateKey(Date.now()); })[0];
        if (todayGoal && engine() && engine().setDailyGoalMinutes) {
          engine().setDailyGoalMinutes(todayGoal.targetMinutes);
          each('[data-setting="dailyGoalMinutes"]', function (el) {
            el.value = String(todayGoal.targetMinutes);
          });
        }
      }

      // The Focus World is rebuilt from its own rows (js/world.js owns the
      // state; this module owns reading and writing the rows).
      var worldApi = module('world');
      if (worldApi && typeof worldApi.hydrate === 'function') {
        worldApi.hydrate({
          userId: uid,
          world: worldRows[0] || null,
          objects: worldObjectRows,
          expansions: worldExpansionRows,
        });
      }

      offerRecovery(activeNote);
      render();

      return {
        sessions: sessions.length,
        ledgerEntries: ledger.length,
        coins: ledger.reduce(function (sum, row) { return sum + (row.amount || 0); }, 0),
        goals: goals.length,
        settings: settings,
        worldObjects: worldObjectRows.length,
      };
    });
  }

  /* -------------------------------------------------------------------
     10. Cloud load + merge (Part 15/16)
     ------------------------------------------------------------------- */

  function mergeRemote(entityType, remoteRows, uid) {
    var toLocal = LOCAL_MAPPERS[entityType];
    if (!toLocal) return Promise.resolve(0);

    return store.all('syncQueue', { userId: uid }).then(function (queue) {
      var pendingMap = pendingKeys(queue);
      var accepted = [];

      return remoteRows.reduce(function (chain, remoteRow) {
        return chain.then(function () {
          var local = toLocal(remoteRow, uid);
          var key = storeKeyOf(entityType, local);
          return store.get(entityType, key).then(function (existing) {
            if (!existing) { accepted.push(local); return; }

            var unsynced = !!pendingMap[entityType + ':' + key];
            var remoteNewer = (local.updatedAt || 0) >= (existing.updatedAt || 0);

            // Last-updated wins. A local edit that has not been uploaded
            // yet is kept when the cloud copy is older (Part 16).
            if (!unsynced || remoteNewer) accepted.push(local);
            else if (entityType === 'settings' && remoteNewer) accepted.push(local);
          });
        });
      }, Promise.resolve()).then(function () {
        return store.bulkPut(entityType, accepted).then(function () { return accepted.length; });
      });
    });
  }

  function loadFromCloud() {
    if (!isSignedIn() || !cloud.isConfigured()) return Promise.resolve(false);
    var uid = userId;

    setStatus(STATUS.SYNCING, 'Loading your data from the cloud…');

    var names = ['profiles', 'worlds', 'sessions', 'distractionEvents', 'coinLedger', 'dailyGoals', 'settings', 'worldObjects', 'worldExpansions'];
    var merged = {};

    return names.reduce(function (chain, name) {
      return chain.then(function () {
        return cloud.list(TABLES[name].table, uid).then(function (result) {
          if (result.error) {
            lastError = cloud.message(result.error);
            setStatus(STATUS.ERROR, 'Cloud sync unavailable — your data is saved locally.');
            return false;
          }
          return mergeRemote(name, result.data || [], uid).then(function (count) {
            merged[name] = count;
            return true;
          });
        });
      });
    }, Promise.resolve()).then(function (ok) {
      if (!ok) return false;
      return hydrateFromLocal(uid).then(function () {
        lastSyncAt = Date.now();
        emit('cloud-loaded', merged);
        return flush('after-load').then(function () { return true; });
      });
    }).catch(function (error) {
      lastError = cloud.message(error);
      setStatus(STATUS.ERROR, 'Cloud sync unavailable — your data is saved locally.');
      return false;
    });
  }

  /* -------------------------------------------------------------------
     11. Switching namespaces (Part 24/25)
     ------------------------------------------------------------------- */

  function activateUser(nextUserId, options) {
    options = options || {};
    var uid = nextUserId || guestId;

    // A running session belongs to the namespace it started in: finish it
    // first so nothing is written under the wrong account.
    var session = module('session');
    if (session && session.getState && session.getState().isActive) {
      console.info('FocusGuard: ending the current session before switching account');
      session.end();
    }

    userId = uid;
    lastError = '';
    lastSyncAt = null;
    inflight = false;
    lastActiveWrite = 0;

    var engineApi = engine();
    if (engineApi && engineApi.reset) engineApi.reset();
    var sessionApi = module('session');
    if (sessionApi && sessionApi.restoreHistory) sessionApi.restoreHistory([]);

    setStatus(isSignedIn() ? STATUS.LOCAL : STATUS.LOCAL,
      isSignedIn() ? 'Local data loaded — syncing next.' : 'Local only — log in to sync your data.');
    render();

    return hydrateFromLocal(uid).then(function (summary) {
      if (options.skipCloud) return summary;
      if (!isSignedIn() || !cloud.isConfigured()) return summary;
      return loadFromCloud().then(function () { return summary; });
    }).then(function (summary) {
      return refreshPending().then(function () { return summary; });
    });
  }

  /** Called by js/auth.js after a successful sign-out. */
  function onSignOut(previousEmail) {
    // Nothing of the previous user stays in memory: the guest namespace is
    // loaded next, and any in-flight cloud request is ignored by the
    // namespace check in flush().
    var promise = activateUser(guestId, { skipCloud: true });
    toast(previousEmail ? 'Logged out. Local data only.' : 'Logged out.', 'info');
    setStatus(STATUS.LOCAL, 'Local only — log in to sync your data.');
    return promise;
  }

  /* -------------------------------------------------------------------
     12. Status UI + toasts (Part 27/28/43)
     ------------------------------------------------------------------- */

  function setStatus(next, detail) {
    status = next;
    if (detail !== undefined) statusDetail = detail;
    render();
    emit('change', getState());
  }

  var statusDetail = 'Local only — log in to sync your data.';

  function labelFor(next) {
    return {
      local: 'Local',
      syncing: 'Syncing…',
      synced: 'Synced',
      offline: 'Offline',
      error: 'Sync error',
      unavailable: 'Local only',
    }[next] || 'Local';
  }

  function lastSyncText() {
    if (!lastSyncAt) return 'never';
    var date = new Date(lastSyncAt);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function getState() {
    var auth = module('auth');
    var authState = auth && auth.getState ? auth.getState() : null;

    return {
      status: status,
      label: labelFor(status),
      detail: statusDetail,
      pending: pending,
      lastSyncAt: lastSyncAt,
      lastSyncText: lastSyncText(),
      lastError: lastError,
      userId: userId,
      namespace: userId,
      signedIn: isSignedIn(),
      email: authState ? authState.email : '',
      configured: cloud.isConfigured(),
      cloudReady: !!cloud.getClient(),
      online: navigatorOnLine(),
      storage: store.isAvailable() ? 'indexeddb' : 'memory',
      order: SYNC_ORDER.slice(),
      tables: TABLES,
      isImplemented: true,
    };
  }

  function render() {
    var state = getState();

    setText('[data-sync-status]', state.label);
    setText('[data-sync-detail]', state.detail);
    setText('[data-sync-pending]', String(state.pending));
    setText('[data-sync-last]', state.lastSyncText);
    setText('[data-sync-account]', state.email || 'Not signed in');
    setText('[data-sync-namespace]', state.namespace);

    each('[data-sync-state]', function (el) { el.dataset.syncState = state.status; });
    each('[data-sync-pill]', function (el) {
      el.setAttribute('title', 'Cloud: ' + state.label + ' — ' + state.detail);
    });
  }

  function toast(text, kind) {
    var el = document.querySelector('[data-toast]');
    if (!el) return;
    el.textContent = text;
    el.dataset.toastKind = kind || 'info';
    el.hidden = false;
    if (toastTimer !== null) global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () {
      toastTimer = null;
      el.hidden = true;
    }, TOAST_MS);
  }

  /* -------------------------------------------------------------------
     13. Session recovery (Part 22)
     ------------------------------------------------------------------- */

  function offerRecovery(note) {
    var banner = document.querySelector('[data-recovery]');
    if (!banner) return;
    if (!note || !note.id) {
      recovery = null;
      banner.hidden = true;
      return;
    }

    recovery = note;
    var subject = note.subject || 'Untitled session';
    var when = note.startTime ? new Date(note.startTime).toLocaleString([], { hour: '2-digit', minute: '2-digit' }) : 'earlier';
    setText('[data-recovery-text]', 'Previous session found: “' + subject + '” (started ' + when + ').');
    banner.hidden = false;
    console.info('FocusGuard: unfinished session found —', subject);
  }

  function hideRecovery() {
    var banner = document.querySelector('[data-recovery]');
    if (banner) banner.hidden = true;
  }

  function resumeRecovered() {
    var session = module('session');
    if (!recovery || !session || !session.restore) return Promise.resolve(false);
    session.restore(recovery);
    recovery = null;
    hideRecovery();
    toast('Session resumed — the camera stays off until you start it.', 'info');
    return saveActiveSession(userId).then(function () { return true; });
  }

  function endRecovered() {
    var session = module('session');
    if (!recovery || !session || !session.restore) return Promise.resolve(false);
    session.restore(recovery);
    recovery = null;
    hideRecovery();
    session.end();          // goes through the normal save path
    return Promise.resolve(true);
  }

  function discardRecovered() {
    recovery = null;
    hideRecovery();
    toast('Previous session discarded.', 'info');
    return clearActiveSession(userId);
  }

  /* -------------------------------------------------------------------
     14. Wiring
     ------------------------------------------------------------------- */

  function subscribeSession() {
    var session = module('session');
    if (!session || typeof session.on !== 'function') return;

    session.on('end', function (state, record) {
      clearActiveSession(userId);
      persistSession(record);
    });

    session.on('change', function (state) {
      if (!state || !state.isActive) return;
      if (Date.now() - lastActiveWrite >= ACTIVE_SAVE_MS) saveActiveSession(userId);
    });
  }

  function subscribeCoins() {
    var engineApi = engine();
    if (!engineApi || typeof engineApi.on !== 'function') return;
    engineApi.on('coin', function (payload) {
      if (!payload || !payload.entry) return;
      persistLedgerEntry(payload.entry);
    });
  }

  function subscribeAuth() {
    var auth = module('auth');
    if (!auth || typeof auth.on !== 'function') return;

    var previousId = auth.getState().userId;
    auth.on('change', function (state) {
      var nextId = state.isSignedIn ? state.userId : null;
      if (nextId === previousId) return;
      previousId = nextId;

      if (nextId) {
        toast('Logged in — loading your cloud data…', 'ok');
        activateUser(nextId);
      } else if (state.status !== 'working') {
        activateUser(guestId, { skipCloud: true });
      }
    });
  }

  function subscribeNetwork() {
    global.addEventListener('online', function () {
      toast('Cloud sync restored.', 'ok');
      flush('online');
    });
    global.addEventListener('offline', function () {
      setStatus(STATUS.OFFLINE, 'Offline — your data is saved locally.');
      toast('Offline — your data is saved locally.', 'warn');
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scheduleFlush('visible');
    });
  }

  function subscribeSettingsInputs() {
    each('[data-timer-setting]', function (el) {
      el.addEventListener('change', saveSettingsSoon);
    });
    each('[data-distraction-setting="grace"]', function (el) {
      el.addEventListener('change', saveSettingsSoon);
    });
    each('[data-setting="dailyGoalMinutes"]', function (el) {
      el.addEventListener('change', function () {
        var minutes = Math.max(0, Math.round(parseFloat(el.value) || 0));
        if (engine() && engine().setDailyGoalMinutes) engine().setDailyGoalMinutes(minutes);
        saveSettingsSoon();
      });
    });
  }

  function bindRecovery() {
    each('[data-recovery-resume]', function (el) {
      el.addEventListener('click', resumeRecovered);
    });
    each('[data-recovery-end]', function (el) {
      el.addEventListener('click', endRecovered);
    });
    each('[data-recovery-discard]', function (el) {
      el.addEventListener('click', discardRecovered);
    });
  }

  /** Pull the user's profile row from the cloud once the client is ready. */
  function saveProfile() {
    var auth = module('auth');
    if (!auth || !isSignedIn()) return Promise.resolve(null);
    var state = auth.getState();
    return writeRows('profiles', [{
      userId: userId,
      email: state.email || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
  }

  function init() {
    render();
    refreshPending();

    subscribeSession();
    subscribeCoins();
    subscribeAuth();
    subscribeNetwork();
    subscribeSettingsInputs();
    bindRecovery();

    // Periodic retry while something is waiting.
    retryTimer = global.setInterval(function () {
      if (pending > 0 && isSignedIn() && cloud.isConfigured()) flush('retry');
    }, RETRY_MS);

    // Keep the recovery note fresh while a session runs.
    global.setInterval(function () {
      var session = module('session');
      if (session && session.getState && session.getState().isActive) saveActiveSession(userId);
    }, ACTIVE_SAVE_MS);

    var auth = module('auth');
    var uid = auth && auth.getState().isSignedIn ? auth.getState().userId : null;

    ready = true;
    return activateUser(uid || guestId).then(function () {
      if (uid) saveProfile();
      return getState();
    });
  }

  /* -------------------------------------------------------------------
     15. Exports
     ------------------------------------------------------------------- */

  var api = {
    TABLES: TABLES,
    STATUS: STATUS,
    SYNC_ORDER: SYNC_ORDER,

    isImplemented: function () { return true; },
    isReady: function () { return ready; },
    getState: getState,
    render: render,

    // Queue.
    flush: flush,
    scheduleFlush: scheduleFlush,
    pendingCount: function () { return pending; },
    getQueue: function () {
      return store.all('syncQueue', { userId: userId }).then(function (rows) {
        return rows.sort(function (a, b) {
          return queueOrderKey(a) < queueOrderKey(b) ? -1 : 1;
        });
      });
    },

    // Cloud.
    loadFromCloud: loadFromCloud,
    mergeRemote: mergeRemote,

    // Persistence API (also used by the tests).
    persistSession: persistSession,
    persistLedgerEntry: persistLedgerEntry,
    persistWorld: persistWorld,
    persistWorldObject: persistWorldObject,
    persistWorldExpansion: persistWorldExpansion,
    saveActiveSession: saveActiveSession,
    clearActiveSession: clearActiveSession,
    saveSettings: saveSettings,
    applySettings: applySettings,
    saveDailyGoal: saveDailyGoal,
    saveProfile: saveProfile,
    hydrateFromLocal: hydrateFromLocal,

    // Namespaces.
    activateUser: activateUser,
    onSignOut: onSignOut,
    userId: function () { return userId; },

    // Recovery.
    recoveryNote: function () { return recovery ? Object.assign({}, recovery) : null; },
    resumeRecovered: resumeRecovered,
    endRecovered: endRecovered,
    discardRecovered: discardRecovered,

    // UI feedback.
    toast: toast,
    refreshStatus: function () { render(); refreshPending(); },

    loadRows: function (entityType, uid) {
      return store.all(entityType, { userId: uid || userId });
    },

    on: on,
    dispose: function () {
      unsubscribers.forEach(function (off) { off(); });
      unsubscribers = [];
      if (retryTimer !== null) global.clearInterval(retryTimer);
      if (flushTimer !== null) global.clearTimeout(flushTimer);
      if (settingsTimer !== null) global.clearTimeout(settingsTimer);
    },
  };

  global.FocusGuardSync = api;
  if (global.FocusGuard) global.FocusGuard.sync = api;
  else global.FocusGuard = { sync: api };

  function boot() {
    init().then(function () {
      emit('ready', getState());
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
