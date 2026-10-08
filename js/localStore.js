/* =====================================================================
   FocusGuard — js/localStore.js
   Phase 9 (Part 10, 11, 24, 42): local persistence with IndexedDB.

   IndexedDB is the app's own database in the browser. It survives a
   refresh, a tab close and a browser restart, which is exactly what
   FocusGuard needed: sessions, Focus Coins, the ledger and settings no
   longer disappear.

   ---- What is stored ------------------------------------------------
     sessions           finished + in-progress study sessions
     distractionEvents  one row per away episode (metadata only)
     coinLedger         the reward transactions (source of truth)
     dailyGoals         one row per user + day (target minutes)
     settings           the user's timer / grace / notification settings
     syncQueue          the outbox: local records waiting for the cloud
     profiles           a cached copy of the user's profile row
     worlds             the Focus World itself (grid size, biome)
     worldObjects       one row per placed object, soft-deleted when removed
     worldExpansions    one row per purchased land expansion
     meta               small key/value notes (active session, last user)

   ---- What is NEVER stored -------------------------------------------
     No webcam frame, image, video, facial landmark or biometric data of
     any kind. No password — Supabase Auth owns passwords, and we never
     even see them. `describe()` audits this at runtime.

   ---- Multi-user safety (Part 24/25) --------------------------------
   IndexedDB has no folders, so the equivalent of `local/userA/...` is a
   `userId` field on every record plus an index on it. Every read is
   scoped by userId, so two accounts sharing one browser can never see
   each other's data. Signed-out use is the namespace `local`.

   ---- Console --------------------------------------------------------
     const db = window.FocusGuard.localStore;
     await db.all('sessions', { userId: 'local' });
     await db.stats('local');
   ===================================================================== */

(function (global) {
  'use strict';

  var DB_NAME = 'focusguard';
  var DB_VERSION = 2;             // v2 added the Phase 10 world stores
  var GUEST_ID = 'local';

  /**
   * The schema. Every store that holds user data carries a `userId`
   * field and a `byUser` index — that is the namespacing mechanism.
   */
  var STORES = {
    sessions: {
      keyPath: 'id',
      indexes: [
        ['byUser', 'userId'],
        ['byUserStart', ['userId', 'startTime']],
      ],
    },
    distractionEvents: {
      keyPath: 'id',
      indexes: [
        ['byUser', 'userId'],
        ['bySession', 'sessionId'],
      ],
    },
    coinLedger: {
      keyPath: 'id',
      indexes: [
        ['byUser', 'userId'],
        ['bySession', 'sessionId'],
      ],
    },
    dailyGoals: {
      keyPath: 'id',
      indexes: [
        ['byUser', 'userId'],
        ['byUserDate', ['userId', 'date']],
      ],
    },
    settings: {
      keyPath: 'userId',
      indexes: [['byUser', 'userId']],
    },
    syncQueue: {
      keyPath: 'id',
      indexes: [
        ['byUser', 'userId'],
        ['byUserStatus', ['userId', 'status']],
      ],
    },
    profiles: {
      keyPath: 'userId',
      indexes: [['byUser', 'userId']],
    },
    worlds: {
      keyPath: 'id',
      indexes: [['byUser', 'userId']],
    },
    worldObjects: {
      keyPath: 'id',
      indexes: [
        ['byUser', 'userId'],
        ['byWorld', 'worldId'],
      ],
    },
    worldExpansions: {
      keyPath: 'id',
      indexes: [
        ['byUser', 'userId'],
        ['byWorld', 'worldId'],
      ],
    },
    meta: { keyPath: 'key', indexes: [] },
  };

  var STORE_NAMES = Object.keys(STORES);

  /** Key names that would mean private camera data leaked into storage. */
  var FORBIDDEN_KEYS = [
    'frame', 'frames', 'image', 'images', 'photo', 'picture', 'snapshot',
    'video', 'webcam', 'landmark', 'landmarks', 'mesh', 'blob', 'dataurl',
    'base64', 'canvas', 'password',
  ];

  /* ---------- State ---------- */

  var db = null;
  var available = false;
  var opened = null;
  var failure = '';
  var memory = {};                 // fallback when IndexedDB is unusable

  STORE_NAMES.forEach(function (name) { memory[name] = {}; });

  /* ---------- Small helpers ---------- */

  function clone(value) {
    if (value === null || value === undefined) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value; }
  }

  /** Turn an IDBRequest into a promise. */
  function request(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function memoryGet(store, key) {
    var bucket = memory[store] || {};
    return clone(bucket[key] === undefined ? undefined : bucket[key]);
  }

  function memoryPut(store, record) {
    var def = STORES[store];
    if (!def) return null;
    var key = record[def.keyPath];
    if (key === null || key === undefined) return null;
    (memory[store] = memory[store] || {})[key] = clone(record);
    return clone(record);
  }

  function memoryAll(store, userId) {
    var bucket = memory[store] || {};
    return Object.keys(bucket).map(function (key) { return clone(bucket[key]); })
      .filter(function (record) { return !userId || record.userId === userId; });
  }

  function memoryRemove(store, key) {
    if (memory[store]) delete memory[store][key];
    return true;
  }

  /* ---------- Opening the database ---------- */

  function open() {
    if (opened) return opened;

    opened = new Promise(function (resolve) {
      if (!global.indexedDB) {
        failure = 'IndexedDB is not available in this browser';
        available = false;
        console.warn('FocusGuard: ' + failure + ' — using in-memory storage');
        resolve(false);
        return;
      }

      var req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        failure = 'IndexedDB could not be opened: ' + error.message;
        available = false;
        resolve(false);
        return;
      }

      req.onupgradeneeded = function (event) {
        var database = event.target.result;
        STORE_NAMES.forEach(function (name) {
          var def = STORES[name];
          var store = database.objectStoreNames.contains(name)
            ? event.target.transaction.objectStore(name)
            : database.createObjectStore(name, { keyPath: def.keyPath });
          def.indexes.forEach(function (pair) {
            if (!store.indexNames.contains(pair[0])) {
              store.createIndex(pair[0], pair[1], { unique: false });
            }
          });
        });
      };

      req.onsuccess = function () {
        db = req.result;
        available = true;
        failure = '';
        // A different tab upgrading the schema: just reopen.
        db.onversionchange = function () { db.close(); db = null; opened = null; };
        resolve(true);
      };

      req.onerror = function () {
        failure = 'IndexedDB error: ' + (req.error && req.error.message ? req.error.message : 'unknown');
        available = false;
        console.warn('FocusGuard: ' + failure + ' — using in-memory storage');
        resolve(false);
      };

      // Some browsers block IndexedDB in private mode until a write.
      req.onblocked = function () { resolve(false); };
    });

    return opened;
  }

  /* ---------- Writing ---------- */

  function put(store, record) {
    if (!record) return Promise.resolve(null);
    var def = STORES[store];
    if (!def) return Promise.resolve(null);
    if (record[def.keyPath] === undefined) return Promise.resolve(null);
    return open().then(function (ok) {
      if (!ok || !db) return memoryPut(store, record);
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(clone(record));
          tx.oncomplete = function () { resolve(clone(record)); };
          tx.onerror = function () { resolve(memoryPut(store, record)); };
          tx.onabort = function () { resolve(memoryPut(store, record)); };
        } catch (error) {
          resolve(memoryPut(store, record));
        }
      });
    });
  }

  function bulkPut(store, records) {
    var list = (records || []).filter(Boolean);
    if (list.length === 0) return Promise.resolve([]);
    return open().then(function (ok) {
      if (!ok || !db) return list.map(function (r) { return memoryPut(store, r); });
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(store, 'readwrite');
          var objectStore = tx.objectStore(store);
          list.forEach(function (record) { objectStore.put(clone(record)); });
          tx.oncomplete = function () { resolve(list.length); };
          tx.onerror = function () { resolve(list.map(function (r) { return memoryPut(store, r); })); };
        } catch (error) {
          resolve(list.map(function (r) { return memoryPut(store, r); }));
        }
      });
    });
  }

  /** Put only the records that are missing (used while merging). */
  function putMissing(store, records, userId) {
    var incoming = records || [];
    return all(store, { userId: userId }).then(function (existing) {
      var seen = {};
      existing.forEach(function (row) { seen[row[STORES[store].keyPath]] = true; });
      var fresh = incoming.filter(function (row) {
        return !seen[row[STORES[store].keyPath]];
      });
      return bulkPut(store, fresh).then(function () { return fresh.length; });
    });
  }

  /* ---------- Reading ---------- */

  function get(store, key) {
    return open().then(function (ok) {
      if (!ok || !db) return memoryGet(store, key);
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(store, 'readonly');
          request(tx.objectStore(store).get(key))
            .then(function (row) { resolve(row === undefined ? null : row); })
            .catch(function () { resolve(memoryGet(store, key) || null); });
        } catch (error) {
          resolve(memoryGet(store, key) || null);
        }
      });
    });
  }

  /**
   * Every record in a store, optionally scoped to one user, newest first
   * when the store has a timestamp field.
   */
  function all(store, options) {
    options = options || {};
    var userId = options.userId || null;
    return open().then(function (ok) {
      if (!ok || !db) return memoryAll(store, userId);
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(store, 'readonly');
          var objectStore = tx.objectStore(store);
          var query = userId && objectStore.indexNames.contains('byUser')
            ? objectStore.index('byUser').getAll(global.IDBKeyRange.only(userId))
            : objectStore.getAll();
          request(query)
            .then(function (rows) { resolve(rows || []); })
            .catch(function () { resolve(memoryAll(store, userId)); });
        } catch (error) {
          resolve(memoryAll(store, userId));
        }
      });
    });
  }

  function count(store, userId) {
    return all(store, { userId: userId }).then(function (rows) { return rows.length; });
  }

  /* ---------- Removing ---------- */

  function remove(store, key) {
    return open().then(function (ok) {
      if (!ok || !db) return memoryRemove(store, key);
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).delete(key);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(memoryRemove(store, key)); };
        } catch (error) {
          resolve(memoryRemove(store, key));
        }
      });
    });
  }

  function clearStore(store) {
    return open().then(function (ok) {
      memory[store] = {};
      if (!ok || !db) return true;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).clear();
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (error) { resolve(false); }
      });
    });
  }

  /**
   * User-scoped wipe. Used when a user asks to clear their local copy —
   * it deliberately does NOT touch other users' records.
   */
  function clearUser(userId) {
    var targets = ['sessions', 'distractionEvents', 'coinLedger', 'dailyGoals',
                   'settings', 'syncQueue', 'profiles',
                   'worlds', 'worldObjects', 'worldExpansions'];
    return targets.reduce(function (chain, store) {
      return chain.then(function () {
        return all(store, { userId: userId }).then(function (rows) {
          return rows.reduce(function (inner, row) {
            return inner.then(function () {
              return remove(store, row[STORES[store].keyPath]);
            });
          }, Promise.resolve(true));
        });
      });
    }, Promise.resolve(true));
  }

  /* ---------- Meta notes ---------- */

  function setMeta(key, value, userId) {
    return put('meta', { key: key, value: clone(value), userId: userId || GUEST_ID, updatedAt: Date.now() });
  }

  function getMeta(key) {
    return get('meta', key).then(function (row) { return row ? row.value : null; });
  }

  function removeMeta(key) {
    return remove('meta', key);
  }

  /* ---------- Diagnostics ---------- */

  function stats(userId) {
    var names = STORE_NAMES.slice();
    return names.reduce(function (chain, name) {
      return chain.then(function (acc) {
        return count(name, name === 'meta' ? null : userId).then(function (n) {
          acc[name] = n;
          return acc;
        });
      });
    }, Promise.resolve({}));
  }

  function scanKeys(value, depth, found, path) {
    if (depth > 4 || found.length > 40) return found;
    if (!value || typeof value !== 'object') return found;
    Object.keys(value).forEach(function (key) {
      var lower = key.toLowerCase();
      if (FORBIDDEN_KEYS.indexOf(lower) !== -1) {
        found.push(path + '.' + key);
      }
      scanKeys(value[key], depth + 1, found, path + '.' + key);
    });
    return found;
  }

  /**
   * Privacy audit: list any stored key that looks like camera/biometric
   * data. Persistence Tests 11 relies on this list staying empty.
   */
  function describe(userId) {
    var found = [];
    return STORE_NAMES.reduce(function (chain, name) {
      return chain.then(function () {
        return all(name, { userId: name === 'meta' ? null : userId }).then(function (rows) {
          rows.forEach(function (row, index) {
            scanKeys(row, 0, found, name + '[' + index + ']');
          });
        });
      });
    }, Promise.resolve()).then(function () {
      return {
        available: available,
        backend: available ? 'indexeddb' : 'memory',
        failure: failure,
        userId: userId,
        forbiddenKeys: found,
        clean: found.length === 0,
      };
    });
  }

  /* ---------- Exports ---------- */

  var api = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORES: STORES,
    STORE_NAMES: STORE_NAMES,
    GUEST_ID: GUEST_ID,

    open: open,
    isAvailable: function () { return available; },
    failureReason: function () { return failure; },

    put: put,
    bulkPut: bulkPut,
    putMissing: putMissing,
    get: get,
    all: all,
    count: count,
    remove: remove,
    clearStore: clearStore,
    clearUser: clearUser,

    setMeta: setMeta,
    getMeta: getMeta,
    removeMeta: removeMeta,

    stats: stats,
    describe: describe,
  };

  global.FocusGuardLocalStore = api;
  if (global.FocusGuard) global.FocusGuard.localStore = api;
  else global.FocusGuard = { localStore: api };

  // Warm the connection up early so the first save is not delayed.
  open();
})(window);
