/* =====================================================================
   FocusGuard — js/focusEngine.js
   Phase 8: the productivity measurement layer.

   This module turns the measured attention time into the numbers the
   study session, the dashboard and the summary show:

     attention states  ──▶  measured time  ──▶  Focus Score
     (distraction.js)        (focused /           Focus rating
                              distracted /        Focus Coins
                              face missing)       Today's totals

   It measures nothing itself and it owns no camera or timer state: it
   reads the buckets js/distraction.js already keeps (timestamp based) and
   adds scoring, ratings, coins and the daily totals on top.

   ---- The honesty rules ----------------------------------------------
   * Everything here is an ESTIMATE made from camera signals in the
     browser. It is not a medical or psychological measurement, and it
     does not prove the user was concentrating. The wording throughout is
     "Estimated Focus" / "Focus Score" / "screen-facing attention".
   * Focused time only grows while the attention state is FOCUSED, the
     study session is running (not paused), the Pomodoro is neither paused
     nor on a break, and the tab is visible. Everything else measures
     nothing at all.
   * GRACE is never counted as focused time.

   ---- Scoring (no NaN, no Infinity, never negative) -------------------
     Focus Score = focused / (focused + distracted + faceMissing) * 100
     rounded, clamped to 0-100. With no measurable attention yet the score
     is "not available" (null → the UI shows "—").

     ≥ 90 Excellent · 75–89 Strong · 60–74 Moderate · < 60 Needs Improvement

   ---- Focus Coins (fixed rule: 1 focused minute = 1 Focus Coin) --------
     earnedCoins   = floor(lifetimeFocusedSeconds / 60)
     newCoins      = earnedCoins - alreadyAwardedCoins        (never negative)

   Only whole minutes ever pay out, the difference is what gets awarded,
   and fractional seconds are kept so nothing is lost or paid twice. Every
   award is written to an in-memory ledger:

     { id, type: 'FOCUSED_TIME', amount, timestamp, sessionId,
       focusedSeconds, rule }

   Coins are awarded from measured FOCUSED time only — never from the
   Pomodoro simply running, never during breaks, pauses, distraction or
   face-missing time.

   ---- Console ---------------------------------------------------------
     const f = window.FocusGuard.focusEngine;
     f.getState(); f.getToday(); f.getLedger(); f.getLastSession();
     f.on('change', console.log); f.on('coin', console.log);
   ===================================================================== */

(function (global) {
  'use strict';

  /* ---------- Public constants ---------- */

  var SECONDS_PER_COIN = 60;          // 1 focused minute = 1 Focus Coin
  var COIN_RULE = '1 focused minute = 1 Focus Coin';
  var SCORE_RULE = 'focused ÷ (focused + distracted + face missing) × 100';

  var TICK_MS = 1000;                 // the UI updates about once a second
  var DEFAULT_DAILY_GOAL_MINUTES = 120;

  var RATINGS = [
    { key: 'excellent', label: 'Excellent', min: 90,
      note: 'Attention stayed on the screen almost the whole session.' },
    { key: 'strong', label: 'Strong', min: 75,
      note: 'Mostly screen-facing, with short breaks in attention.' },
    { key: 'moderate', label: 'Moderate', min: 60,
      note: 'Attention drifted a few times during the session.' },
    { key: 'needs-improvement', label: 'Needs Improvement', min: 0,
      note: 'Attention was away from the screen for a large part of the session.' },
  ];

  /* ---------- Module state ---------- */

  var handlers = { change: [], coin: [] };

  // All-time (for this browser tab only).
  var ledger = [];
  var totalCoins = 0;
  var lifetimeFocusedClosedMs = 0;    // focused time from finished sessions
  var coinSeq = 0;

  // Live session.
  var sessionActive = false;
  var currentSessionId = null;
  var sessionStartedAt = null;
  var sessionCoins = 0;               // coins earned in the live session
  var sessionSnapshot = null;         // frozen while session.js builds its record
  var lastSession = null;

  // Today (in memory, reset when the local date changes).
  var todayKey = '';
  var today = emptyDay();

  var dailyGoalMinutes = DEFAULT_DAILY_GOAL_MINUTES;

  var tickId = null;
  var attached = false;
  var unsubscribers = [];
  var lastSignature = '';

  /**
   * The last measured snapshot, refreshed by sync() about once a second.
   * js/session.js reads this through peekSession() while it builds its own
   * state: reading the full state from there would call session.getState()
   * again, so the peek stays a plain cache on purpose.
   */
  var cache = {
    sessionActive: false, sessionId: null, status: 'idle', measured: false,
    focusedMs: 0, distractedMs: 0, faceMissingMs: 0, unclassifiedMs: 0,
    distractionCount: 0, currentDistractionMs: 0,
    score: null, rating: null, ratingKey: null, coinsEarned: 0,
    currentState: 'unknown', updatedAt: 0,
  };

  /* ---------- Small helpers ---------- */

  function each(selector, fn) {
    document.querySelectorAll(selector).forEach(fn);
  }

  function climb(value, min, max) {
    if (!isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  function wholeSeconds(ms) {
    return Math.max(0, Math.round((Number(ms) || 0) / 1000));
  }

  function safeMs(value) {
    var number = Number(value);
    if (!isFinite(number) || number < 0) return 0;
    return Math.round(number);
  }

  function emptyDay() {
    return {
      focusedMs: 0, distractedMs: 0, faceMissingMs: 0,
      sessions: 0, coins: 0, longestFocusedMs: 0,
    };
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

  /* ---------- Reading the modules above -------------------------------- */

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
  }

  function readSession() {
    var session = module('session');
    var state = session && typeof session.getState === 'function'
      ? session.getState() : null;
    if (!state) {
      return { isActive: false, status: 'idle', id: null, subject: '', goal: '', startTime: null };
    }
    return state;
  }

  function readTimer() {
    var timer = module('timer');
    return timer && typeof timer.getState === 'function' ? timer.getState() : null;
  }

  function emptyAttention() {
    return {
      state: 'unknown',
      focusedDurationMs: 0, distractedDurationMs: 0,
      faceMissingDurationMs: 0, unclassifiedDurationMs: 0,
      focusedSeconds: 0, distractedSeconds: 0, faceMissingSeconds: 0,
      distractionCount: 0, currentDistractionDurationMs: 0,
      measuring: false, tracked: false, tracking: false, monitoring: false,
    };
  }

  /** The measured buckets + the live attention state (distraction.js). */
  function readAttention(now) {
    var engine = module('distraction');
    if (!engine || typeof engine.getSessionData !== 'function') return emptyAttention();
    var data = engine.getSessionData(now);
    return Object.assign(emptyAttention(), data || {});
  }

  /* ---------- Scoring --------------------------------------------------- */

  /**
   * 0-100, or null when there is no measurable attention yet.
   * Unclassified time (GRACE / UNKNOWN) is deliberately not part of the
   * denominator: it is neither positive nor negative evidence.
   */
  function scoreOf(focusedMs, distractedMs, faceMissingMs) {
    var focused = safeMs(focusedMs);
    var measured = focused + safeMs(distractedMs) + safeMs(faceMissingMs);
    if (measured <= 0) return null;

    var score = Math.round((focused / measured) * 100);
    if (!isFinite(score)) return null;
    return climb(score, 0, 100);
  }

  function ratingOf(score) {
    if (score === null || score === undefined) return null;
    for (var i = 0; i < RATINGS.length; i += 1) {
      if (score >= RATINGS[i].min) return RATINGS[i];
    }
    return RATINGS[RATINGS.length - 1];
  }

  /* ---------- Coins ----------------------------------------------------- */

  /**
   * The core coin rule as one readable function: whole focused minutes
   * only. 119 s → 1 coin, 120 s → 2 coins, 185 s → 3 coins. Fractional
   * seconds stay in the total, so no focused time is ever lost.
   */
  function coinsForSeconds(seconds) {
    var total = Number(seconds);
    if (!isFinite(total) || total <= 0) return 0;
    return Math.floor(Math.floor(total) / SECONDS_PER_COIN);
  }

  /** Everything a session could ever be paid for: closed + live focused time. */
  function lifetimeFocusedMs(attention) {
    var live = sessionActive ? safeMs(attention.focusedDurationMs) : 0;
    return lifetimeFocusedClosedMs + live;
  }

  /**
   * Award only the difference between what the measured focused time has
   * earned and what has already been paid. Called as often as we like:
   * repeating it never pays the same minute twice.
   */
  function awardCoins(now, session, attention) {
    if (!session.isActive || !attention.measuring) return;

    var focusedSeconds = Math.floor(lifetimeFocusedMs(attention) / 1000);
    var earned = coinsForSeconds(focusedSeconds);
    if (!isFinite(earned) || earned <= totalCoins) return;

    addCoins(earned - totalCoins, now, session.id || currentSessionId, focusedSeconds);
  }

  function addCoins(amount, now, sessionId, focusedSeconds) {
    var coins = Math.floor(amount);
    if (!isFinite(coins) || coins <= 0) return;

    coinSeq += 1;
    var entry = {
      id: 'coin-' + coinSeq,
      type: 'FOCUSED_TIME',
      amount: coins,
      timestamp: now,
      sessionId: sessionId || null,
      focusedSeconds: Math.max(0, Math.floor(focusedSeconds || 0)),
      rule: COIN_RULE,
    };

    ledger.push(entry);
    totalCoins += coins;
    sessionCoins += coins;

    emit('coin', { entry: Object.assign({}, entry), totalCoins: totalCoins, sessionCoins: sessionCoins });
  }

  /* ---------- The day --------------------------------------------------- */

  function rollover(now) {
    var key = new Date(now).toDateString();
    if (key === todayKey) return;
    todayKey = key;
    today = emptyDay();
  }

  /* ---------- Sync (the only writer) ------------------------------------ */

  function sync(now) {
    now = now || Date.now();
    rollover(now);

    var session = readSession();
    var attention = readAttention(now);
    var wasActive = sessionActive;

    sessionActive = session.isActive === true;
    if (sessionActive) {
      currentSessionId = session.id || currentSessionId;
      if (sessionStartedAt === null) sessionStartedAt = session.startTime || now;
    }

    awardCoins(now, session, attention);
    refreshCache(now, session, attention);

    // The session ended (or was discarded): bank what was measured.
    if (!sessionActive && wasActive) finalize(now);

    publish(now);
  }

  /** Keep the cheap peek in step with what was just measured. */
  function refreshCache(now, session, attention) {
    var focused = safeMs(attention.focusedDurationMs);
    var distracted = safeMs(attention.distractedDurationMs);
    var faceMissing = safeMs(attention.faceMissingDurationMs);
    var score = scoreOf(focused, distracted, faceMissing);
    var rating = ratingOf(score);

    cache = {
      sessionActive: session.isActive === true,
      sessionId: session.id || currentSessionId,
      status: session.status || 'idle',
      measured: attention.tracked === true,
      measuring: attention.measuring === true,
      focusedMs: focused,
      distractedMs: distracted,
      faceMissingMs: faceMissing,
      unclassifiedMs: safeMs(attention.unclassifiedDurationMs),
      distractionCount: Math.max(0, Math.floor(attention.distractionCount || 0)),
      currentDistractionMs: safeMs(attention.currentDistractionDurationMs),
      score: score,
      rating: rating ? rating.label : null,
      ratingKey: rating ? rating.key : null,
      coinsEarned: sessionCoins,
      currentState: attention.state || 'unknown',
      updatedAt: now,
    };
  }

  /** Cheap, side-effect-free peek used by js/session.js (never recurses). */
  function peekSession() {
    return Object.assign({}, cache);
  }

  /** Freeze the finished session into today's totals + the last snapshot. */
  function finalize(now) {
    var snapshot = sessionSnapshot || buildSnapshot(now);

    today.focusedMs += safeMs(snapshot.focusedDurationMs);
    today.distractedMs += safeMs(snapshot.distractedDurationMs);
    today.faceMissingMs += safeMs(snapshot.faceMissingDurationMs);
    today.coins += Math.max(0, snapshot.focusCoinsEarned || 0);
    today.longestFocusedMs = Math.max(today.longestFocusedMs, safeMs(snapshot.focusedDurationMs));

    lifetimeFocusedClosedMs += safeMs(snapshot.focusedDurationMs);
    lastSession = snapshot;

    sessionSnapshot = null;
    sessionCoins = 0;
    currentSessionId = null;
    sessionStartedAt = null;
    sessionActive = false;
  }

  function buildSnapshot(now) {
    var attention = readAttention(now);
    var session = readSession();

    // Nothing was measured at all (camera off, or detection down the whole
    // time): report null so the UI shows a dash instead of a fake zero.
    var measured = attention.tracked === true;

    var focused = measured ? safeMs(attention.focusedDurationMs) : null;
    var distracted = measured ? safeMs(attention.distractedDurationMs) : null;
    var faceMissing = measured ? safeMs(attention.faceMissingDurationMs) : null;
    var unclassified = measured ? safeMs(attention.unclassifiedDurationMs) : null;
    var score = scoreOf(focused, distracted, faceMissing);
    var rating = ratingOf(score);

    return {
      sessionId: session.id || currentSessionId,
      subject: session.subject || '',
      startTime: session.startTime || sessionStartedAt,
      endTime: now,

      measuredMs: safeMs(focused) + safeMs(distracted) + safeMs(faceMissing) + safeMs(unclassified),
      focusedDurationMs: focused,
      distractedDurationMs: distracted,
      faceMissingDurationMs: faceMissing,
      unclassifiedDurationMs: unclassified,

      distractionCount: measured ? Math.max(0, Math.floor(attention.distractionCount || 0)) : 0,

      focusScore: score,
      focusRating: rating ? rating.label : null,
      focusRatingKey: rating ? rating.key : null,

      focusCoinsEarned: sessionCoins,
      totalCoins: totalCoins,

      measured: measured,
      currentState: attention.state || 'unknown',
    };
  }

  /**
   * The numbers for the session that is ending. js/session.js calls this
   * while it builds the final record, so the record and the summary always
   * agree with what was measured (including the last partial minute).
   */
  function getSessionSnapshot(now) {
    now = now || Date.now();
    sync(now);
    sessionSnapshot = buildSnapshot(now);
    return sessionSnapshot;
  }

  /* ---------- Public state ---------------------------------------------- */

  function getState(now) {
    now = now || Date.now();
    var session = readSession();
    var attention = readAttention(now);
    var timer = readTimer();

    // Live session numbers.
    var liveFocusedMs = safeMs(attention.focusedDurationMs);
    var liveDistractedMs = safeMs(attention.distractedDurationMs);
    var liveFaceMissingMs = safeMs(attention.faceMissingDurationMs);
    var liveUnclassifiedMs = safeMs(attention.unclassifiedDurationMs);
    var liveScore = scoreOf(liveFocusedMs, liveDistractedMs, liveFaceMissingMs);
    var liveRating = ratingOf(liveScore);

    // Today's numbers: banked sessions + the live session.
    var isLive = session.isActive === true;
    var todayFocusedMs = today.focusedMs + (isLive ? liveFocusedMs : 0);
    var todayDistractedMs = today.distractedMs + (isLive ? liveDistractedMs : 0);
    var todayFaceMissingMs = today.faceMissingMs + (isLive ? liveFaceMissingMs : 0);
    var todayScore = scoreOf(todayFocusedMs, todayDistractedMs, todayFaceMissingMs);
    var todayRating = ratingOf(todayScore);
    var loopCount = today.sessions + (isLive ? 1 : 0);

    var score = isLive ? liveScore : todayScore;
    var rating = isLive ? liveRating : todayRating;

    return {
      /* ---- the flat contract later phases can consume ---- */
      focusedSeconds: wholeSeconds(liveFocusedMs),
      distractedSeconds: wholeSeconds(liveDistractedMs),
      faceMissingSeconds: wholeSeconds(liveFaceMissingMs),
      unclassifiedSeconds: wholeSeconds(liveUnclassifiedMs),
      distractionCount: isLive ? Math.max(0, Math.floor(attention.distractionCount || 0)) : 0,
      focusScore: score,
      focusRating: rating ? rating.label : null,
      focusRatingKey: rating ? rating.key : null,
      totalCoinsEarned: totalCoins,
      currentState: attention.state || 'unknown',

      /* ---- detail ---- */
      coinRule: COIN_RULE,
      scoreRule: SCORE_RULE,
      secondsPerCoin: SECONDS_PER_COIN,

      sessionActive: isLive,
      sessionStatus: session.status || 'idle',
      sessionId: session.id || null,
      measuring: attention.measuring === true,
      measured: attention.tracked === true,
      timerMode: timer ? timer.mode : 'focus',
      timerPhase: timer ? timer.phase : 'idle',

      session: {
        focusedMs: liveFocusedMs,
        distractedMs: liveDistractedMs,
        faceMissingMs: liveFaceMissingMs,
        unclassifiedMs: liveUnclassifiedMs,
        distractionCount: Math.max(0, Math.floor(attention.distractionCount || 0)),
        currentDistractionMs: safeMs(attention.currentDistractionDurationMs),
        score: liveScore,
        rating: liveRating ? liveRating.label : null,
        ratingKey: liveRating ? liveRating.key : null,
        ratingNote: liveRating ? liveRating.note : null,
        coinsEarned: sessionCoins,
        measuring: attention.measuring === true,
      },

      today: {
        dayKey: todayKey,
        focusedMs: todayFocusedMs,
        distractedMs: todayDistractedMs,
        faceMissingMs: todayFaceMissingMs,
        sessions: loopCount,
        completedSessions: today.sessions,
        coins: today.coins + sessionCoins,
        longestFocusedMs: Math.max(today.longestFocusedMs, isLive ? liveFocusedMs : 0),
        averageFocusedMs: loopCount > 0
          ? Math.round((todayFocusedMs) / loopCount)
          : 0,
        score: todayScore,
        rating: todayRating ? todayRating.label : null,
        ratingKey: todayRating ? todayRating.key : null,
        goalMinutes: dailyGoalMinutes,
      },

      ledgerCount: ledger.length,
      isImplemented: true,
      signature: [
        attention.state || 'unknown',
        score === null ? 'na' : score,
        totalCoins,
        isLive ? 'live' : 'idle',
        today.sessions,
      ].join('|'),
    };
  }

  function getToday() { return getState().today; }

  function getLedger() {
    return ledger.map(function (entry) { return Object.assign({}, entry); });
  }

  function getLastSession() {
    return lastSession ? Object.assign({}, lastSession) : null;
  }

  /* ---------- Persistence (Phase 9) ------------------------------------ */

  /**
   * Rebuild the measured totals from stored data: the coin ledger entries
   * first, then the day's totals and the lifetime focused time.
   *
   * The coin rule is untouched by this: the balance is simply the sum of
   * the ledger's real awards, and `coinSeq` moves past the restored ids so
   * new awards still get unique ids. `awardCoins` then keeps paying only
   * the difference between measured focused time and what was already
   * paid — restoring data can never pay the same minute twice.
   */
  function hydrate(source) {
    source = source || {};

    var entries = (source.ledger || []).map(function (entry) {
      return {
        id: String(entry.id),
        type: entry.type || 'FOCUSED_TIME',
        amount: Math.max(0, Math.floor(entry.amount || 0)),
        timestamp: safeMs(entry.timestamp),
        sessionId: entry.sessionId || null,
        focusedSeconds: Math.max(0, Math.floor(entry.focusedSeconds || 0)),
        rule: entry.rule || COIN_RULE,
      };
    });

    ledger = entries;
    totalCoins = entries.reduce(function (sum, entry) { return sum + entry.amount; }, 0);
    coinSeq = entries.length;

    lifetimeFocusedClosedMs = safeMs(source.lifetimeFocusedClosedMs);

    var restored = source.today || {};
    todayKey = new Date(nowMs()).toDateString();
    today = {
      focusedMs: safeMs(restored.focusedMs),
      distractedMs: safeMs(restored.distractedMs),
      faceMissingMs: safeMs(restored.faceMissingMs),
      sessions: Math.max(0, Math.floor(restored.sessions || 0)),
      coins: Math.max(0, Math.floor(restored.coins || 0)),
      longestFocusedMs: safeMs(restored.longestFocusedMs),
    };

    if (isFinite(source.dailyGoalMinutes) && source.dailyGoalMinutes > 0) {
      dailyGoalMinutes = Math.round(source.dailyGoalMinutes);
    }

    lastSession = source.lastSession ? Object.assign({}, source.lastSession) : null;
    lastSignature = '';

    render();
    emit('change', getState());
    return getState();
  }

  function nowMs() { return Date.now(); }

  /** The user's daily target, which Phase 9 stores with their settings. */
  function setDailyGoalMinutes(minutes) {
    var next = Math.round(Number(minutes));
    if (!isFinite(next) || next < 0) return dailyGoalMinutes;
    if (next === dailyGoalMinutes) return dailyGoalMinutes;
    dailyGoalMinutes = next;
    render();
    emit('change', getState());
    return dailyGoalMinutes;
  }

  /* ---------- Formatting ------------------------------------------------ */

  function minutesText(ms) {
    var total = Math.max(0, Math.round(safeMs(ms) / 60000));
    var hours = Math.floor(total / 60);
    var minutes = total % 60;
    if (hours === 0) return minutes + 'm';
    return hours + 'h ' + String(minutes).padStart(2, '0') + 'm';
  }

  function liveText(ms) {
    var total = Math.max(0, Math.floor(safeMs(ms) / 1000));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    if (hours > 0) {
      return hours + 'h ' + String(minutes).padStart(2, '0') + 'm';
    }
    if (minutes > 0) {
      return minutes + 'm ' + String(secs).padStart(2, '0') + 's';
    }
    return secs + 's';
  }

  function scoreText(score) {
    return score === null || score === undefined ? '—' : String(score);
  }

  /* ---------- Rendering -------------------------------------------------- */

  function setText(key, value) {
    var text = String(value);
    each('[data-engine="' + key + '"]', function (el) {
      if (el.textContent !== text) el.textContent = text;
    });
  }

  function setRating(keys, rating, ratingKey) {
    keys.forEach(function (key) {
      each('[data-engine="' + key + '"]', function (el) {
        var label = rating || '—';
        if (el.textContent !== label) el.textContent = label;
        el.dataset.rating = ratingKey || 'none';
      });
    });
  }

  function render(now) {
    now = now || Date.now();
    var state = getState(now);
    var live = state.session;
    var day = state.today;

    // Focus score: the live session while one runs, today's record otherwise.
    var dashScore = state.sessionActive ? live.score : day.score;
    var dashRating = state.sessionActive ? live.rating : day.rating;
    var dashRatingKey = state.sessionActive ? live.ratingKey : day.ratingKey;

    setText('dash-score', scoreText(dashScore));
    setText('dash-score-alt', scoreText(day.score));
    setText('dash-rating-alt', day.rating || 'Not measured yet');
    setText('dash-score-caption', state.sessionActive
      ? 'Estimated Focus Score · this session'
      : 'Estimated Focus Score · today');
    setRating(['dash-rating', 'live-rating'], dashRating, dashRatingKey);

    var ringPercent = dashScore === null ? 0 : dashScore;
    var ringLength = 327;   // matches stroke-dasharray in style.css
    each('[data-engine="dash-ring"]', function (ring) {
      ring.style.strokeDashoffset = String(ringLength - (ringLength * ringPercent) / 100);
    });
    each('[data-engine="dash-meter"]', function (meter) {
      meter.style.width = ringPercent + '%';
    });

    // Today.
    setText('dash-focused', minutesText(day.focusedMs));
    setText('dash-sessions', String(day.sessions));
    setText('dash-longest', minutesText(day.longestFocusedMs));
    setText('dash-average', minutesText(day.averageFocusedMs));
    setText('dash-coins', String(state.totalCoinsEarned));
    setText('dash-coins-today', '+' + day.coins);

    // Today's goal.
    var goalMs = Math.max(0, day.goalMinutes) * 60000;
    var goalPercent = goalMs > 0
      ? climb(Math.round((day.focusedMs / goalMs) * 100), 0, 100)
      : 0;
    setText('goal-done', minutesText(day.focusedMs));
    setText('goal-pill', 'Goal: ' + minutesText(goalMs));
    setText('goal-total', 'of ' + minutesText(goalMs));
    setText('goal-caption', day.focusedMs <= 0
      ? 'No measured focus time yet today.'
      : goalPercent + '% of today\'s goal — keep going.');
    each('[data-engine="goal-fill"]', function (el) { el.style.width = goalPercent + '%'; });
    each('[data-engine="goal-bar"]', function (el) {
      el.setAttribute('aria-valuenow', String(goalPercent));
    });

    // Live session panel (and the compact Focus Mode mirror).
    setText('live-focused', liveText(live.focusedMs));
    setText('live-distracted', liveText(live.distractedMs));
    setText('live-face-missing', liveText(live.faceMissingMs));
    setText('live-distractions', String(live.distractionCount));
    setText('live-score', scoreText(live.score));
    setText('live-coins', String(live.coinsEarned));
    setText('fm-score', scoreText(live.score));
    setText('fm-coins', String(live.coinsEarned));

    each('[data-engine="engine-state"]', function (el) {
      el.dataset.engineState = state.currentState;
    });
  }

  /** Update + announce only when something meaningful changed. */
  function publish(now) {
    render(now);

    var state = getState(now);
    if (state.signature === lastSignature) return;
    lastSignature = state.signature;
    emit('change', state);
  }

  /* ---------- The heartbeat --------------------------------------------- */

  function startTicker() {
    if (tickId !== null) return;              // never two heartbeats
    tickId = global.setInterval(function () { sync(Date.now()); }, TICK_MS);
  }

  function stopTicker() {
    if (tickId === null) return;
    global.clearInterval(tickId);
    tickId = null;
  }

  function react() {
    if (document.hidden) {
      // A hidden tab measures nothing (distraction.js stops the clock too),
      // so there is nothing to tick — just make sure the UI is settled.
      stopTicker();
      render(Date.now());
      return;
    }
    startTicker();
    sync(Date.now());
  }

  /* ---------- Wiring ----------------------------------------------------- */

  function subscribe(api, eventName, handler) {
    if (!api || typeof api.on !== 'function') return;
    var off = api.on(eventName, handler);
    if (typeof off === 'function') unsubscribers.push(off);
  }

  function onSessionEnd() {
    // The record itself is built by session.js before this fires, so this
    // only book-keeps the day.
    var now = Date.now();
    today.sessions += 1;
    sync(now);
  }

  function attach(tries) {
    var session = module('session');
    var timer = module('timer');
    var distraction = module('distraction');

    if (attached || !session || !timer || !distraction) {
      if (!attached && tries < 25) {
        global.setTimeout(function () { attach(tries + 1); }, 120);
      }
      return;
    }

    attached = true;

    subscribe(session, 'change', react);
    subscribe(session, 'end', onSessionEnd);
    subscribe(timer, 'change', react);
    subscribe(distraction, 'change', react);
    subscribe(distraction, 'event', react);
    document.addEventListener('visibilitychange', react);

    rollover(Date.now());
    react();
  }

  function reset() {
    stopTicker();
    ledger = [];
    totalCoins = 0;
    lifetimeFocusedClosedMs = 0;
    coinSeq = 0;
    sessionActive = false;
    currentSessionId = null;
    sessionStartedAt = null;
    sessionCoins = 0;
    sessionSnapshot = null;
    lastSession = null;
    todayKey = '';
    today = emptyDay();
    lastSignature = '';
    rollover(Date.now());
    render();
  }

  function dispose() {
    unsubscribers.forEach(function (off) { off(); });
    unsubscribers = [];
    document.removeEventListener('visibilitychange', react);
    attached = false;
    stopTicker();
  }

  /* ---------- Exports ---------------------------------------------------- */

  var PIPELINE = [
    'camera.js',
    'faceDetection.js',
    'attention.js',
    'distraction.js',
    'focusEngine.js',
  ];

  var api = {
    RATINGS: RATINGS.map(function (rating) { return Object.assign({}, rating); }),
    COIN_RULE: COIN_RULE,
    SCORE_RULE: SCORE_RULE,
    SECONDS_PER_COIN: SECONDS_PER_COIN,

    isImplemented: function () { return true; },
    getState: getState,
    getToday: getToday,
    getLedger: getLedger,
    getLastSession: getLastSession,
    hydrate: hydrate,
    setDailyGoalMinutes: setDailyGoalMinutes,
    getSessionSnapshot: getSessionSnapshot,
    peekSession: peekSession,

    // Pure helpers, exposed so the UI (and the console) can test/reuse them.
    scoreOf: scoreOf,
    ratingOf: ratingOf,
    coinsForSeconds: coinsForSeconds,
    minutesText: minutesText,
    liveText: liveText,

    on: on,
    render: render,
    reset: reset,
    dispose: dispose,
    pipeline: PIPELINE.slice(),
  };

  global.FocusGuardFocusEngine = api;
  if (global.FocusGuard) global.FocusGuard.focusEngine = api;
  else global.FocusGuard = { focusEngine: api };

  function init() {
    render();
    attach(0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
