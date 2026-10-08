/* =====================================================================
   FocusGuard — js/worldUI.js
   Phase 10 (Parts 1, 8, 14, 15, 16, 17, 18, 19, 20, 21, 25, 27, 32, 42,
   51, 52, 53, 54): the My World screen's controls and feedback.

   Everything here is DOM wiring on top of js/world.js (state + rules).
   The UI never invents numbers: the balance comes from the ledger via
   world.availableCoins(), the catalog from worldCatalog, and the grid
   from js/worldRenderer.js.

   Feedback is deliberately gentle (Part 32): a short inline line plus the
   app's existing toast — never an alert() box.
   ===================================================================== */

(function (global) {
  'use strict';

  var catalog = null;
  var mode = 'browse';        // 'browse' | 'place' | 'move'
  var placingType = null;     // the item selected in the Build panel
  var movingId = null;        // the object being moved
  var pendingRemoveId = null; // the object awaiting delete confirmation
  var lastUnlockSignature = '';
  var bound = false;

  /* -------------------------------------------------------------------
     Tiny DOM helpers
     ------------------------------------------------------------------- */

  function q(selector, root) { return (root || document).querySelector(selector); }
  function qa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }
  function setText(selector, text) {
    qa(selector).forEach(function (el) {
      if (el.textContent !== String(text)) el.textContent = String(text);
    });
  }
  function setHidden(selector, hidden) {
    qa(selector).forEach(function (el) { el.hidden = !!hidden; });
  }

  function worldApi() { return global.FocusGuard && global.FocusGuard.world; }
  function engineApi() { return global.FocusGuard && global.FocusGuard.focusEngine; }
  function catalogApi() {
    if (!catalog) catalog = global.FocusGuard && global.FocusGuard.worldCatalog;
    return catalog;
  }
  function rendererApi() { return global.FocusGuard && global.FocusGuard.worldRenderer; }

  /** A short inline message, mirrored to the app toast when it is present. */
  function message(text, kind) {
    var el = q('[data-world-message]');
    if (el) {
      el.textContent = text || '';
      el.dataset.worldMessageKind = kind || 'info';
      el.hidden = !text;
    }
    var sync = global.FocusGuard && global.FocusGuard.sync;
    if (text && sync && typeof sync.toast === 'function') sync.toast(text, kind === 'warn' ? 'warn' : 'ok');
  }

  /* -------------------------------------------------------------------
     Formatting helpers
     ------------------------------------------------------------------- */

  function coins(value) {
    var number = Math.max(0, Math.floor(Number(value) || 0));
    return String(number);
  }

  function minutesText(value) {
    var engine = engineApi();
    if (engine && typeof engine.minutesText === 'function') {
      return engine.minutesText(Math.max(0, value) * 60000);
    }
    return value + 'm';
  }

  /* -------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------- */

  function world() { return worldApi(); }

  function currentOptions() {
    var worldModule = world();
    return {
      mode: mode,
      selectedId: worldModule && worldModule.selected() ? worldModule.selected().id : null,
      movingId: movingId,
    };
  }

  function renderStageAndPreview(state) {
    var renderer = rendererApi();
    if (!renderer) return;
    var options = currentOptions();
    qa('[data-world-stage]').forEach(function (host) {
      renderer.renderStage(host, state, options);
    });
    qa('[data-world-preview]').forEach(function (host) {
      renderer.renderPreview(host, state);
    });
  }

  function renderCatalog(state) {
    var host = q('[data-world-catalog]');
    var worldModule = world();
    if (!host || !worldModule) return;

    var view = worldModule.catalogView();
    var html = '';

    view.forEach(function (category) {
      html += '<div class="world-cat">';
      html += '<p class="world-cat__name"><span aria-hidden="true">' + category.icon + '</span> ' + category.name + '</p>';
      html += '<div class="world-cat__items">';
      category.items.forEach(function (item) {
        var isPlacing = placingType === item.id;
        var classes = 'world-item' + (item.unlocked ? '' : ' is-locked') + (isPlacing ? ' is-selected' : '');
        var title = item.unlocked
          ? item.name + ' — ' + item.cost + ' Focus Coins' + (item.rotatable ? ' (rotatable)' : '')
          : 'Requires ' + item.unlockMinutes + ' focused minutes';
        var costLine = item.unlocked ? item.cost + ' 🪙' : '🔒 ' + item.unlockMinutes + ' min';
        html += '<button type="button" class="' + classes + '" data-world-item="' + item.id + '"'
          + (item.unlocked ? '' : ' aria-disabled="true"')
          + ' aria-pressed="' + (isPlacing ? 'true' : 'false') + '"'
          + ' title="' + title + '">'
          + '<span class="world-item__icon" aria-hidden="true">' + (item.unlocked ? item.icon : '🔒') + '</span>'
          + '<span class="world-item__name">' + item.name + '</span>'
          + '<span class="world-item__cost">' + costLine + '</span>'
          + '</button>';
      });
      html += '</div></div>';
    });

    host.innerHTML = html;
  }

  /** Enable/disable every Rotate control (there is more than one). */
  function setRotateEnabled(enabled) {
    qa('[data-world-action="rotate"]').forEach(function (btn) {
      btn.disabled = !enabled;
      btn.title = enabled ? 'Rotate the selected object 90°' : 'This item cannot be rotated';
    });
  }

  function renderSelection(state) {
    var worldModule = world();
    if (!worldModule) return;

    var selected = worldModule.selected();
    var cat = catalogApi();

    if (selected) {
      var item = cat ? cat.item(selected.type) : null;
      setText('[data-world-selection-name]', item ? item.name : selected.type);
      setText('[data-world-selection-meta]',
        'Cell ' + (selected.x + 1) + ', ' + (selected.y + 1) + ' · ' + (selected.rotation || 0) + '°');
      setHidden('[data-world-selection-actions]', false);
      setRotateEnabled(cat ? cat.isRotatable(selected.type) : false);
      return;
    }

    if (placingType) {
      var placing = cat ? cat.item(placingType) : null;
      setText('[data-world-selection-name]', 'Placing ' + (placing ? placing.name : placingType));
      setText('[data-world-selection-meta]',
        'Cost ' + (placing ? placing.cost : '?') + ' 🪙 · click an empty cell');
      setHidden('[data-world-selection-actions]', true);
      setRotateEnabled(false);
      return;
    }

    setText('[data-world-selection-name]', 'Nothing selected');
    setText('[data-world-selection-meta]', 'Pick an item to build, or tap an object to edit it.');
    setHidden('[data-world-selection-actions]', true);
    setRotateEnabled(false);
  }

  function renderStats(state) {
    var host = q('[data-world-stats]');
    var worldModule = world();
    if (!host || !worldModule) return;

    var stats = worldModule.stats();
    var expansion = stats.nextExpansion;
    var expansionCost = expansion ? expansion.cost : 0;
    var afford = stats.coinsAvailable >= expansionCost;

    var rows = [
      ['World Level', String(stats.level)],
      ['Land', stats.gridSize + ' × ' + stats.gridSize],
      ['Objects', String(stats.objects)],
      ['Trees', String(stats.trees)],
      ['Water', String(stats.water)],
      ['Structures', String(stats.structures)],
      ['Coins earned', coins(stats.coinsEarned) + ' 🪙'],
      ['Coins spent', coins(stats.coinsSpent) + ' 🪙'],
      ['Available', coins(stats.coinsAvailable) + ' 🪙'],
    ];

    var html = rows.map(function (row) {
      return '<div class="world-stat"><span class="muted small">' + row[0] + '</span><strong>' + row[1] + '</strong></div>';
    }).join('');
    host.innerHTML = html;

    // Level pill + friendly caption.
    setText('[data-world-level]', 'Level ' + stats.level);
    setText('[data-world-level-name]', stats.levelName);
    var caption = stats.minutesToNext > 0
      ? 'Your world grows as you study — ' + stats.minutesToNext + ' focused minutes to Level ' + (stats.level + 1) + '.'
      : 'Your world grows as you study.';
    setText('[data-world-level-caption]', caption);

    // Balance readouts (Part 26/47: straight from the ledger).
    setText('[data-world-coins]', coins(stats.coinsAvailable));
    setText('[data-world-earned]', coins(stats.coinsEarned));
    setText('[data-world-spent]', coins(stats.coinsSpent));
    setText('[data-world-count]', String(stats.objects));
    setText('[data-world-grid]', stats.gridSize + ' × ' + stats.gridSize);

    // Expand button.
    var expandBtn = q('[data-world-expand]');
    if (expandBtn) {
      if (!expansion) {
        expandBtn.disabled = true;
        expandBtn.textContent = 'Largest world reached';
        expandBtn.title = 'Your world is already 15 × 15';
      } else {
        expandBtn.disabled = !afford;
        expandBtn.textContent = 'Expand to ' + expansion.to + ' × ' + expansion.to + ' — ' + expansion.cost + ' 🪙';
        expandBtn.title = afford
          ? 'Buy more land for ' + expansion.cost + ' Focus Coins'
          : 'Keep studying to unlock more land';
      }
    }

    // Unlock hint.
    setText('[data-world-unlock]', stats.nextUnlock
      ? 'Next unlock: ' + stats.nextUnlock.name + ' at ' + stats.nextUnlock.minutes + ' focused minutes.'
      : 'Everything in the catalog is unlocked. Well studied.');

    // Any newly reached tier announces itself once (Part 32).
    var unlockSignature = worldModule.unlocks()
      .filter(function (tier) { return tier.unlocked; })
      .map(function (tier) { return tier.id; })
      .join(',');
    if (lastUnlockSignature && unlockSignature !== lastUnlockSignature) {
      message('New items unlocked.', 'ok');
    }
    lastUnlockSignature = unlockSignature;
  }

  function renderEmpty(state) {
    setHidden('[data-world-empty]', state.objectCount > 0);
  }

  function render() {
    var worldModule = world();
    if (!worldModule) return;
    var state = worldModule.getState();

    renderStageAndPreview(state);
    renderCatalog(state);
    renderSelection(state);
    renderStats(state);
    renderEmpty(state);

    // Mode buttons reflect the current mode. Scope to buttons: the grid also
    // carries a data-world-mode attribute as a CSS hook.
    qa('button[data-world-mode]').forEach(function (btn) {
      var active = btn.dataset.worldMode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

  }

  /* -------------------------------------------------------------------
     Actions
     ------------------------------------------------------------------- */

  /** Coalesce the bursts of change events (the engine ticks each second). */
  var renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    global.setTimeout(function () { renderScheduled = false; render(); }, 60);
  }

  function chooseItem(type) {
    var worldModule = world();
    if (!worldModule) return;
    if (!worldModule.isUnlocked(type)) {
      message('Locked — keep studying to unlock this item.', 'warn');
      return;
    }
    placingType = type;
    movingId = null;
    mode = 'place';
    var cat = catalogApi();
    var item = cat ? cat.item(type) : null;
    message('Place ' + (item ? item.name : type) + ' — pick an empty cell.', 'info');
    render();
  }

  function setMode(next) {
    if (next === 'move') {
      var worldModule = world();
      var selected = worldModule && worldModule.selected();
      movingId = selected ? selected.id : null;
      mode = 'move';
      message(movingId ? 'Choose a new cell for this object.' : 'Select an object to move.', 'info');
    } else if (next === 'browse') {
      mode = 'browse';
      movingId = null;
    }
    render();
  }

  function handleStageClick(event) {
    var cell = event.target.closest ? event.target.closest('[data-x][data-y]') : null;
    if (!cell) return;
    var worldModule = world();
    if (!worldModule) return;

    var x = Number(cell.dataset.x);
    var y = Number(cell.dataset.y);
    var objectId = cell.dataset.objectId || '';
    var existing = objectId ? worldModule.getObject(objectId) : null;

    if (mode === 'place' && placingType) {
      if (existing) { message('That cell is already taken.', 'warn'); return; }
      var result = worldModule.purchase(placingType, x, y);
      if (!result.ok) {
        message(result.message || 'That did not work.', 'warn');
        return;
      }
      var cat = catalogApi();
      var item = cat ? cat.item(result.object.type) : null;
      if (result.first) message('Your first piece of Focus World.', 'ok');
      else message((item ? item.name : result.object.type) + ' added to your world.', 'ok');
      // Stay in place mode so the user can keep building the same item.
      render();
      return;
    }

    if (mode === 'move') {
      if (movingId) {
        var moved = worldModule.move(movingId, x, y);
        if (!moved.ok) { message(moved.message || 'That did not work.', 'warn'); return; }
        message('Object moved.', 'ok');
        movingId = null;
        mode = 'browse';
        render();
        return;
      }
      if (existing) {
        movingId = existing.id;
        worldModule.select(existing.id);
        message('Now choose the cell to move it to.', 'info');
        render();
        return;
      }
      message('Select an object to move.', 'warn');
      return;
    }

    // Browse: select (or clear) an object.
    if (existing) worldModule.select(existing.id);
    else worldModule.clearSelection();
    render();
  }

  function handleRotate() {
    var worldModule = world();
    var selected = worldModule && worldModule.selected();
    if (!selected) { message('Select an object to rotate.', 'warn'); return; }
    var result = worldModule.rotate(selected.id);
    if (!result.ok) { message(result.message || 'That did not work.', 'warn'); return; }
    message('Rotated to ' + result.object.rotation + '°.', 'ok');
    render();
  }

  function handleMoveSelected() {
    var worldModule = world();
    var selected = worldModule && worldModule.selected();
    if (!selected) { message('Select an object to move.', 'warn'); return; }
    setMode('move');
  }

  function openRemoveConfirm() {
    var worldModule = world();
    var selected = worldModule && worldModule.selected();
    if (!selected) { message('Select an object to remove.', 'warn'); return; }
    var cat = catalogApi();
    var item = cat ? cat.item(selected.type) : null;
    pendingRemoveId = selected.id;
    setText('[data-world-confirm-text]', 'Remove this object? ' + (item ? item.name : selected.type) + ' will be gone from your world. Coins are not refunded.');
    var dialog = q('[data-world-confirm]');
    if (dialog) { dialog.hidden = false; var yes = q('[data-world-confirm-yes]'); if (yes) yes.focus(); }
  }

  function closeRemoveConfirm() {
    pendingRemoveId = null;
    var dialog = q('[data-world-confirm]');
    if (dialog) dialog.hidden = true;
  }

  function confirmRemove() {
    var worldModule = world();
    if (worldModule && pendingRemoveId) {
      var result = worldModule.remove(pendingRemoveId);
      if (result.ok) message('Object removed.', 'ok');
    }
    closeRemoveConfirm();
    render();
  }

  function handleExpand() {
    var worldModule = world();
    if (!worldModule) return;
    var result = worldModule.expand();
    if (!result.ok) { message(result.message || 'That did not work.', 'warn'); return; }
    message('Your world expanded to ' + result.gridSize + ' × ' + result.gridSize + '.', 'ok');
    render();
  }

  function toggleCatalog(force) {
    var panel = q('[data-world-panel]');
    if (!panel) return;
    var next = typeof force === 'boolean' ? force : panel.hidden;
    panel.hidden = !next;
    qa('[data-world-catalog-toggle]').forEach(function (btn) {
      btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    });
    if (next) {
      var first = q('.world-item:not(.is-locked)', q('[data-world-catalog]'));
      if (first) first.focus();
    }
  }

  /* -------------------------------------------------------------------
     Wiring
     ------------------------------------------------------------------- */

  function on(selector, eventName, handler) {
    qa(selector).forEach(function (el) { el.addEventListener(eventName, handler); });
  }

  function bind() {
    if (bound) return;
    bound = true;

    on('[data-world-catalog-toggle]', 'click', function () { toggleCatalog(); });

    var catalogHost = q('[data-world-catalog]');
    if (catalogHost) {
      catalogHost.addEventListener('click', function (event) {
        var btn = event.target.closest ? event.target.closest('[data-world-item]') : null;
        if (!btn) return;
        chooseItem(btn.dataset.worldItem);
      });
    }

    on('button[data-world-mode="move"]', 'click', function () { setMode('move'); });
    on('button[data-world-mode="browse"]', 'click', function () { setMode('browse'); });
    on('[data-world-action="rotate"]', 'click', handleRotate);
    on('[data-world-action="move"]', 'click', handleMoveSelected);
    on('[data-world-action="delete"]', 'click', openRemoveConfirm);
    on('[data-world-action="expand"]', 'click', handleExpand);
    on('[data-world-action="clear-selection"]', 'click', function () {
      var worldModule = world();
      if (worldModule) worldModule.clearSelection();
      render();
    });

    on('[data-world-confirm-yes]', 'click', confirmRemove);
    on('[data-world-confirm-no]', 'click', closeRemoveConfirm);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        var dialog = q('[data-world-confirm]');
        if (dialog && !dialog.hidden) closeRemoveConfirm();
      }
    });

    // Clicks inside the world stage (delegated once per host).
    qa('[data-world-stage]').forEach(function (host) {
      host.addEventListener('click', handleStageClick);
    });

    // Re-render when the world or the coin ledger changes.
    var worldModule = world();
    if (worldModule && typeof worldModule.on === 'function') {
      worldModule.on('change', scheduleRender);
    }
    var engine = engineApi();
    if (engine && typeof engine.on === 'function') {
      engine.on('change', scheduleRender);
    }

    render();
  }

  var api = {
    isImplemented: function () { return true; },
    render: render,
    bind: bind,
    chooseItem: chooseItem,
    setMode: setMode,
  };

  global.FocusGuardWorldUI = api;
  if (global.FocusGuard) global.FocusGuard.worldUI = api;
  else global.FocusGuard = { worldUI: api };

  function init() {
    // js/world.js is hydrated by js/sync.js; the UI just paints whatever
    // state already exists and then follows the change events.
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
