/* =====================================================================
   FocusGuard — js/auth.js
   Phase 9 (Part 3, 4, 5, 24, 43): email + password authentication.

   FocusGuard stays usable with no account at all: everything is saved
   locally either way. Signing in adds the cloud layer (see js/sync.js).

   ---- States ---------------------------------------------------------
     unavailable  Supabase is not configured → local-only mode
     signed-out   configured, nobody is signed in
     working      a request is in flight
     signed-in    a user session is active

   ---- Passwords ------------------------------------------------------
   Supabase Auth owns them. FocusGuard sends the password straight to the
   backend and keeps it nowhere: not in memory, not in IndexedDB, not in
   localStorage.

   ---- DOM contract ---------------------------------------------------
     [data-auth-open]                  open the account panel
     [data-auth-close]                 close it
     [data-auth-modal]                 the panel (a normal <div>, hidden)
     [data-auth-form]                  the sign-in / sign-up form
     [data-auth-field="email"]         email input
     [data-auth-field="password"]      password input
     [data-auth-submit="login"]        log in button
     [data-auth-submit="signup"]       create account button
     [data-auth-logout]                log out button
     [data-auth-message]               feedback line ("Logged in.")
     [data-auth-status]                short status text (several places)
     [data-auth-state]                 dataset: unavailable|signed-out|working|signed-in
     [data-auth-email]                 signed-in email (several places)
     [data-auth-avatar]                avatar initial
     [data-auth-out]                   block shown when signed out
     [data-auth-in]                    block shown when signed in

   ---- Console --------------------------------------------------------
     const a = window.FocusGuard.auth;
     a.getState(); await a.signIn('me@example.com', 'secret');
     a.on('change', console.log);
   ===================================================================== */

(function (global) {
  'use strict';

  var cloud = global.FocusGuardCloud;

  var STATUS = {
    UNAVAILABLE: 'unavailable',
    SIGNED_OUT: 'signed-out',
    WORKING: 'working',
    SIGNED_IN: 'signed-in',
  };

  /* ---------- State ---------- */

  var state = {
    status: STATUS.SIGNED_OUT,
    userId: null,
    email: '',
    available: false,
    message: '',
    lastError: '',
  };

  var handlers = { change: [] };
  var attached = false;
  var unsubscribeBackend = null;

  /* ---------- Helpers ---------- */

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

  function backend() {
    return cloud && typeof cloud.backend === 'function' ? cloud.backend() : null;
  }

  function friendly(error, fallback) {
    var raw = cloud && cloud.message ? cloud.message(error) : String(error || '');
    var text = (raw || '').toLowerCase();
    if (!text) return fallback;
    if (text.indexOf('invalid login') !== -1 || text.indexOf('invalid credentials') !== -1) {
      return 'Unable to sign in — check your email and password.';
    }
    if (text.indexOf('email not confirmed') !== -1) {
      return 'Please confirm your email address first, then log in.';
    }
    if (text.indexOf('already registered') !== -1 || text.indexOf('already exists') !== -1) {
      return 'That email already has an account — try logging in.';
    }
    if (text.indexOf('password') !== -1 && text.indexOf('short') !== -1) {
      return 'Please use a longer password (at least 6 characters).';
    }
    if (text.indexOf('valid email') !== -1 || text.indexOf('invalid email') !== -1) {
      return 'Please enter a valid email address.';
    }
    if (text.indexOf('rate limit') !== -1) {
      return 'Too many attempts — please wait a moment and try again.';
    }
    if (text.indexOf('fetch') !== -1 || text.indexOf('network') !== -1) {
      return 'Network unavailable — your data is saved locally.';
    }
    return raw || fallback;
  }

  /* ---------- Reading state ---------- */

  function getState() {
    return {
      status: state.status,
      userId: state.userId,
      email: state.email,
      available: state.available,
      message: state.message,
      lastError: state.lastError,
      isSignedIn: state.status === STATUS.SIGNED_IN && !!state.userId,
      syncEnabled: state.status === STATUS.SIGNED_IN && !!state.userId,
      configured: !!(cloud && cloud.isConfigured && cloud.isConfigured()),
      // Never exposed to storage — kept here so the API shape is complete.
      passwordsStored: false,
    };
  }

  /** The namespace local data belongs to right now. */
  function namespace() {
    return state.userId || (global.FocusGuardLocalStore
      ? global.FocusGuardLocalStore.GUEST_ID
      : 'local');
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

  function emit(eventName) {
    var snapshot = getState();
    (handlers[eventName] || []).forEach(function (fn) { fn(snapshot); });
  }

  function setState(patch) {
    Object.assign(state, patch);
    render();
    emit('change');
  }

  /* ---------- Rendering ---------- */

  function render() {
    var signedIn = state.status === STATUS.SIGNED_IN && !!state.userId;
    var initial = state.email ? state.email.charAt(0).toUpperCase() : 'G';

    var statusText = {
      unavailable: 'Local only — cloud sync not configured',
      'signed-out': 'Local only — log in to sync',
      working: 'Working…',
      'signed-in': state.email ? 'Signed in as ' + state.email : 'Signed in',
    }[state.status];

    setText('[data-auth-status]', statusText);
    setText('[data-auth-email]', state.email || '—');
    setText('[data-auth-avatar]', signedIn ? initial : 'G');
    setText('[data-auth-message]', state.message || '');
    setVisible('[data-auth-message]', !!state.message);
    setVisible('[data-auth-out]', !signedIn);
    setVisible('[data-auth-in]', signedIn);

    each('[data-auth-state]', function (el) { el.dataset.authState = state.status; });
    each('[data-auth-avatar]', function (el) {
      el.setAttribute('title', signedIn ? state.email : 'Local mode — not signed in');
    });
    each('[data-auth-submit]', function (el) {
      el.disabled = state.status === STATUS.WORKING || !state.available;
    });
    each('[data-auth-logout]', function (el) { el.disabled = state.status === STATUS.WORKING; });

    // The setup hint is only useful while the app is unconfigured.
    setVisible('[data-auth-hint]', !state.available);
  }

  /* ---------- Panel ---------- */

  function openPanel() {
    var modal = document.querySelector('[data-auth-modal]');
    if (!modal) return;
    modal.hidden = false;
    var first = modal.querySelector('[data-auth-field="email"]');
    if (first && state.status !== STATUS.SIGNED_IN) first.focus();
  }

  function closePanel() {
    var modal = document.querySelector('[data-auth-modal]');
    if (modal) modal.hidden = true;
  }

  function isPanelOpen() {
    var modal = document.querySelector('[data-auth-modal]');
    return !!modal && !modal.hidden;
  }

  /* ---------- Actions ---------- */

  function applySession(session, note) {
    if (session && session.user) {
      setState({
        status: STATUS.SIGNED_IN,
        userId: session.user.id,
        email: session.user.email || '',
        message: note || 'Logged in.',
        lastError: '',
      });
      return true;
    }
    setState({ status: STATUS.SIGNED_OUT, userId: null, email: '', message: note || '' });
    return false;
  }

  function signIn(email, password) {
    var active = backend();
    if (!state.available || !active) {
      setState({ message: 'Cloud sync is not configured yet — add your Supabase URL and anon key.' });
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }

    var emailValue = String(email || '').trim();
    if (!emailValue || !password) {
      setState({ message: 'Enter your email and password to log in.' });
      return Promise.resolve({ ok: false, reason: 'missing-fields' });
    }

    setState({ status: STATUS.WORKING, message: 'Logging in…' });

    return Promise.resolve(active.signIn(emailValue, password)).then(function (result) {
      if (result && result.error) {
        setState({
          status: STATUS.SIGNED_OUT,
          message: friendly(result.error, 'Unable to sign in.'),
          lastError: cloud.message(result.error),
        });
        return { ok: false, reason: 'error', error: result.error };
      }
      // Some backends return only a user (email confirmation flows).
      var session = (result && result.session) || null;
      if (!session && result && result.user) {
        session = { user: result.user };
      }
      applySession(session, 'Logged in.');
      return { ok: true };
    });
  }

  function signUp(email, password) {
    var active = backend();
    if (!state.available || !active) {
      setState({ message: 'Cloud sync is not configured yet — add your Supabase URL and anon key.' });
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }

    var emailValue = String(email || '').trim();
    if (!emailValue || !password) {
      setState({ message: 'Enter an email and a password to create an account.' });
      return Promise.resolve({ ok: false, reason: 'missing-fields' });
    }
    if (String(password).length < 6) {
      setState({ message: 'Please use a password with at least 6 characters.' });
      return Promise.resolve({ ok: false, reason: 'weak-password' });
    }

    setState({ status: STATUS.WORKING, message: 'Creating your account…' });

    return Promise.resolve(active.signUp(emailValue, password)).then(function (result) {
      if (result && result.error) {
        setState({
          status: STATUS.SIGNED_OUT,
          message: friendly(result.error, 'Unable to create the account.'),
          lastError: cloud.message(result.error),
        });
        return { ok: false, reason: 'error', error: result.error };
      }

      var session = (result && result.session) || null;
      if (session) {
        applySession(session, 'Account created.');
        return { ok: true };
      }

      // Email confirmation is switched on in Supabase: no session yet.
      setState({
        status: STATUS.SIGNED_OUT,
        message: 'Account created. Check your email to confirm, then log in.',
      });
      return { ok: true, needsConfirmation: true };
    });
  }

  function signOut() {
    var active = backend();
    var previous = state.email;

    setState({ status: STATUS.WORKING, message: 'Logging out…' });

    var done = active && state.available ? active.signOut() : Promise.resolve({ error: null });

    return Promise.resolve(done).catch(function (error) { return { error: error }; })
      .then(function (result) {
        var note = result && result.error
          ? 'Logged out locally (the cloud could not be reached).'
          : 'Logged out.';
        applySession(null, note);
        var sync = module('sync');
        if (sync && typeof sync.onSignOut === 'function') sync.onSignOut(previous);
        return { ok: true };
      });
  }

  /* ---------- Session restore ---------- */

  /**
   * Ask the backend whether a session is already stored (page reload,
   * second tab, coming back tomorrow). Never throws.
   */
  function refresh(note) {
    var active = backend();
    var configured = !!(cloud && cloud.isConfigured && cloud.isConfigured());
    var available = !!(active && (typeof active.available !== 'function' || active.available()));

    state.available = configured && available;

    if (!state.available) {
      setState({
        status: STATUS.UNAVAILABLE,
        userId: null,
        email: '',
        message: '',
      });
      return Promise.resolve(getState());
    }

    return Promise.resolve(active.getSession())
      .then(function (result) {
        var session = result && result.session;
        if (session) {
          applySession(session, note || '');
          return getState();
        }
        setState({ status: STATUS.SIGNED_OUT, userId: null, email: '', message: '' });
        return getState();
      })
      .catch(function () {
        setState({ status: STATUS.SIGNED_OUT, userId: null, email: '', message: '' });
        return getState();
      });
  }

  /* ---------- Wiring ---------- */

  function bindForm() {
    var form = document.querySelector('[data-auth-form]');
    if (!form) return;

    function submit(event, mode) {
      if (event) event.preventDefault();
      var emailEl = form.querySelector('[data-auth-field="email"]');
      var passwordEl = form.querySelector('[data-auth-field="password"]');
      var email = emailEl ? emailEl.value : '';
      var password = passwordEl ? passwordEl.value : '';

      var promise = mode === 'signup' ? signUp(email, password) : signIn(email, password);
      promise.then(function (result) {
        if (result && result.ok && passwordEl) passwordEl.value = '';
      });
    }

    form.addEventListener('submit', function (event) { submit(event, 'login'); });

    each('[data-auth-submit]', function (el) {
      el.addEventListener('click', function (event) {
        submit(event, el.dataset.authSubmit === 'signup' ? 'signup' : 'login');
      });
    });

    each('[data-auth-logout]', function (el) {
      el.addEventListener('click', function () { signOut(); });
    });
  }

  function bindPanel() {
    each('[data-auth-open]', function (el) {
      el.addEventListener('click', function () {
        var sync = module('sync');
        if (sync && typeof sync.refreshStatus === 'function') sync.refreshStatus();
        openPanel();
      });
    });
    each('[data-auth-close]', function (el) {
      el.addEventListener('click', closePanel);
    });

    var modal = document.querySelector('[data-auth-modal]');
    if (modal) {
      modal.addEventListener('click', function (event) {
        if (event.target === modal) closePanel();
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isPanelOpen()) closePanel();
    });
  }

  function subscribeBackend() {
    var active = backend();
    if (!active || typeof active.onAuthStateChange !== 'function') return;
    if (unsubscribeBackend) { unsubscribeBackend(); unsubscribeBackend = null; }
    unsubscribeBackend = active.onAuthStateChange(function (session) {
      // Fired when a token refreshes, expires, or a second tab signs out.
      if (session && session.user) {
        if (state.userId !== session.user.id) {
          applySession(session, 'Session restored.');
        }
      } else if (state.status === STATUS.SIGNED_IN) {
        applySession(null, 'Session ended — you are now local only.');
      }
    });
  }

  function init() {
    bindForm();
    bindPanel();
    refresh('Session restored.').then(function () {
      subscribeBackend();
    });
  }

  /* ---------- Exports ---------- */

  var api = {
    STATUS: STATUS,
    getState: getState,
    isSignedIn: function () { return getState().isSignedIn; },
    userId: function () { return state.userId; },
    namespace: namespace,
    email: function () { return state.email; },

    refresh: refresh,
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,

    setBackend: function (next) {
      if (cloud && typeof cloud.setAuthBackend === 'function') cloud.setAuthBackend(next);
      return refresh('Session restored.');
    },

    openPanel: openPanel,
    closePanel: closePanel,
    isPanelOpen: isPanelOpen,
    render: render,

    on: on,
    isImplemented: function () { return true; },
  };

  global.FocusGuardAuth = api;
  if (global.FocusGuard) global.FocusGuard.auth = api;
  else global.FocusGuard = { auth: api };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
