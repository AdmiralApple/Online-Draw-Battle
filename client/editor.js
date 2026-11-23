// Draw-phase army editor: painting units and terrain within a budget.

import {
  WORLD, COLS, ROWS, UNITS, TERRAIN, MAX_UNITS_PER_PLAYER, inZone, tileInZone,
} from '../shared/config.js';
import { emptyGrid, encodeGrid, tileAt, draftCost } from '../shared/draft.js';

const TILE = WORLD.tile;
const HCELL = 24;
const MAX_UNDO = 40;

function hash3(a, b, c) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Distance from point (px,py) to segment (x0,y0)-(x1,y1). */
function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - x0 - dx * t, py - y0 - dy * t);
}

export class Editor {
  constructor(side, settings) {
    this.side = side;
    this.settings = settings;
    this.units = []; // {type, x, y}
    this.grid = emptyGrid();
    this.cost = 0;
    this.undoStack = [];
    this.tool = { kind: 'unit', type: 0 };
    this.radius = 22;
    this.hash = new Map();
    this.locked = false;
    this.version = 0; // bumps on every change
    this.terrainVersion = 0; // bumps when the terrain grid changes
    this.lastPoint = null;
    this.blockedReason = '';
  }

  load(units, grid) {
    this.units = units.map(([type, x, y]) => ({ type, x, y }));
    this.grid = grid ? grid.slice() : emptyGrid();
    this.undoStack.length = 0;
    this.rebuildHash();
    this.recost();
    this.version++;
    this.terrainVersion++;
  }

  setSettings(settings) {
    this.settings = settings;
    this.recost();
  }

  recost() {
    this.cost = draftCost(this.units.map((u) => [u.type]), this.grid, this.settings);
  }

  unitCost(type) { return this.settings.costs.units[UNITS[type].key]; }
  terrainCost(id) { return id ? this.settings.costs.terrain[TERRAIN[id].key] : 0; }
  get budget() { return this.settings.budget; }

  toWire() {
    return { units: this.units.map((u) => [u.type, u.x, u.y]), terrain: encodeGrid(this.grid) };
  }

  // --- Spatial hash of placed units --------------------------------------------------
  key(cx, cy) { return cy * 1000 + cx; }

  rebuildHash() {
    this.hash.clear();
    for (const u of this.units) this.hashAdd(u);
  }

  hashAdd(u) {
    const k = this.key((u.x / HCELL) | 0, (u.y / HCELL) | 0);
    let cell = this.hash.get(k);
    if (!cell) { cell = []; this.hash.set(k, cell); }
    cell.push(u);
  }

  tooClose(x, y, type) {
    const s = UNITS[type].spacing;
    const reach = s + 50;
    const c0 = Math.floor((x - reach) / HCELL);
    const c1 = Math.floor((x + reach) / HCELL);
    const r0 = Math.floor((y - reach) / HCELL);
    const r1 = Math.floor((y + reach) / HCELL);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.hash.get(this.key(c, r));
        if (!cell) continue;
        for (const o of cell) {
          const min = (s + UNITS[o.type].spacing) * 0.5 * 0.82;
          const dx = o.x - x;
          const dy = o.y - y;
          if (dx * dx + dy * dy < min * min) return true;
        }
      }
    }
    return false;
  }

  canPlaceAt(x, y, type) {
    const r = UNITS[type].radius;
    if (!inZone(this.side, x, y, r)) return false;
    const t = TERRAIN[tileAt(this.grid, x, y)];
    if (t && t.solid) return false;
    return !this.tooClose(x, y, type);
  }

  // --- Strokes -----------------------------------------------------------------------------
  pushUndo() {
    this.undoStack.push({ units: this.units.map((u) => ({ ...u })), grid: this.grid.slice() });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  undo() {
    if (this.locked) return false;
    const s = this.undoStack.pop();
    if (!s) return false;
    this.units = s.units;
    this.grid = s.grid;
    this.rebuildHash();
    this.recost();
    this.version++;
    this.terrainVersion++;
    return true;
  }

  clear() {
    if (this.locked || (this.units.length === 0 && !this.grid.some(Boolean))) return false;
    this.pushUndo();
    this.units = [];
    this.grid = emptyGrid();
    this.rebuildHash();
    this.recost();
    this.version++;
    this.terrainVersion++;
    return true;
  }

  begin(x, y, erase) {
    if (this.locked) return;
    this.pushUndo();
    this.lastPoint = { x, y };
    this.blockedReason = '';
    this.apply(x, y, x, y, erase);
  }

  move(x, y, erase) {
    if (this.locked || !this.lastPoint) return;
    const p = this.lastPoint;
    this.apply(p.x, p.y, x, y, erase);
    this.lastPoint = { x, y };
  }

  end() {
    this.lastPoint = null;
  }

  apply(x0, y0, x1, y1, erase) {
    const before = this.version;
    if (erase || this.tool.kind === 'erase') this.eraseSeg(x0, y0, x1, y1);
    else if (this.tool.kind === 'unit') this.placeSeg(x0, y0, x1, y1);
    else this.paintSeg(x0, y0, x1, y1, this.tool.id);
    return this.version !== before;
  }

  placeSeg(x0, y0, x1, y1) {
    const type = this.tool.type;
    const def = UNITS[type];
    const s = def.spacing;
    const c = this.unitCost(type);
    let added = 0;
    const tryAdd = (x, y) => {
      if (this.units.length >= MAX_UNITS_PER_PLAYER) { this.blockedReason = 'Unit limit reached'; return; }
      if (this.cost + c > this.budget + 1e-6) { this.blockedReason = 'Out of budget'; return; }
      if (!this.canPlaceAt(x, y, type)) return;
      const u = { type, x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2 };
      this.units.push(u);
      this.hashAdd(u);
      this.cost = Math.round((this.cost + c) * 100) / 100;
      added++;
    };

    if (this.radius < s * 0.75) {
      // Fine brush: drop single units along the stroke.
      const len = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(len / (s * 0.5)));
      for (let i = 0; i <= steps; i++) tryAdd(x0 + (x1 - x0) * (i / steps), y0 + (y1 - y0) * (i / steps));
    } else {
      // Fill the stroke with a jittered hex grid so crowds look natural.
      const rowH = s * 0.866;
      const r = this.radius;
      const k0 = Math.floor((Math.min(y0, y1) - r) / rowH);
      const k1 = Math.ceil((Math.max(y0, y1) + r) / rowH);
      const v0 = Math.floor((Math.min(x0, x1) - r) / s) - 1;
      const v1 = Math.ceil((Math.max(x0, x1) + r) / s) + 1;
      for (let k = k0; k <= k1; k++) {
        for (let v = v0; v <= v1; v++) {
          const x = (v + 0.5 * (k & 1) + 0.28 * (2 * hash3(v, k, type + 1) - 1)) * s;
          const y = (k + 0.28 * (2 * hash3(v, k, type + 7) - 1)) * rowH;
          if (segDist(x, y, x0, y0, x1, y1) > r) continue;
          tryAdd(x, y);
        }
      }
    }
    if (added) this.version++;
  }

  forTilesInSeg(x0, y0, x1, y1, radius, fn) {
    const r = Math.max(radius, TILE * 0.5);
    const c0 = Math.max(0, Math.floor((Math.min(x0, x1) - r) / TILE));
    const c1 = Math.min(COLS - 1, Math.floor((Math.max(x0, x1) + r) / TILE));
    const r0 = Math.max(0, Math.floor((Math.min(y0, y1) - r) / TILE));
    const r1 = Math.min(ROWS - 1, Math.floor((Math.max(y0, y1) + r) / TILE));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const cx = (col + 0.5) * TILE;
        const cy = (row + 0.5) * TILE;
        if (segDist(cx, cy, x0, y0, x1, y1) > r) continue;
        fn(row * COLS + col, col, row);
      }
    }
  }

  paintSeg(x0, y0, x1, y1, id) {
    const solid = TERRAIN[id].solid;
    let changed = false;
    const newCost = this.terrainCost(id);
    const touched = [];
    this.forTilesInSeg(x0, y0, x1, y1, this.radius, (i, col, row) => {
      if (this.grid[i] === id || !tileInZone(this.side, col, row)) return;
      const delta = newCost - this.terrainCost(this.grid[i]);
      if (this.cost + delta > this.budget + 1e-6) { this.blockedReason = 'Out of budget'; return; }
      this.grid[i] = id;
      this.cost = Math.round((this.cost + delta) * 100) / 100;
      changed = true;
      if (solid) touched.push(i);
    });
    if (solid && touched.length) {
      // Walls squash any units painted underneath them.
      const before = this.units.length;
      this.units = this.units.filter((u) => {
        const t = TERRAIN[tileAt(this.grid, u.x, u.y)];
        return !(t && t.solid);
      });
      if (this.units.length !== before) { this.rebuildHash(); this.recost(); }
    }
    if (changed) { this.version++; this.terrainVersion++; }
  }

  eraseSeg(x0, y0, x1, y1) {
    const r = Math.max(this.radius, 6);
    const before = this.units.length;
    this.units = this.units.filter((u) => segDist(u.x, u.y, x0, y0, x1, y1) > r + UNITS[u.type].radius * 0.5);
    let changed = this.units.length !== before;
    this.forTilesInSeg(x0, y0, x1, y1, r, (i) => {
      if (this.grid[i]) { this.grid[i] = 0; changed = true; this.terrainVersion++; }
    });
    if (changed) {
      this.rebuildHash();
      this.recost();
      this.version++;
    }
  }

  /** Can the current tool do anything at this point? Used for the brush cursor. */
  pointOk(x, y) {
    if (this.tool.kind === 'erase') return true;
    return inZone(this.side, x, y);
  }
}
