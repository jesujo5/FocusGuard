/* =====================================================================
   FocusGuard — js/worldRenderer.js
   Phase 10 (Parts 22, 23, 24, 25, 40, 41): turning world state into pixels.

   Deliberately lightweight: a CSS grid of cells, each holding a single
   glyph. No WebGL, no canvas, no animation loop — the DOM is rebuilt only
   when the world actually changes, and the cell elements themselves are
   cached so a move/rotate only repaints what is on screen.

   Maximum size is 15×15 = 225 cells, which stays comfortable on a laptop.
   The renderer is used in two places with the same data:
     • the interactive stage on the My World page (js/worldUI.js drives it)
     • the small, non-interactive preview on the Dashboard (Part 25)

   Icons are emoji placeholders for now. Each object also carries
   `world-obj--<type>` and `data-category`, so swapping in original SVG/CSS
   art later is a styling change, not a logic change (Parts 24/44).
   ===================================================================== */

(function (global) {
  'use strict';

  function module(name) {
    return (global.FocusGuard && global.FocusGuard[name]) || null;
  }

  function catalogApi() { return module('worldCatalog'); }

  /* -------------------------------------------------------------------
     Building (and caching) the grid
     ------------------------------------------------------------------- */

  function buildGrid(size, interactive) {
    var grid = document.createElement('div');
    grid.className = interactive ? 'world-grid' : 'world-mini';
    grid.dataset.gridSize = String(size);
    grid.style.setProperty('--grid-size', String(size));
    if (interactive) grid.setAttribute('role', 'grid');

    var cells = [];
    for (var y = 0; y < size; y += 1) {
      for (var x = 0; x < size; x += 1) {
        var cell = document.createElement(interactive ? 'button' : 'span');
        cell.className = 'world-cell';
        if (interactive) {
          cell.type = 'button';
          cell.setAttribute('role', 'gridcell');
        }
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        cells.push(cell);
        grid.appendChild(cell);
      }
    }
    grid.__cells = cells;
    return grid;
  }

  /**
   * The grid element is reused when the size and interaction mode are
   * unchanged, so moving one tree does not rebuild 225 nodes.
   */
  function ensureGrid(host, size, interactive) {
    var key = size + ':' + (interactive ? 'stage' : 'preview');
    var grid = host.querySelector('.world-grid, .world-mini');
    if (grid && grid.dataset.gridKey === key) return grid;
    grid = buildGrid(size, interactive);
    grid.dataset.gridKey = key;
    host.innerHTML = '';
    host.appendChild(grid);
    return grid;
  }

  /* -------------------------------------------------------------------
     Painting objects onto the grid
     ------------------------------------------------------------------- */

  function resetCell(cell, interactive) {
    cell.className = 'world-cell';
    cell.innerHTML = '';
    cell.removeAttribute('title');
    cell.removeAttribute('data-object-id');
    cell.removeAttribute('data-category');
    if (interactive) {
      var x = Number(cell.dataset.x) + 1;
      var y = Number(cell.dataset.y) + 1;
      cell.setAttribute('aria-label', 'Cell ' + x + ', ' + y + ' — empty');
    }
  }

  function paint(host, world, options) {
    options = options || {};
    var interactive = options.interactive !== false;
    var cat = catalogApi();
    var size = Math.max(1, Math.floor(world.gridSize || 5));
    var grid = ensureGrid(host, size, interactive);
    var cells = grid.__cells || [];

    cells.forEach(function (cell) { resetCell(cell, interactive); });

    (world.objects || []).forEach(function (object) {
      var index = object.y * size + object.x;
      var cell = cells[index];
      if (!cell) return;

      var item = cat ? cat.item(object.type) : null;
      cell.classList.add('is-occupied');
      cell.dataset.objectId = object.id;
      if (item) cell.dataset.category = item.category;
      if (object.id === options.selectedId) cell.classList.add('is-selected');
      if (object.id === options.movingId) cell.classList.add('is-moving');

      if (item) {
        var x = object.x + 1;
        var y = object.y + 1;
        cell.title = item.name;
        if (interactive) cell.setAttribute('aria-label', 'Cell ' + x + ', ' + y + ' — ' + item.name);
      }

      var glyph = document.createElement('span');
      glyph.className = 'world-obj world-obj--' + object.type;
      if (item) glyph.dataset.category = item.category;
      glyph.textContent = item ? item.icon : '•';
      glyph.style.transform = 'rotate(' + (Number(object.rotation) || 0) + 'deg)';
      glyph.setAttribute('aria-hidden', 'true');
      cell.appendChild(glyph);
    });

    // NOTE: `data-world-mode` here is a styling hook for the grid. The mode
    // buttons carry the same attribute name, so js/worldUI.js only ever
    // queries `button[data-world-mode]` to keep the two apart.
    grid.dataset.worldMode = options.mode || 'browse';
    grid.dataset.gridSize = String(size);
    return grid;
  }

  /** The interactive My World stage. */
  function renderStage(host, world, options) {
    if (!host) return null;
    return paint(host, world, Object.assign({ interactive: true }, options || {}));
  }

  /** The small, read-only Dashboard preview — same data, no interaction. */
  function renderPreview(host, world) {
    if (!host) return null;
    return paint(host, world, { interactive: false });
  }

  var api = {
    isImplemented: function () { return true; },
    renderStage: renderStage,
    renderPreview: renderPreview,
  };

  global.FocusGuardWorldRenderer = api;
  if (global.FocusGuard) global.FocusGuard.worldRenderer = api;
  else global.FocusGuard = { worldRenderer: api };
})(window);
