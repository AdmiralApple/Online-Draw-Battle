// Army drafts: what a player has drawn during the setup phase.
// Wire format: { units: [[typeIndex, x, y], ...], terrain: "<base64 RLE of COLS*ROWS bytes>" }

import {
  COLS, ROWS, WORLD, UNITS, UNIT_INDEX, TERRAIN, inZone, tileInZone,
} from './config.js';

export function emptyGrid() {
  return new Uint8Array(COLS * ROWS);
}

// --- Run-length + base64 encoding for terrain grids -------------------------
export function encodeGrid(grid) {
  const bytes = [];
  let i = 0;
  while (i < grid.length) {
    const v = grid[i];
    let run = 1;
    while (i + run < grid.length && grid[i + run] === v && run < 255) run++;
    bytes.push(v, run);
    i += run;
  }
  let bin = '';
  for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
  return btoa(bin);
}

export function decodeGrid(str) {
  const grid = emptyGrid();
  if (typeof str !== 'string' || str.length === 0) return grid;
  let bin;
  try { bin = atob(str); } catch { return grid; }
  let p = 0;
  for (let k = 0; k + 1 < bin.length && p < grid.length; k += 2) {
    const v = bin.charCodeAt(k);
    const run = bin.charCodeAt(k + 1);
    const end = Math.min(grid.length, p + run);
    grid.fill(v < TERRAIN.length ? v : 0, p, end);
    p = end;
  }
  return grid;
}

export function tileAt(grid, x, y) {
  const c = Math.floor(x / WORLD.tile);
  const r = Math.floor(y / WORLD.tile);
  if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return 1; // outside counts as wall
  return grid[r * COLS + c];
}

// --- Costing -----------------------------------------------------------------
export function terrainCounts(grid) {
  const counts = new Array(TERRAIN.length).fill(0);
  for (let i = 0; i < grid.length; i++) if (grid[i]) counts[grid[i]]++;
  return counts;
}

export function unitCost(typeIndex, settings) {
  const d = UNITS[typeIndex];
  // Units that only appear mid-battle (ooze halves) are worth a share of their parent.
  if (d.spawnOnly) return d.parent ? unitCost(UNIT_INDEX[d.parent], settings) * d.share : 0;
  return settings.costs.units[d.key] ?? d.cost;
}

export function terrainCost(terrainId, settings) {
  const t = TERRAIN[terrainId];
  return t ? (settings.costs.terrain[t.key] ?? t.cost) : 0;
}

export function draftCost(units, grid, settings) {
  let cost = 0;
  for (const u of units) cost += unitCost(u[0], settings);
  const counts = terrainCounts(grid);
  for (let id = 1; id < counts.length; id++) cost += counts[id] * terrainCost(id, settings);
  return Math.round(cost * 100) / 100;
}

// --- Validation (server-side authority) ------------------------------------
/**
 * Clean a draft received from a client. Anything outside the player's zone or
 * inside a wall is dropped. Returns { ok, units, grid, cost, error }.
 */
export function validateDraft(raw, side, settings, layout = 2) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Bad draft' };
  const grid = decodeGrid(raw.terrain);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r * COLS + c] && !tileInZone(side, c, r, layout)) grid[r * COLS + c] = 0;
    }
  }
  const units = [];
  const list = Array.isArray(raw.units) ? raw.units : [];
  for (const u of list) {
    if (!Array.isArray(u) || u.length < 3) continue;
    const type = u[0] | 0;
    const x = Number(u[1]);
    const y = Number(u[2]);
    if (type < 0 || type >= UNITS.length || UNITS[type].spawnOnly || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!inZone(side, x, y, 0, layout)) continue;
    const t = TERRAIN[tileAt(grid, x, y)];
    if (t && t.solid) continue;
    units.push([type, Math.round(x * 2) / 2, Math.round(y * 2) / 2]);
  }
  const cost = draftCost(units, grid, settings);
  if (cost > settings.budget + 1e-6) {
    return { ok: false, error: `Over budget (${cost} / ${settings.budget})`, units, grid, cost };
  }
  return { ok: true, units, grid, cost };
}

/**
 * Keep only the parts of a draft inside a zone. Used when a kept army moves to a
 * different seat or map layout between rounds.
 */
export function clipDraftToZone(units, grid, side, layout) {
  const g = grid.slice();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) if (g[r * COLS + c] && !tileInZone(side, c, r, layout)) g[r * COLS + c] = 0;
  }
  const kept = units.filter(([, x, y]) => inZone(side, x, y, 0, layout));
  return { units: kept, grid: g };
}

/** Trim a (possibly over-budget) draft until it fits, dropping the newest units first. */
export function trimToBudget(units, grid, settings) {
  let cost = draftCost(units, grid, settings);
  const kept = units.slice();
  while (cost > settings.budget + 1e-6 && kept.length > 0) {
    const u = kept.pop();
    cost -= unitCost(u[0], settings);
  }
  if (cost > settings.budget + 1e-6) {
    // Still over: terrain alone exceeds budget, wipe it.
    grid.fill(0);
    cost = draftCost(kept, grid, settings);
  }
  return { units: kept, grid, cost: Math.round(cost * 100) / 100 };
}
