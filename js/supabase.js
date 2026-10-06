/* =====================================================================
   FocusGuard — js/supabase.js
   Phase 9 (Part 1, 2, 37, 39): the ONE place that knows about Supabase.

   Responsibilities (deliberately small):
     * hold the public configuration (project URL + anon key)
     * lazily load the browser Supabase client from a CDN only when it is
       actually configured (so an unconfigured app makes no extra request)
     * expose a tiny cloud "adapter" (upsert / list / remove) that the rest
       of the app talks to — no other module imports Supabase directly
     * expose the auth backend (sign up / sign in / sign out / session)

   ---- What must NEVER live here ---------------------------------------
     * the service_role key
     * the database password
     * any private secret

   The browser only ever holds the *public* anon key. Supabase Row Level
   Security (see supabase/schema.sql) is what actually protects user data.

   ---- Where to put your credentials (see README, Phase 9) -------------
   Put them in the CONFIG block below. There are two optional overrides so
   you never have to edit this file in a hurry:

     window.FOCUSGUARD_SUPABASE = { url: '...', anonKey: '...' };
       → set this in a small `<script>` before js/supabase.js, handy for a
         private deploy script or a GitHub Pages build step.

     localStorage 'focusguard.supabase.url' / 'focusguard.supabase.anonKey'
       → handy while developing: paste them once in the console.

   ---- Console ---------------------------------------------------------
     const c = window.FocusGuard.cloud;
     c.isConfigured(); c.state(); c.instructions();
     c.setAdapter(fakeAdapter);   // used by the test harness
   ===================================================================== */

(function (global) {
  'use strict';

  /* -------------------------------------------------------------------
     1. CONFIGURATION — the only place credentials live
     ------------------------------------------------------------------- */

  var PLACEHOLDER_URL = 'https://YOUR-PROJECT.supabase.co';
  var PLACEHOLDER_KEY = 'YOUR-SUPABASE-ANON-PUBLIC-KEY';

  /**
   * ▼▼ EDIT THESE TWO LINES ▼▼
   * Project URL and the *anon / public* key from
   *   Supabase dashboard → Project Settings → API.
   * Leave the placeholders as they are to run FocusGuard fully offline
   * (local IndexedDB only) — the app keeps working either way.
   */
  var SUPABASE_URL = PLACEHOLDER_URL;
  var SUPABASE_ANON_KEY = PLACEHOLDER_KEY;

  var STORAGE_URL_KEY = 'focusguard.supabase.url';
  var STORAGE_KEY_KEY = 'focusguard.supabase.anonKey';

  function readConfig() {
    var config = { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY };

    // Override 1: window.FOCUSGUARD_SUPABASE = { url, anonKey }
    var override = global.FOCUSGUARD_SUPABASE;
    if (override && typeof override === 'object') {
      if (typeof override.url === 'string' && override.url) config.url = override.url;
      if (typeof override.anonKey === 'string' && override.anonKey) config.anonKey = override.anonKey;
    }

    // Override 2: localStorage (development convenience only).
    try {
      var storedUrl = global.localStorage && global.localStorage.getItem(STORAGE_URL_KEY);
      var storedKey = global.localStorage && global.localStorage.getItem(STORAGE_KEY_KEY);
      if (storedUrl) config.url = storedUrl;
      if (storedKey) config.anonKey = storedKey;
    } catch (error) { /* private mode: ignore */ }

    return config;
  }

  /** True when real credentials (not the placeholders) are present. */
  function isConfigured() {
    var config = readConfig();
    if (!config.url || !config.anonKey) return false;
    if (config.url === PLACEHOLDER_URL || config.anonKey === PLACEHOLDER_KEY) return false;
    if (config.url.indexOf('YOUR-PROJECT') !== -1) return false;
    if (config.url.indexOf('http') !== 0) return false;
    return true;
  }

  /* -------------------------------------------------------------------
     2. The client — loaded lazily, never at page load
     ------------------------------------------------------------------- */

  var LIB_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
    'https://unpkg.com/@supabase/supabase-js@2',
  ];

  var client = null;
  var clientPromise = null;
  var lastError = '';

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = url;
      tag.async = true;
      tag.onload = function () { resolve(url); };
      tag.onerror = function () { reject(new Error('Could not load ' + url)); };
      document.head.appendChild(tag);
    });
  }

  function tryLoad(index) {
    if (index >= LIB_URLS.length) {
      return Promise.reject(new Error('Supabase client library unavailable (offline?)'));
    }
    return loadScript(LIB_URLS[index]).catch(function () { return tryLoad(index + 1); });
  }

  /**
   * Resolve the Supabase client, or null when the app is not configured.
   * Never throws: a broken CDN or a missing key must leave the local app
   * completely usable.
   */
  function ensureClient() {
    if (client) return Promise.resolve(client);
    if (!isConfigured()) return Promise.resolve(null);
    if (clientPromise) return clientPromise;

    clientPromise = tryLoad(0)
      .then(function () {
        var factory = global.supabase;
        if (!factory || typeof factory.createClient !== 'function') {
          throw new Error('Supabase library loaded but createClient is missing');
        }
        var config = readConfig();
        client = factory.createClient(config.url, config.anonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        lastError = '';
        return client;
      })
      .catch(function (error) {
        lastError = message(error);
        clientPromise = null;         // allow a later retry
        console.warn('FocusGuard: Supabase unavailable —', lastError);
        return null;
      });

    return clientPromise;
  }

  /** Inject a ready-made client (used by tests and advanced setups). */
  function setClient(next) {
    client = next || null;
    clientPromise = next ? Promise.resolve(next) : null;
    return client;
  }

  function getClient() { return client; }

  function message(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return error.message || error.error_description || error.msg || String(error);
  }

  function state() {
    var config = readConfig();
    return {
      configured: isConfigured(),
      url: config.url === PLACEHOLDER_URL ? '' : config.url,
      clientReady: !!client,
      lastError: lastError,
      library: LIB_URLS[0],
    };
  }

  /* -------------------------------------------------------------------
     3. The cloud adapter — the only database surface the app uses
     -------------------------------------------------------------------
     Shape (all methods resolve, never reject):

       upsert(table, rows, onConflict) → { error }
       list(table, userId)             → { error, data }
       remove(table, id, userId)       → { error }

     An adapter can be injected (tests / a different transport). The
     default adapter maps straight onto the Supabase client.
     ------------------------------------------------------------------- */

  var adapter = null;

  function setAdapter(next) { adapter = next || null; }

  function notConfigured() {
    return { error: { message: 'Cloud is not configured', code: 'NOT_CONFIGURED' }, data: [] };
  }

  function defaultAdapter() {
    return {
      upsert: function (table, rows, onConflict) {
        return ensureClient().then(function (ready) {
          if (!ready) return notConfigured();
          var options = onConflict ? { onConflict: onConflict } : undefined;
          return Promise.resolve(ready.from(table).upsert(rows, options))
            .then(function (result) {
              return { error: (result && result.error) || null, data: (result && result.data) || null };
            })
            .catch(function (error) { return { error: { message: message(error) }, data: null }; });
        });
      },

      list: function (table, userId) {
        return ensureClient().then(function (ready) {
          if (!ready) return notConfigured();
          return Promise.resolve(ready.from(table).select('*').eq('user_id', userId))
            .then(function (result) {
              return {
                error: (result && result.error) || null,
                data: (result && result.data) || [],
              };
            })
            .catch(function (error) { return { error: { message: message(error) }, data: [] }; });
        });
      },

      remove: function (table, id, userId) {
        return ensureClient().then(function (ready) {
          if (!ready) return notConfigured();
          return Promise.resolve(ready.from(table).delete().eq('id', id).eq('user_id', userId))
            .then(function (result) {
              return { error: (result && result.error) || null, data: (result && result.data) || null };
            })
            .catch(function (error) { return { error: { message: message(error) }, data: null }; });
        });
      },
    };
  }

  function activeAdapter() { return adapter || defaultAdapter(); }

  function cloudUpsert(table, rows, onConflict) {
    var list = Array.isArray(rows) ? rows : [rows];
    if (list.length === 0) return Promise.resolve({ error: null, data: null });
    var active = activeAdapter();
    if (!active || typeof active.upsert !== 'function') return Promise.resolve(notConfigured());
    return Promise.resolve(active.upsert(table, list, onConflict || 'id'))
      .catch(function (error) { return { error: { message: message(error) }, data: null }; });
  }

  function cloudList(table, userId) {
    var active = activeAdapter();
    if (!active || typeof active.list !== 'function') return Promise.resolve(notConfigured());
    return Promise.resolve(active.list(table, userId))
      .catch(function (error) { return { error: { message: message(error) }, data: [] }; });
  }

  function cloudRemove(table, id, userId) {
    var active = activeAdapter();
    if (!active || typeof active.remove !== 'function') return Promise.resolve(notConfigured());
    return Promise.resolve(active.remove(table, id, userId))
      .catch(function (error) { return { error: { message: message(error) }, data: null }; });
  }

  /* -------------------------------------------------------------------
     4. The auth backend — thin wrappers over Supabase Auth
     -------------------------------------------------------------------
     Passwords are handled by Supabase Auth only. FocusGuard never stores
     a password anywhere (not in IndexedDB, not in localStorage).
     ------------------------------------------------------------------- */

  var authBackend = null;

  function setAuthBackend(next) { authBackend = next || null; }

  function sessionFrom(result) {
    if (!result) return null;
    if (result.data && result.data.session) return result.data.session;
    if (result.session) return result.session;
    return null;
  }

  function realAuthBackend() {
    return {
      available: function () { return isConfigured(); },

      getSession: function () {
        return ensureClient().then(function (ready) {
          if (!ready) return { session: null, error: null };
          return ready.auth.getSession()
            .then(function (result) {
              return {
                session: sessionFrom(result),
                error: (result && result.error) || null,
              };
            })
            .catch(function (error) { return { session: null, error: { message: message(error) } }; });
        });
      },

      onAuthStateChange: function (handler) {
        if (typeof handler !== 'function') return function () {};
        var dispose = function () {};
        ensureClient().then(function (ready) {
          if (!ready) return;
          var result = ready.auth.onAuthStateChange(function (event, session) {
            handler(session || null, event);
          });
          if (result && result.data && result.data.subscription) {
            dispose = function () { result.data.subscription.unsubscribe(); };
          }
        });
        return function () { dispose(); };
      },

      signUp: function (email, password) {
        return ensureClient().then(function (ready) {
          if (!ready) return { error: { message: 'Cloud is not configured' } };
          return ready.auth.signUp({ email: email, password: password })
            .then(function (result) {
              return {
                session: sessionFrom(result),
                user: (result.data && result.data.user) || null,
                error: (result && result.error) || null,
              };
            })
            .catch(function (error) { return { error: { message: message(error) } }; });
        });
      },

      signIn: function (email, password) {
        return ensureClient().then(function (ready) {
          if (!ready) return { error: { message: 'Cloud is not configured' } };
          return ready.auth.signInWithPassword({ email: email, password: password })
            .then(function (result) {
              return {
                session: sessionFrom(result),
                user: (result.data && result.data.user) || null,
                error: (result && result.error) || null,
              };
            })
            .catch(function (error) { return { error: { message: message(error) } }; });
        });
      },

      signOut: function () {
        return ensureClient().then(function (ready) {
          if (!ready) return { error: null };
          return ready.auth.signOut()
            .then(function (result) { return { error: (result && result.error) || null }; })
            .catch(function (error) { return { error: { message: message(error) } }; });
        });
      },
    };
  }

  function activeAuthBackend() { return authBackend || realAuthBackend(); }

  /* -------------------------------------------------------------------
     5. Exports
     ------------------------------------------------------------------- */

  var api = {
    CONFIG: { PLACEHOLDER_URL: PLACEHOLDER_URL, PLACEHOLDER_KEY: PLACEHOLDER_KEY,
              STORAGE_URL_KEY: STORAGE_URL_KEY, STORAGE_KEY_KEY: STORAGE_KEY_KEY },

    isConfigured: isConfigured,
    config: readConfig,
    state: state,
    ensureClient: ensureClient,
    getClient: getClient,
    setClient: setClient,
    setAdapter: setAdapter,
    getAdapter: function () { return adapter; },

    // Cloud adapter surface (upsert / list / remove).
    upsert: cloudUpsert,
    list: cloudList,
    remove: cloudRemove,

    // Auth backend surface.
    backend: activeAuthBackend,
    setAuthBackend: setAuthBackend,

    message: message,

    /** Beginner-readable setup instructions, also used by the UI. */
    instructions: function () {
      return [
        '1. Create a project at https://supabase.com',
        '2. Project Settings → API → copy the Project URL and the anon public key',
        '3. Paste them into the CONFIG block at the top of js/supabase.js',
        '   (or set window.FOCUSGUARD_SUPABASE = { url, anonKey } before the script)',
        '4. SQL Editor → run supabase/schema.sql (tables + indexes + RLS)',
        '5. Authentication → Providers → Email: enable Email/Password',
        '6. Authentication → URL Configuration: add your local and Pages URLs',
        'Never use the service_role key in the browser.',
      ];
    },
  };

  global.FocusGuardCloud = api;
  if (global.FocusGuard) global.FocusGuard.cloud = api;
  else global.FocusGuard = { cloud: api };
})(window);
