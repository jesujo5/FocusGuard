/* =====================================================================
   FocusGuard — js/world.js
   Phase 10 (Parts 4, 5, 8, 9, 10, 15, 16, 17, 18, 19, 20, 21, 27, 45,
   46, 47, 48, 49, 50): the Focus World's state and its operations.

   This module owns ONE thing: the user's world. It keeps the grid size,
   the placed objects, the selection and the rules for changing any of it.
   It never renders (that is js/worldRenderer.js), never builds DOM
   controls (that is js/worldUI.js) and never talks to IndexedDB or
   Supabase directly — persistence is delegated to js/sync.js, which
   already owns the local store and the sync queue.

   ---- The one coin rule ----------------------------------------------
   Coins are NOT tracked here. The ledger in js/focusEngine.js stays the
   only source of truth. A purchase calls engine.spend(cost, {purchaseId}),
   which appends a negative WORLD_PURCHASE entry; the balance the world
   shows is always engine.availableCoins() = earned − spent. There is no
   `worldCoins` variable anywhere, so it can never diverge.

   ---- Idempotency (Part 10) ------------------------------------------
   Every purchase and expansion carries a stable id (derived from the
   object it creates, or from the expansion's target size). engine.spend()
   refuses to write a second ledger entry for the same id, and the sync
   queue upserts by id — so a refresh, a retry or a double-click can never
   charge twice.

   ---- Collision (Part 37) --------------------------------------------
   One primary object per cell. Placing onto an occupied cell is refused
   (never a silent overwrite). Deleting an object soft-deletes it — the
   row stays with `deleted: true` so the delete can sync and last-write-wins
   keeps working across devices — and it does NOT refund coins.
   ===================================================================== */

(function (global) {
  'use strict';

  var GUEST_ID = 'local';
  var DEFAULT_GRID = 5;

  var catalog = null;                 // js/worldCatalog.js, resolved lazily
  var state = emptyWorld(GUEST_ID);
  var selectedId = null;

  var handlers = { change: [], purchase: [], expand: [], remove: [], error: [] };

  /* -------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------- */

  function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  function nowMs() { return Date.now(); }

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
  }

  function catalogApi() {
    if (!catalog) catalog = module('worldCatalog');
    return catalog;
  }

  function engine() { return module('focusEngine'); }

  function syncApi() { return module('sync'); }

  function safeInt(value, fallback) {
    var number = Number(value);
    if (!isFinite(number)) return fallback;
    return Math.floor(number);
  }

  function emptyWorld(uid) {
    return {
      id: uid || GUEST_ID,
      userId: uid || GUEST_ID,
      gridSize: DEFAULT_GRID,
      biome: 'meadow',
      objects: [],
      createdAt: null,
      updatedAt: null,
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

  /* -------------------------------------------------------------------
     Reading the world
     ------------------------------------------------------------------- */

  /** Placed objects only: soft-deleted rows stay in the store for sync. */
  function activeObjects() {
    return state.objects.filter(function (object) { return object.deleted !== true; });
  }

  function getState() {
    return {
      id: state.id,
      userId: state.userId,
      gridSize: state.gridSize,
      biome: state.biome,
      objects: activeObjects().map(clone),
      objectCount: activeObjects().length,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      isImplemented: true,
    };
  }

  function getObjects() { return activeObjects().map(clone); }

  function getGridSize() { return state.gridSize; }

  function objectAt(x, y) {
    return activeObjects().filter(function (object) {
      return object.x === x && object.y === y;
    })[0] || null;
  }

  function getObject(id) {
    return state.objects.filter(function (object) {
      return object.id === id && object.deleted !== true;
    })[0] || null;
  }

  function isFree(x, y) { return !objectAt(x, y); }

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < state.gridSize && y < state.gridSize;
  }

  /* -------------------------------------------------------------------
     Progression (Parts 28-31)
     ------------------------------------------------------------------- */

  /** Lifetime measured FOCUSED study minutes — the only progression metric. */
  function focusedMinutes() {
    var engineApi = engine();
    if (!engineApi || typeof engineApi.getState !== 'function') return 0;
    var value = engineApi.getState().lifetimeFocusedMinutes;
    return isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /** Spendable coins, straight from the ledger (never a second variable). */
  function availableCoins() {
    var engineApi = engine();
    if (!engineApi) return 0;
    if (typeof engineApi.availableCoins === 'function') return engineApi.availableCoins();
    var value = engineApi.getState ? engineApi.getState().availableCoins : 0;
    return isFinite(value) ? Math.max(0, value) : 0;
  }

  function isUnlocked(type) {
    var cat = catalogApi();
    if (!cat) return false;
    return focusedMinutes() >= cat.unlockMinutesFor(type);
  }

  function canAfford(type) {
    var cat = catalogApi();
    if (!cat) return false;
    return cat.costOf(type) <= availableCoins();
  }

  function levelInfo() {
    var cat = catalogApi();
    if (!cat) return { level: 1, minutes: 0, minutesToNext: 0 };
    return cat.levelInfo(focusedMinutes());
  }

  function level() { return levelInfo().level; }

  /** The Build panel's data: every item with its unlock + affordability flags. */
  function catalogView() {
    var cat = catalogApi();
    if (!cat) return [];
    var minutes = focusedMinutes();
    var balance = availableCoins();
    return cat.categories().map(function (category) {
      return {
        id: category.id,
        name: category.name,
        icon: category.icon,
        items: cat.itemsInCategory(category.id).map(function (item) {
          return {
            id: item.id,
            name: item.name,
            icon: item.icon,
            cost: item.cost,
            rotatable: item.rotatable,
            tier: item.tier,
            unlockMinutes: item.unlockMinutes,
            unlocked: minutes >= item.unlockMinutes,
            affordable: item.cost <= balance,
          };
        }),
      };
    });
  }

  /** A compact statistics snapshot for the world sidebar (Part 27). */
  function stats() {
    var cat = catalogApi();
    var objects = activeObjects();
    var counts = { nature: 0, terrain: 0, water: 0, structures: 0 };
    var trees = 0;

    objects.forEach(function (object) {
      var item = cat ? cat.item(object.type) : null;
      if (item && counts[item.category] !== undefined) counts[item.category] += 1;
      if (object.type === 'small_tree' || object.type === 'large_tree') trees += 1;
    });

    var info = levelInfo();
    var engineState = (engine() && engine().getState) ? engine().getState() : {};
    var earned = engineState.totalCoinsEarned || 0;
    var spent = engineState.totalCoinsSpent || 0;

    var unlockTree = cat ? cat.unlockTree(focusedMinutes()) : [];
    var nextLocked = null;
    unlockTree.forEach(function (tier) {
      if (!tier.unlocked && !nextLocked) nextLocked = tier;
    });

    return {
      level: info.level,
      levelName: info.name,
      minutes: info.minutes,
      minutesToNext: info.minutesToNext,
      gridSize: state.gridSize,
      land: state.gridSize * state.gridSize,
      objects: objects.length,
      counts: counts,
      trees: trees,
      water: counts.water,
      structures: counts.structures,
      coinsEarned: earned,
      coinsSpent: spent,
      coinsAvailable: Math.max(0, earned - spent),
      nextUnlock: nextLocked ? { name: nextLocked.name, minutes: nextLocked.unlockMinutes } : null,
      nextExpansion: cat ? cat.nextExpansion(state.gridSize) : null,
    };
  }

  /* -------------------------------------------------------------------
     Selection
     ------------------------------------------------------------------- */

  function select(id) {
    selectedId = id && getObject(id) ? id : null;
    emit('change', getState());
    return selectedId;
  }

  function selected() { return selectedId ? getObject(selectedId) : null; }

  function clearSelection() { select(null); }

  /* -------------------------------------------------------------------
     Persistence delegation (js/sync.js owns the store + queue)
     ------------------------------------------------------------------- */

  function worldRow() {
    return {
      id: state.id,
      userId: state.userId,
      gridSize: state.gridSize,
      biome: state.biome,
      createdAt: state.createdAt || nowMs(),
      updatedAt: state.updatedAt || nowMs(),
    };
  }

  function objectRow(object) {
    return {
      id: object.id,
      userId: object.userId,
      worldId: object.worldId || state.id,
      type: object.type,
      x: object.x,
      y: object.y,
      rotation: object.rotation || 0,
      deleted: object.deleted === true,
      createdAt: object.createdAt || nowMs(),
      updatedAt: object.updatedAt || nowMs(),
    };
  }

  function persistWorld() {
    var sync = syncApi();
    if (sync && typeof sync.persistWorld === 'function') return sync.persistWorld(worldRow());
    return Promise.resolve(null);
  }

  function persistObject(object) {
    var sync = syncApi();
    if (sync && typeof sync.persistWorldObject === 'function') return sync.persistWorldObject(objectRow(object));
    return Promise.resolve(null);
  }

  function persistExpansion(record) {
    var sync = syncApi();
    if (sync && typeof sync.persistWorldExpansion === 'function') return sync.persistWorldExpansion(record);
    return Promise.resolve(null);
  }

  /* -------------------------------------------------------------------
     Loading (called by js/sync.js during hydration)
     ------------------------------------------------------------------- */

  function normalizeObject(row) {
    return {
      id: String(row.id),
      userId: row.userId,
      worldId: row.worldId || null,
      type: row.type,
      x: safeInt(row.x, 0),
      y: safeInt(row.y, 0),
      rotation: ((safeInt(row.rotation, 0) % 360) + 360) % 360,
      deleted: row.deleted === true,
      createdAt: row.createdAt || null,
      updatedAt: row.updatedAt || null,
    };
  }

  function clampGrid(size) {
    var value = safeInt(size, DEFAULT_GRID);
    if (value < DEFAULT_GRID) return DEFAULT_GRID;
    var cat = catalogApi();
    var max = cat ? cat.MAX_GRID : 15;
    return value > max ? max : value;
  }

  /**
   * Rebuild the world from stored rows. `source` is:
   *   { userId, world, objects, expansions }
   * A brand-new user has no world row yet, so one is created (and saved)
   * here — an empty 5×5 meadow is a perfectly valid starting state.
   */
  function hydrate(source) {
    source = source || {};
    var uid = source.userId || state.userId || GUEST_ID;
    var world = source.world || null;

    var objects = (source.objects || []).map(normalizeObject);

    state = {
      id: world ? world.id : uid,
      userId: uid,
      gridSize: clampGrid(world ? world.gridSize : DEFAULT_GRID),
      biome: (world && world.biome) || 'meadow',
      objects: objects,
      createdAt: world ? world.createdAt : null,
      updatedAt: world ? world.updatedAt : null,
    };

    // A missing world row is normal for a new user: create it once so the
    // empty world is itself persisted (and can sync later).
    if (!world) {
      state.id = state.id || uid;
      state.createdAt = nowMs();
      state.updatedAt = nowMs();
      persistWorld();
    }

    emit('change', getState());
    return getState();
  }

  /* -------------------------------------------------------------------
     Operations
     ------------------------------------------------------------------- */

  function nextObjectId() {
    return 'obj-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Buy an item and place it at (x, y). Returns
   *   { ok: true, object, cost, balance, first }
   * or { ok: false, error, message }.
   * The coins are deducted through the ledger BEFORE the object exists, so
   * a failed deduction leaves no object behind.
   */
  function purchase(type, x, y) {
    var cat = catalogApi();
    if (!cat || !cat.has(type)) {
      return fail('unknown-item', 'That item is not in the catalog.');
    }

    x = safeInt(x, -1);
    y = safeInt(y, -1);
    if (!inBounds(x, y)) return fail('out-of-bounds', 'Choose a cell inside your world.');
    if (!isFree(x, y)) return fail('occupied', 'That cell is already taken.');
    if (!isUnlocked(type)) {
      var need = cat.unlockMinutesFor(type);
      return fail('locked', 'Locked — needs ' + need + ' focused minutes.');
    }

    var cost = cat.costOf(type);
    if (cost > availableCoins()) return fail('insufficient', 'Not enough Focus Coins.');

    var objectId = nextObjectId();
    var entry = spend(cost, { purchaseId: 'p-' + objectId, ref: objectId, label: cat.item(type).name });
    if (!entry) return fail('insufficient', 'Not enough Focus Coins.');

    var object = {
      id: objectId,
      userId: state.userId,
      worldId: state.id,
      type: type,
      x: x,
      y: y,
      rotation: 0,
      deleted: false,
      createdAt: nowMs(),
      updatedAt: nowMs(),
    };
    state.objects.push(object);
    state.updatedAt = object.updatedAt;

    persistObject(object);
    persistWorld();

    var result = {
      ok: true,
      object: clone(object),
      cost: cost,
      balance: availableCoins(),
      first: activeObjects().length === 1,
    };
    emit('purchase', result);
    emit('change', getState());
    return result;
  }

  /** Move an owned object to a free cell. Free of charge (Part 17). */
  function move(id, x, y) {
    var object = getObject(id);
    if (!object) return fail('missing', 'Select an object first.');
    x = safeInt(x, -1);
    y = safeInt(y, -1);
    if (!inBounds(x, y)) return fail('out-of-bounds', 'Choose a cell inside your world.');
    if (object.x === x && object.y === y) return { ok: true, object: clone(object), unchanged: true };
    if (!isFree(x, y)) return fail('occupied', 'That cell is already taken.');

    object.x = x;
    object.y = y;
    object.updatedAt = nowMs();
    state.updatedAt = object.updatedAt;
    persistObject(object);

    emit('change', getState());
    return { ok: true, object: clone(object) };
  }

  /** Rotate in 90° steps. Only rotatable items are allowed to turn. */
  function rotate(id, direction) {
    var cat = catalogApi();
    var object = getObject(id);
    if (!object) return fail('missing', 'Select an object first.');
    if (cat && !cat.isRotatable(object.type)) {
      return fail('not-rotatable', 'This item cannot be rotated.');
    }
    var step = direction === 'left' ? -90 : 90;
    object.rotation = ((object.rotation + step) % 360 + 360) % 360;
    object.updatedAt = nowMs();
    state.updatedAt = object.updatedAt;
    persistObject(object);

    emit('change', getState());
    return { ok: true, object: clone(object) };
  }

  /**
   * Remove an object. Coins are NOT refunded (Part 19); the row is
   * soft-deleted so the change can sync and last-write-wins still holds.
   */
  function remove(id) {
    var object = getObject(id);
    if (!object) return fail('missing', 'Select an object first.');

    object.deleted = true;
    object.updatedAt = nowMs();
    state.updatedAt = object.updatedAt;
    if (selectedId === id) selectedId = null;
    persistObject(object);

    var result = { ok: true, object: clone(object) };
    emit('remove', result);
    emit('change', getState());
    return result;
  }

  /**
   * Expand the land. Requires enough coins and changes nothing else:
   * existing objects keep their coordinates (Part 21).
   */
  function expand() {
    var cat = catalogApi();
    if (!cat) return fail('unavailable', 'World is unavailable.');

    var step = cat.nextExpansion(state.gridSize);
    if (!step) return fail('max', 'Your world is already as large as it can grow.');
    if (step.cost > availableCoins()) {
      return fail('insufficient', 'Keep studying to unlock more land.');
    }

    var expansionId = 'exp-' + state.userId + '-' + step.to;
    var entry = spend(step.cost, { purchaseId: expansionId, ref: 'expand:' + step.to, label: 'Land ' + step.to + '×' + step.to });
    if (!entry) return fail('insufficient', 'Keep studying to unlock more land.');

    var record = {
      id: expansionId,
      userId: state.userId,
      worldId: state.id,
      oldGridSize: step.from,
      newGridSize: step.to,
      cost: step.cost,
      createdAt: nowMs(),
      updatedAt: nowMs(),
    };

    state.gridSize = step.to;
    state.updatedAt = record.updatedAt;

    persistExpansion(record);
    persistWorld();

    var result = { ok: true, expansion: clone(record), gridSize: state.gridSize, cost: step.cost, balance: availableCoins() };
    emit('expand', result);
    emit('change', getState());
    return result;
  }

  function fail(error, message) {
    var result = { ok: false, error: error, message: message || 'That did not work.' };
    emit('error', result);
    return result;
  }

  /** Record a spend in the ledger (the engine is the only coin authority). */
  function spend(cost, meta) {
    var engineApi = engine();
    if (!engineApi || typeof engineApi.spend !== 'function') return null;
    return engineApi.spend(cost, meta);
  }

  /** Recompute anything derived. The engine stays the coin source of truth. */
  function reconcile() {
    emit('change', getState());
    return getState();
  }

  function reset() {
    state = emptyWorld(state.userId || GUEST_ID);
    selectedId = null;
    emit('change', getState());
  }

  /* -------------------------------------------------------------------
     Exports
     ------------------------------------------------------------------- */

  var api = {
    isImplemented: function () { return true; },

    getState: getState,
    getObjects: getObjects,
    getGridSize: getGridSize,
    getObject: getObject,
    objectAt: objectAt,
    isFree: isFree,
    inBounds: inBounds,

    focusedMinutes: focusedMinutes,
    availableCoins: availableCoins,
    isUnlocked: isUnlocked,
    canAfford: canAfford,
    level: level,
    levelInfo: levelInfo,
    catalogView: catalogView,
    stats: stats,
    unlocks: function () {
      var cat = catalogApi();
      return cat ? cat.unlockTree(focusedMinutes()) : [];
    },

    select: select,
    selected: selected,
    clearSelection: clearSelection,

    hydrate: hydrate,
    reconcile: reconcile,
    reset: reset,

    purchase: purchase,
    move: move,
    rotate: rotate,
    remove: remove,
    expand: expand,

    // Test-only hook, deliberately NOT wired to any button (Part 50).
    devReset: reset,

    on: on,
  };

  global.FocusGuardWorld = api;
  if (global.FocusGuard) global.FocusGuard.world = api;
  else global.FocusGuard = { world: api };
})(window);
