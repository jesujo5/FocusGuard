/* =====================================================================
   FocusGuard — js/worldCatalog.js
   Phase 10 (Parts 6, 7, 20, 29, 30, 31, 38, 44): the Focus World catalog.

   Everything the world can contain lives HERE and nowhere else:
     • the buildable items, their category, cost, unlock tier and rotation
     • the categories shown in the Build panel
     • the four unlock tiers (Basic → Master), keyed by focused minutes
     • the land expansion steps (5×5 → 7×7 → 10×10 → 15×15) and their costs
     • the world-level thresholds
     • the biome list (meadow today; the shape is ready for more later)

   Prices are deliberately centralised. Changing a cost, adding an item or
   moving an unlock milestone is a one-line edit here — never a hunt through
   the rest of the code. Items are plain data; js/worldRenderer.js turns them
   into visuals, so replacing an emoji with an original SVG later means
   changing `icon` (or adding an `art` field) without touching game logic.

   Nothing in this file touches the DOM, storage or the coin ledger: it is a
   pure data + small lookup helpers module.
   ===================================================================== */

(function (global) {
  'use strict';

  /* -------------------------------------------------------------------
     Progression constants
     ------------------------------------------------------------------- */

  var STARTING_GRID = 5;      // a new world starts small and mostly empty
  var MAX_GRID = 15;

  /**
   * Unlock tiers. An item is available once the user's LIFETIME focused
   * study time (measured by the camera pipeline) passes the milestone.
   * Focused time only — never break time, never distracted time.
   */
  var TIERS = [
    { id: 'basic',        name: 'Basic',        unlockMinutes: 0 },
    { id: 'intermediate', name: 'Intermediate', unlockMinutes: 60 },
    { id: 'advanced',     name: 'Advanced',     unlockMinutes: 180 },
    { id: 'master',       name: 'Master',       unlockMinutes: 500 },
  ];

  /**
   * World level thresholds (Part 31). Kept simple on purpose: level rises
   * with focused minutes, nothing else.
   */
  var LEVELS = [
    { level: 1, name: 'Level 1', minMinutes: 0,    maxMinutes: 59 },
    { level: 2, name: 'Level 2', minMinutes: 60,   maxMinutes: 179 },
    { level: 3, name: 'Level 3', minMinutes: 180,  maxMinutes: 499 },
    { level: 4, name: 'Level 4', minMinutes: 500,  maxMinutes: 999 },
    { level: 5, name: 'Level 5', minMinutes: 1000, maxMinutes: Infinity },
  ];

  /**
   * Land expansion steps (Parts 20/21). Existing objects keep their
   * coordinates, so expanding only ever ADDS usable land.
   */
  var EXPANSIONS = [
    { from: 5,  to: 7,  cost: 100 },
    { from: 7,  to: 10, cost: 250 },
    { from: 10, to: 15, cost: 500 },
  ];

  /** Categories, in the order the Build panel shows them. */
  var CATEGORIES = [
    { id: 'nature',     name: 'Nature',     icon: '🌿' },
    { id: 'terrain',    name: 'Terrain',    icon: '⛰️' },
    { id: 'water',      name: 'Water',      icon: '💧' },
    { id: 'structures', name: 'Structures', icon: '🏕️' },
  ];

  /** Biomes. Only `meadow` ships today; the field exists so it can grow. */
  var BIOMES = [
    { id: 'meadow', name: 'Meadow' },
  ];

  /* -------------------------------------------------------------------
     The build catalog (Parts 6/7/44)
     -------------------------------------------------------------------
     `icon` is a temporary emoji placeholder. `art` is intentionally absent
     so that a future original SVG can be slotted in per item without moving
     any of the surrounding logic.
     ------------------------------------------------------------------- */

  var ITEMS = [
    /* --- Nature ------------------------------------------------------- */
    { id: 'grass',      name: 'Grass',      category: 'nature',     tier: 'basic',        cost: 2,   unlockMinutes: 0,   rotatable: false, icon: '🌱' },
    { id: 'flower',     name: 'Flower',     category: 'nature',     tier: 'basic',        cost: 3,   unlockMinutes: 0,   rotatable: false, icon: '🌸' },
    { id: 'rock',       name: 'Rock',       category: 'nature',     tier: 'basic',        cost: 5,   unlockMinutes: 0,   rotatable: false, icon: '🪨' },
    { id: 'mushroom',   name: 'Mushroom',   category: 'nature',     tier: 'basic',        cost: 5,   unlockMinutes: 0,   rotatable: false, icon: '🍄' },
    { id: 'bush',       name: 'Bush',       category: 'nature',     tier: 'basic',        cost: 8,   unlockMinutes: 0,   rotatable: false, icon: '🌿' },
    { id: 'small_tree', name: 'Small Tree', category: 'nature',     tier: 'basic',        cost: 15,  unlockMinutes: 0,   rotatable: false, icon: '🌳' },
    { id: 'large_tree', name: 'Large Tree', category: 'nature',     tier: 'intermediate', cost: 25,  unlockMinutes: 60,  rotatable: false, icon: '🌲' },

    /* --- Terrain ------------------------------------------------------ */
    { id: 'hill',           name: 'Hill',           category: 'terrain', tier: 'intermediate', cost: 30,  unlockMinutes: 60,  rotatable: false, icon: '🏜️' },
    { id: 'small_mountain', name: 'Small Mountain', category: 'terrain', tier: 'advanced',     cost: 50,  unlockMinutes: 180, rotatable: false, icon: '⛰️' },
    { id: 'large_mountain', name: 'Large Mountain', category: 'terrain', tier: 'advanced',     cost: 120, unlockMinutes: 180, rotatable: false, icon: '🏔️' },

    /* --- Water -------------------------------------------------------- */
    { id: 'pond', name: 'Pond', category: 'water', tier: 'intermediate', cost: 60,  unlockMinutes: 60,  rotatable: false, icon: '💧' },
    { id: 'lake', name: 'Lake', category: 'water', tier: 'advanced',     cost: 100, unlockMinutes: 180, rotatable: false, icon: '🌊' },

    /* --- Structures --------------------------------------------------- */
    { id: 'path',       name: 'Path',       category: 'structures', tier: 'basic',        cost: 3,   unlockMinutes: 0,   rotatable: true,  icon: '🛤️' },
    { id: 'campfire',   name: 'Campfire',   category: 'structures', tier: 'intermediate', cost: 35,  unlockMinutes: 60,  rotatable: false, icon: '🏕️' },
    { id: 'bridge',     name: 'Bridge',     category: 'structures', tier: 'intermediate', cost: 40,  unlockMinutes: 60,  rotatable: true,  icon: '🌉' },
    { id: 'small_cabin', name: 'Small Cabin', category: 'structures', tier: 'advanced',   cost: 100, unlockMinutes: 180, rotatable: true,  icon: '🏠' },
  ];

  /* -------------------------------------------------------------------
     Lookups
     ------------------------------------------------------------------- */

  var byId = {};
  ITEMS.forEach(function (item) { byId[item.id] = item; });

  function clone(value) {
    return value ? JSON.parse(JSON.stringify(value)) : value;
  }

  function items() { return ITEMS.map(clone); }

  function item(id) { return byId[id] ? clone(byId[id]) : null; }

  function has(id) { return !!byId[id]; }

  function costOf(id) { return byId[id] ? byId[id].cost : null; }

  function unlockMinutesFor(id) { return byId[id] ? byId[id].unlockMinutes : Infinity; }

  function isRotatable(id) { return !!(byId[id] && byId[id].rotatable); }

  function categories() { return CATEGORIES.map(clone); }

  function category(id) { return CATEGORIES.filter(function (c) { return c.id === id; })[0] || null; }

  function tier(id) { return TIERS.filter(function (t) { return t.id === id; })[0] || null; }

  function tiers() { return TIERS.map(clone); }

  /** Every item in one category, cheapest first (a friendly Build order). */
  function itemsInCategory(categoryId) {
    return ITEMS.filter(function (item) { return item.category === categoryId; })
      .sort(function (a, b) { return a.cost - b.cost; })
      .map(clone);
  }

  /* ---------- Progression ------------------------------------------------ */

  /** The world level for a number of focused minutes. */
  function levelFor(minutes) {
    var value = Math.max(0, Math.floor(Number(minutes) || 0));
    for (var index = LEVELS.length - 1; index >= 0; index -= 1) {
      if (value >= LEVELS[index].minMinutes) return LEVELS[index].level;
    }
    return 1;
  }

  /** Full level detail, including what the next level needs. */
  function levelInfo(minutes) {
    var value = Math.max(0, Math.floor(Number(minutes) || 0));
    var current = null;
    var next = null;
    LEVELS.forEach(function (entry) {
      if (value >= entry.minMinutes) current = entry;
      else if (!next) next = entry;
    });
    return {
      level: current ? current.level : 1,
      name: current ? current.name : 'Level 1',
      minutes: value,
      next: next ? { level: next.level, name: next.name, minutes: next.minMinutes } : null,
      minutesToNext: next ? Math.max(0, next.minMinutes - value) : 0,
      unlocked: current ? current.unlocked : [],
    };
  }

  /** The next expansion step above `gridSize`, or null when at the maximum. */
  function nextExpansion(gridSize) {
    var size = Math.floor(Number(gridSize) || STARTING_GRID);
    var found = EXPANSIONS.filter(function (step) { return step.from === size; })[0];
    return found ? clone(found) : null;
  }

  function expansions() { return EXPANSIONS.map(clone); }

  /** All tiers with their items and whether `minutes` has unlocked them. */
  function unlockTree(minutes) {
    var value = Math.max(0, Math.floor(Number(minutes) || 0));
    return TIERS.map(function (t) {
      return {
        id: t.id,
        name: t.name,
        unlockMinutes: t.unlockMinutes,
        unlocked: value >= t.unlockMinutes,
        items: ITEMS.filter(function (item) { return item.tier === t.id; }).map(clone),
      };
    });
  }

  /* -------------------------------------------------------------------
     Exports
     ------------------------------------------------------------------- */

  var api = {
    STARTING_GRID: STARTING_GRID,
    MAX_GRID: MAX_GRID,

    items: items,
    item: item,
    has: has,
    categories: categories,
    category: category,
    tiers: tiers,
    tier: tier,
    itemsInCategory: itemsInCategory,

    costOf: costOf,
    unlockMinutesFor: unlockMinutesFor,
    isRotatable: isRotatable,

    expansions: expansions,
    nextExpansion: nextExpansion,

    levelFor: levelFor,
    levelInfo: levelInfo,
    unlockTree: unlockTree,

    biomes: function () { return BIOMES.map(clone); },
    biome: function (id) { return (BIOMES.filter(function (b) { return b.id === id; })[0] || BIOMES[0]); },

    isImplemented: function () { return true; },
  };

  global.FocusGuardWorldCatalog = api;
  if (global.FocusGuard) global.FocusGuard.worldCatalog = api;
  else global.FocusGuard = { worldCatalog: api };
})(window);
