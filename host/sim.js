// Authoritative battle simulation. Runs in the host player's browser at TICK_RATE.
// Units are plain objects; a uniform spatial hash answers neighbour queries and
// a per-side Dijkstra flow field steers units around walls and slow terrain.
// Supports any number of sides (1v1 and free-for-all). Every other side is an enemy.
//
// Walls: the flow field may route *through* wall tiles at a high cost, so units use
// real gaps when they exist but break through when an army is fully walled in.
// Wall tiles have hit points; broken tiles become open ground for everyone.

import {
  WORLD, COLS, ROWS, DT, UNITS, TERRAIN, T, BATTLE_TIME_LIMIT,
} from '../shared/config.js';
import { unitCost } from '../shared/draft.js';

const TILE = WORLD.tile;
const HASH_CELL = 40;
const HC = Math.ceil(WORLD.width / HASH_CELL);
const HR = Math.ceil(WORLD.height / HASH_CELL);
const MAX_RADIUS = Math.max(...UNITS.map((u) => u.radius)) * 1.1;
const FLOW_INTERVAL = 0.5;
// Pathing cost of one wall tile, in tiles of open ground. High enough that units walk a
// long way round to a real gap, low enough that an enclosed army still finds a way out.
const WALL_PASS_COST = 60;
export const WALL_HP = 160;
const MAX_EVENTS = 250;

export const PROJ = { ARROW: 0, BOMB: 1 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Small binary min-heap keyed by Float32 distances, used for Dijkstra.
class Heap {
  constructor(cap) { this.idx = new Int32Array(cap * 4); this.key = new Float32Array(cap * 4); this.n = 0; }
  clear() { this.n = 0; }
  push(i, k) {
    if (this.n >= this.idx.length) {
      const ni = new Int32Array(this.idx.length * 2); ni.set(this.idx); this.idx = ni;
      const nk = new Float32Array(this.key.length * 2); nk.set(this.key); this.key = nk;
    }
    let c = this.n++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= k) break;
      this.idx[c] = this.idx[p]; this.key[c] = this.key[p]; c = p;
    }
    this.idx[c] = i; this.key[c] = k;
  }
  pop() {
    const top = this.idx[0];
    this.popKey = this.key[0];
    const li = this.idx[--this.n];
    const lk = this.key[this.n];
    let c = 0;
    for (;;) {
      let m = 2 * c + 1;
      if (m >= this.n) break;
      if (m + 1 < this.n && this.key[m + 1] < this.key[m]) m++;
      if (this.key[m] >= lk) break;
      this.idx[c] = this.idx[m]; this.key[c] = this.key[m]; c = m;
    }
    this.idx[c] = li; this.key[c] = lk;
    return top;
  }
}

const NEIGH = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export class Battle {
  /**
   * @param {{drafts: {units: number[][], grid: Uint8Array}[], settings: object, seed: number}} opts
   */
  constructor({ drafts, settings, seed }) {
    this.settings = settings;
    this.rng = mulberry32(seed || 1);
    this.tick = 0;
    this.time = 0;
    this.over = false;
    this.winner = null; // winning side, or -1 for a draw
    this.sides = drafts.length;
    this.reason = '';
    this.events = [];
    this.projectiles = [];
    this.units = [];
    this.nextId = 1;

    // Merge every player's terrain into one grid.
    this.grid = new Uint8Array(COLS * ROWS);
    for (const d of drafts) {
      for (let i = 0; i < this.grid.length; i++) if (d.grid[i]) this.grid[i] = d.grid[i];
    }
    this.speed = new Float32Array(COLS * ROWS);
    this.solid = new Uint8Array(COLS * ROWS);
    this.wallHp = new Float32Array(COLS * ROWS);
    this.broken = []; // wall tiles destroyed so far (sent to late joiners)
    for (let i = 0; i < this.grid.length; i++) {
      const t = TERRAIN[this.grid[i]];
      this.solid[i] = t && t.solid ? 1 : 0;
      this.speed[i] = t ? (t.solid ? 0 : t.speed) : 1;
      if (this.solid[i]) this.wallHp[i] = WALL_HP;
    }

    drafts.forEach((d, side) => {
      for (const [type, x, y] of d.units) this.spawn(type, side, x, y);
    });

    const perSide = (make) => Array.from({ length: this.sides }, make);
    this.flow = perSide(() => new Float32Array(COLS * ROWS));
    // through[side][i] = 1 when the cheapest route from tile i to an enemy crosses a wall.
    this.through = perSide(() => new Uint8Array(COLS * ROWS));
    this.flowTimer = 0;
    this.heap = new Heap(COLS * ROWS);
    this.hash = Array.from({ length: HC * HR }, () => []);

    this.stats = {
      start: perSide((_, i) => this.countSide(i)),
      startValue: perSide((_, i) => this.valueOf(i)),
      kills: perSide(() => 0),
      healed: perSide(() => 0),
      shots: perSide(() => 0),
    };
  }

  // ---------------------------------------------------------------------------
  spawn(type, side, x, y) {
    const d = UNITS[type];
    const r = d.radius * (1 + (this.rng() - 0.5) * 0.1);
    const toCentre = Math.atan2(WORLD.height / 2 - y, WORLD.width / 2 - x);
    const u = {
      id: this.nextId, type, side, def: d,
      x, y, vx: 0, vy: 0, kx: 0, ky: 0,
      hp: d.hp, maxHp: d.hp, r, mass: d.mass,
      heading: toCentre,
      cd: this.rng() * 0.8, healCd: 0,
      target: null, los: false, retarget: this.rng() * 0.4,
      fdx: Math.cos(toCentre), fdy: Math.sin(toCentre),
      attackAnim: 0, stun: 0, hurt: 0, inWater: false, alive: true, siege: false, flowing: false, stuck: 0, chasing: false, chaseBlock: 0,
    };
    // Units drawn right next to a wall can overlap it. Pop them out to open ground,
    // otherwise every move they try is blocked and they never budge.
    this.unstick(u);
    this.nextId = (this.nextId % 65535) + 1;
    this.units.push(u);
    return u;
  }

  countSide(side) {
    let n = 0;
    for (const u of this.units) if (u.alive && u.side === side) n++;
    return n;
  }

  valueOf(side) {
    let v = 0;
    for (const u of this.units) {
      if (u.alive && u.side === side) v += unitCost(u.type, this.settings) * (u.hp / u.maxHp);
    }
    return v;
  }

  emit(ev) {
    if (this.events.length < MAX_EVENTS || ev.k === 'wall') this.events.push(ev);
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // --- Spatial queries ---------------------------------------------------------
  rebuildHash() {
    for (const cell of this.hash) cell.length = 0;
    for (const u of this.units) {
      if (!u.alive) continue;
      const cx = Math.min(HC - 1, Math.max(0, (u.x / HASH_CELL) | 0));
      const cy = Math.min(HR - 1, Math.max(0, (u.y / HASH_CELL) | 0));
      this.hash[cy * HC + cx].push(u);
    }
  }

  forNear(x, y, radius, fn) {
    const c0 = Math.max(0, ((x - radius) / HASH_CELL) | 0);
    const c1 = Math.min(HC - 1, ((x + radius) / HASH_CELL) | 0);
    const r0 = Math.max(0, ((y - radius) / HASH_CELL) | 0);
    const r1 = Math.min(HR - 1, ((y + radius) / HASH_CELL) | 0);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.hash[r * HC + c];
        for (let i = 0; i < cell.length; i++) fn(cell[i]);
      }
    }
  }

  nearestEnemy(u, maxRange) {
    for (const rad of [70, 160, maxRange]) {
      if (rad > maxRange) continue;
      let best = null;
      let bestD = rad * rad;
      this.forNear(u.x, u.y, rad, (o) => {
        if (o.side === u.side || !o.alive) return;
        const dx = o.x - u.x;
        const dy = o.y - u.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = o; }
      });
      if (best) return best;
    }
    return null;
  }

  // --- Terrain helpers ---------------------------------------------------------
  tileIndex(x, y) {
    const c = Math.floor(x / TILE);
    const r = Math.floor(y / TILE);
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return -1;
    return r * COLS + c;
  }

  isSolidAt(x, y) {
    const i = this.tileIndex(x, y);
    return i < 0 || this.solid[i] === 1;
  }

  /** Does a circle overlap any wall tile or the world edge? */
  circleBlocked(x, y, r) {
    if (x - r < 0 || y - r < 0 || x + r > WORLD.width || y + r > WORLD.height) return true;
    const c0 = Math.floor((x - r) / TILE);
    const c1 = Math.floor((x + r) / TILE);
    const r0 = Math.floor((y - r) / TILE);
    const r1 = Math.floor((y + r) / TILE);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        if (this.solid[row * COLS + col] !== 1) continue;
        const nx = Math.max(col * TILE, Math.min(x, (col + 1) * TILE));
        const ny = Math.max(row * TILE, Math.min(y, (row + 1) * TILE));
        const dx = x - nx;
        const dy = y - ny;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }

  /** Index of a wall tile overlapping the circle (-2 for the world edge, -1 for none). */
  blockingTile(x, y, r) {
    if (x - r < 0 || y - r < 0 || x + r > WORLD.width || y + r > WORLD.height) return -2;
    const c0 = Math.floor((x - r) / TILE);
    const c1 = Math.floor((x + r) / TILE);
    const r0 = Math.floor((y - r) / TILE);
    const r1 = Math.floor((y + r) / TILE);
    let best = -1;
    let bestD = r * r;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = row * COLS + col;
        if (this.solid[i] !== 1) continue;
        const nx = Math.max(col * TILE, Math.min(x, (col + 1) * TILE));
        const ny = Math.max(row * TILE, Math.min(y, (row + 1) * TILE));
        const d2 = (x - nx) ** 2 + (y - ny) ** 2;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
    }
    return best;
  }

  /** Move a unit that overlaps a wall or the map edge to the nearest open spot. */
  unstick(u) {
    if (!this.circleBlocked(u.x, u.y, u.r)) return;
    for (let dist = 1; dist <= 60; dist += 1) {
      const steps = Math.max(8, Math.ceil(dist * 1.5));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const x = u.x + Math.cos(a) * dist;
        const y = u.y + Math.sin(a) * dist;
        if (!this.circleBlocked(x, y, u.r)) { u.x = x; u.y = y; return; }
      }
    }
  }

  damageWall(i, amount) {
    if (i < 0 || this.solid[i] !== 1) return;
    const before = this.wallHp[i];
    this.wallHp[i] -= amount;
    const x = ((i % COLS) + 0.5) * TILE;
    const y = (((i / COLS) | 0) + 0.5) * TILE;
    if (this.wallHp[i] > 0) {
      // Chips fly off as the wall weakens.
      if (Math.floor(before / 40) !== Math.floor(this.wallHp[i] / 40)) this.emit({ k: 'chip', x, y });
      return;
    }
    this.wallHp[i] = 0;
    this.solid[i] = 0;
    this.grid[i] = 0;
    this.speed[i] = 1;
    this.broken.push(i);
    this.emit({ k: 'wall', i, x, y });
    this.flowTimer = Math.min(this.flowTimer, 0.1); // re-plan routes soon
  }

  lineOfSight(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.ceil(Math.hypot(dx, dy) / (TILE * 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.isSolidAt(x0 + dx * t, y0 + dy * t)) return false;
    }
    return true;
  }

  // --- Flow fields ---------------------------------------------------------------
  /**
   * flow[side] = travel cost from each tile to the nearest enemy of `side`.
   * Wall tiles cost WALL_PASS_COST each, so walled-in armies still get a route.
   */
  computeFlow(side) {
    const dist = this.flow[side];
    const through = this.through[side];
    dist.fill(Infinity);
    through.fill(0);
    const heap = this.heap;
    heap.clear();
    for (const u of this.units) {
      if (!u.alive || u.side === side) continue;
      const i = this.tileIndex(u.x, u.y);
      if (i < 0 || dist[i] === 0) continue;
      dist[i] = 0;
      heap.push(i, 0);
    }
    while (heap.n > 0) {
      const i = heap.pop();
      const d = heap.popKey;
      if (d > dist[i]) continue;
      const c = i % COLS;
      const r = (i / COLS) | 0;
      for (const [ox, oy, w] of NEIGH) {
        const nc = c + ox;
        const nr = r + oy;
        if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
        const ni = nr * COLS + nc;
        const wall = this.solid[ni] === 1;
        // No diagonal steps into walls or squeezing between two wall corners.
        if (ox !== 0 && oy !== 0 && (wall || this.solid[i] || this.solid[r * COLS + nc] || this.solid[nr * COLS + c])) continue;
        const nd = d + (wall ? w * WALL_PASS_COST : w / Math.max(0.2, this.speed[ni]));
        if (nd < dist[ni]) {
          dist[ni] = nd;
          through[ni] = wall ? 1 : through[i];
          heap.push(ni, nd);
        }
      }
    }
  }

  /** Unit direction of travel down the flow field, smoothed. Returns false if unreachable. */
  flowDir(u) {
    const dist = this.flow[u.side];
    const i = this.tileIndex(u.x, u.y);
    if (i < 0) return false;
    const c = i % COLS;
    const r = (i / COLS) | 0;
    let best = dist[i];
    let bx = 0;
    let by = 0;
    for (const [ox, oy] of NEIGH) {
      const nc = c + ox;
      const nr = r + oy;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const ni = nr * COLS + nc;
      if (ox !== 0 && oy !== 0 && (this.solid[ni] || this.solid[r * COLS + nc] || this.solid[nr * COLS + c])) continue;
      if (dist[ni] < best) { best = dist[ni]; bx = ox; by = oy; }
    }
    if (!Number.isFinite(best) || (bx === 0 && by === 0)) return false;
    // Following a route that breaks through a wall: bump into it and attack it.
    u.siege = this.through[u.side][i] === 1;
    u.flowing = true;
    const len = Math.hypot(bx, by);
    u.fdx += (bx / len - u.fdx) * 0.35;
    u.fdy += (by / len - u.fdy) * 0.35;
    const fl = Math.hypot(u.fdx, u.fdy) || 1;
    u.fdx /= fl;
    u.fdy /= fl;
    return true;
  }

  // --- Combat ------------------------------------------------------------------
  damage(t, amount, from) {
    if (!t.alive) return;
    t.hp -= amount;
    t.hurt = 0.15;
    if (t.hp <= 0) {
      t.alive = false;
      this.emit({ k: 'die', x: Math.round(t.x), y: Math.round(t.y), s: t.side, ty: t.type });
      if (from) this.stats.kills[from.side]++;
    } else if (amount >= 5) {
      this.emit({ k: 'hit', x: Math.round(t.x), y: Math.round(t.y), s: t.side });
    }
  }

  knock(t, dx, dy, impulse, stun) {
    const k = impulse / Math.max(1, t.mass * 0.8);
    t.kx += dx * k;
    t.ky += dy * k;
    if (stun > 0) t.stun = Math.max(t.stun, stun);
  }

  meleeHit(u, t, dist) {
    const m = u.def.melee;
    const dx = (t.x - u.x) / (dist || 1);
    const dy = (t.y - u.y) / (dist || 1);
    let dmg = m.damage * (0.85 + this.rng() * 0.3);
    if (m.chargeDamage) {
      const frac = Math.min(1, Math.hypot(u.vx, u.vy) / u.def.speed);
      dmg += m.chargeDamage * frac * frac;
      if (frac > 0.4) this.knock(t, dx, dy, m.knockback * frac, 0.5);
    }
    if (m.aoe) {
      const cx = u.x + dx * (u.r + m.reach);
      const cy = u.y + dy * (u.r + m.reach);
      this.emit({ k: 'smash', x: Math.round(cx), y: Math.round(cy), r: m.aoe });
      this.forNear(cx, cy, m.aoe + MAX_RADIUS, (o) => {
        if (o.side === u.side || !o.alive) return;
        const ox = o.x - cx;
        const oy = o.y - cy;
        const d = Math.hypot(ox, oy);
        if (d > m.aoe + o.r) return;
        const fall = 1 - 0.5 * Math.min(1, d / m.aoe);
        this.damage(o, dmg * fall * this.bonus(u, o), u);
        const kd = d || 1;
        this.knock(o, (ox / kd) * 0.6 + dx * 0.4, (oy / kd) * 0.6 + dy * 0.4, m.knockback * fall, 0.6);
      });
    } else {
      this.damage(t, dmg * this.bonus(u, t), u);
      if (m.knockback && !m.chargeDamage) this.knock(t, dx, dy, m.knockback, 0.3);
    }
    u.attackAnim = 1;
  }

  bonus(u, t) {
    const m = u.def.melee;
    return m && m.bonusVsMounted && t.def.mounted ? m.bonusVsMounted : 1;
  }

  fire(u, t) {
    const rg = u.def.ranged;
    const dist = Math.hypot(t.x - u.x, t.y - u.y);
    const flight = dist / rg.speed;
    // Lead the target a little, then add spread that grows with distance.
    let tx = t.x + t.vx * flight * 0.8;
    let ty = t.y + t.vy * flight * 0.8;
    const spread = rg.spread * (0.3 + 0.7 * dist / rg.range);
    const a = this.rng() * Math.PI * 2;
    const s = Math.sqrt(this.rng()) * spread;
    tx += Math.cos(a) * s;
    ty += Math.sin(a) * s;
    const len = Math.hypot(tx - u.x, ty - u.y) || 1;
    // Arrows keep flying a bit past the aim point so they can still hit something.
    const travel = rg.lob ? len : len + 40;
    const dirx = (tx - u.x) / len;
    const diry = (ty - u.y) / len;
    this.nextProjId = ((this.nextProjId || 0) % 65535) + 1;
    this.projectiles.push({
      id: this.nextProjId,
      kind: rg.lob ? PROJ.BOMB : PROJ.ARROW,
      side: u.side, owner: u,
      sx: u.x + dirx * u.r, sy: u.y + diry * u.r,
      ex: u.x + dirx * travel, ey: u.y + diry * travel,
      x: u.x, y: u.y, z: 0,
      t: 0, dur: Math.max(0.05, travel / rg.speed),
      arc: rg.lob ? 30 + len * 0.3 : 0,
      angle: Math.atan2(diry, dirx),
      damage: rg.damage, aoe: rg.aoe || 0, knockback: rg.knockback || 0,
    });
    this.stats.shots[u.side]++;
    u.attackAnim = 1;
    if (rg.lob) this.emit({ k: 'lob', x: Math.round(u.x), y: Math.round(u.y) });
  }

  stepProjectiles() {
    const keep = [];
    for (const p of this.projectiles) {
      p.t += DT;
      const f = Math.min(1, p.t / p.dur);
      const px = p.x;
      const py = p.y;
      p.x = p.sx + (p.ex - p.sx) * f;
      p.y = p.sy + (p.ey - p.sy) * f;
      if (p.kind === PROJ.BOMB) {
        p.z = Math.sin(Math.PI * f) * p.arc;
        p.angle = Math.atan2(p.y - py, p.x - px);
        if (f >= 1) { this.explode(p); continue; }
        keep.push(p);
        continue;
      }
      // Arrow: blocked by walls, hits the first enemy it touches.
      if (this.isSolidAt(p.x, p.y)) continue;
      let hit = null;
      this.forNear(p.x, p.y, MAX_RADIUS + 2, (o) => {
        if (hit || o.side === p.side || !o.alive) return;
        const dx = o.x - p.x;
        const dy = o.y - p.y;
        if (dx * dx + dy * dy <= (o.r + 2) * (o.r + 2)) hit = o;
      });
      if (hit) {
        this.damage(hit, p.damage * (0.85 + this.rng() * 0.3), p.owner);
        continue;
      }
      if (f < 1) keep.push(p);
    }
    this.projectiles = keep;
  }

  explode(p) {
    this.emit({ k: 'boom', x: Math.round(p.x), y: Math.round(p.y), r: p.aoe });
    // Bombs also crack nearby wall tiles.
    const c0 = Math.max(0, Math.floor((p.x - p.aoe) / TILE));
    const c1 = Math.min(COLS - 1, Math.floor((p.x + p.aoe) / TILE));
    const r0 = Math.max(0, Math.floor((p.y - p.aoe) / TILE));
    const r1 = Math.min(ROWS - 1, Math.floor((p.y + p.aoe) / TILE));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = row * COLS + col;
        if (this.solid[i] !== 1) continue;
        const d = Math.hypot((col + 0.5) * TILE - p.x, (row + 0.5) * TILE - p.y);
        if (d <= p.aoe) this.damageWall(i, p.damage * 0.6 * (1 - 0.6 * Math.min(1, d / p.aoe)));
      }
    }
    this.forNear(p.x, p.y, p.aoe + MAX_RADIUS, (o) => {
      if (!o.alive || o.side === p.side) return;
      const dx = o.x - p.x;
      const dy = o.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > p.aoe + o.r) return;
      const fall = 1 - 0.6 * Math.min(1, d / p.aoe);
      this.damage(o, p.damage * fall, p.owner);
      const kd = d || 1;
      this.knock(o, dx / kd, dy / kd, p.knockback * fall, 0.5);
    });
  }

  // --- Unit brains --------------------------------------------------------------
  think(u) {
    const d = u.def;
    if (u.target && !u.target.alive) { u.target = null; u.retarget = 0; }
    u.retarget -= DT;
    if (u.retarget <= 0) {
      u.retarget = 0.25 + this.rng() * 0.15;
      u.target = this.nearestEnemy(u, d.sight);
      u.los = u.target ? this.lineOfSight(u.x, u.y, u.target.x, u.target.y) : false;
    }
    if (d.role === 'healer') return this.thinkHealer(u);
    if (d.role === 'ranged') return this.thinkRanged(u);
    return this.thinkMelee(u);
  }

  advance(u, speed) {
    const t = u.target;
    // Charge straight at a visible target, unless that just ran us into a wall
    // (e.g. seeing through a gap too small to fit through): then follow the route.
    if (t && u.los && u.chaseBlock <= 0) {
      u.chasing = true;
      const dx = t.x - u.x;
      const dy = t.y - u.y;
      const dl = Math.hypot(dx, dy) || 1;
      return [dx / dl * speed, dy / dl * speed];
    }
    if (this.flowDir(u)) return [u.fdx * speed, u.fdy * speed];
    return [0, 0];
  }

  face(u, x, y) {
    u.faceAngle = Math.atan2(y - u.y, x - u.x);
  }

  thinkMelee(u) {
    const d = u.def;
    const t = u.target;
    if (!t) return this.advance(u, d.speed);
    const dist = Math.hypot(t.x - u.x, t.y - u.y);
    const contact = u.r + t.r + d.melee.reach;
    if (dist <= contact && u.los) {
      this.face(u, t.x, t.y);
      if (u.cd <= 0) {
        this.meleeHit(u, t, dist);
        u.cd = d.melee.cooldown * (0.9 + this.rng() * 0.2);
      }
      // Riders keep pushing through; everyone else holds position.
      if (d.melee.chargeDamage) return this.advance(u, d.speed * 0.6);
      return [0, 0];
    }
    return this.advance(u, d.speed);
  }

  thinkRanged(u) {
    const d = u.def;
    const rg = d.ranged;
    const t = u.target;
    if (!t) return this.advance(u, d.speed);
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    const dist = Math.hypot(dx, dy) || 1;
    const tooClose = rg.minRange && dist < rg.minRange;
    const inRange = dist <= rg.range && !tooClose;
    const canShoot = inRange && (rg.lob || u.los) && !u.inWater;
    let vx = 0;
    let vy = 0;
    if (tooClose || (canShoot && dist < rg.keep * 0.6 && t.def.role === 'melee')) {
      // Back away from the threat.
      vx = -dx / dist * d.speed * 0.8;
      vy = -dy / dist * d.speed * 0.8;
    } else if (!canShoot) {
      [vx, vy] = this.advance(u, d.speed);
    }
    if (canShoot) {
      this.face(u, t.x, t.y);
      if (u.cd <= 0) {
        this.fire(u, t);
        u.cd = rg.cooldown * (0.85 + this.rng() * 0.3);
      }
    }
    return [vx, vy];
  }

  thinkHealer(u) {
    const d = u.def;
    const h = d.heal;
    u.retargetHeal = (u.retargetHeal || 0) - DT;
    if (u.retargetHeal <= 0 || (u.patient && (!u.patient.alive || u.patient.hp >= u.patient.maxHp))) {
      u.retargetHeal = 0.4 + this.rng() * 0.2;
      let best = null;
      let bestScore = Infinity;
      this.forNear(u.x, u.y, h.search, (o) => {
        if (o === u || o.side !== u.side || !o.alive || o.hp >= o.maxHp * 0.95) return;
        const dd = Math.hypot(o.x - u.x, o.y - u.y);
        if (dd > h.search) return;
        const score = (o.hp / o.maxHp) * 200 + dd;
        if (score < bestScore) { bestScore = score; best = o; }
      });
      u.patient = best;
      if (!best) {
        // Nobody hurt: tag along behind the nearest friendly fighter.
        let buddy = null;
        let bd = 500 * 500;
        this.forNear(u.x, u.y, 500, (o) => {
          if (o === u || o.side !== u.side || !o.alive || o.def.role === 'healer') return;
          const dd = (o.x - u.x) ** 2 + (o.y - u.y) ** 2;
          if (dd < bd) { bd = dd; buddy = o; }
        });
        u.buddy = buddy;
      }
    }
    // Keep away from enemies that get close.
    const e = u.target;
    if (e) {
      const ed = Math.hypot(e.x - u.x, e.y - u.y);
      if (ed < 80) {
        return [-(e.x - u.x) / ed * d.speed, -(e.y - u.y) / ed * d.speed];
      }
    }
    const p = u.patient;
    if (p) {
      const dx = p.x - u.x;
      const dy = p.y - u.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist <= h.range) {
        if (u.healCd <= 0) {
          const amount = Math.min(h.amount, p.maxHp - p.hp);
          p.hp += amount;
          this.stats.healed[u.side] += amount;
          u.healCd = h.cooldown;
          u.attackAnim = 1;
          this.emit({ k: 'heal', x: Math.round(p.x), y: Math.round(p.y) });
        }
        this.face(u, p.x, p.y);
      }
      if (dist > h.range * 0.7) return [dx / dist * d.speed, dy / dist * d.speed];
      return [0, 0];
    }
    const b = u.buddy;
    if (b && b.alive) {
      const dx = b.x - u.x;
      const dy = b.y - u.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist > 45) return [dx / dist * d.speed, dy / dist * d.speed];
      return [0, 0];
    }
    return [0, 0];
  }

  // --- Main step ----------------------------------------------------------------
  step() {
    if (this.over) return;
    this.tick++;
    this.time += DT;
    this.rebuildHash();

    this.flowTimer -= DT;
    if (this.flowTimer <= 0) {
      this.flowTimer = FLOW_INTERVAL;
      for (let side = 0; side < this.sides; side++) this.computeFlow(side);
    }

    for (const u of this.units) {
      if (!u.alive) continue;
      u.cd -= DT;
      if (u.healCd > 0) u.healCd -= DT;
      if (u.hurt > 0) u.hurt -= DT;
      if (u.attackAnim > 0) u.attackAnim = Math.max(0, u.attackAnim - DT / 0.3);
      u.faceAngle = null;

      const ti = this.tileIndex(u.x, u.y);
      const tid = ti >= 0 ? this.grid[ti] : 0;
      u.inWater = tid === T.WATER;
      const terr = TERRAIN[tid];
      const speedMul = terr && !terr.solid ? terr.speed : 1;
      if (terr && terr.dps) this.damage(u, terr.dps * DT, null);
      if (!u.alive) continue;

      let dvx = 0;
      let dvy = 0;
      u.siege = false;
      u.flowing = false;
      u.chasing = false;
      if (u.stun > 0) {
        u.stun -= DT;
      } else {
        [dvx, dvy] = this.think(u);
      }
      dvx *= speedMul;
      dvy *= speedMul;

      // Accelerate towards the desired velocity.
      const ax = dvx - u.vx;
      const ay = dvy - u.vy;
      const al = Math.hypot(ax, ay);
      const maxA = u.def.accel * DT;
      if (al > maxA) {
        u.vx += ax / al * maxA;
        u.vy += ay / al * maxA;
      } else {
        u.vx = dvx;
        u.vy = dvy;
      }

      // Integrate (walk velocity + knockback), sliding along walls.
      const mx = (u.vx + u.kx) * DT;
      const my = (u.vy + u.ky) * DT;
      const x0 = u.x;
      const y0 = u.y;
      let blocked = -1;
      if (!this.circleBlocked(u.x + mx, u.y, u.r)) u.x += mx;
      else { blocked = this.blockingTile(u.x + mx, u.y, u.r); u.vx = 0; u.kx *= -0.3; }
      if (!this.circleBlocked(u.x, u.y + my, u.r)) u.y += my;
      else { if (blocked === -1) blocked = this.blockingTile(u.x, u.y + my, u.r); u.vy = 0; u.ky *= -0.3; }
      if (blocked !== -1 && this.circleBlocked(u.x, u.y, u.r)) this.unstick(u);
      // Pinned against a wall (e.g. by a gap too narrow for this unit)? Keep count.
      const wanted = Math.hypot(mx, my);
      const pinned = blocked >= 0 && wanted > 0 && Math.hypot(u.x - x0, u.y - y0) < wanted * 0.3;
      if (pinned) u.stuck += DT;
      else u.stuck = Math.max(0, u.stuck - DT * 2);
      if (blocked >= 0 && u.chasing) u.chaseBlock = 0.6;
      else if (u.chaseBlock > 0) u.chaseBlock -= DT;
      // Breaking through: a unit routed through a wall, or stuck against one, attacks the tile in its way.
      if ((u.siege || u.stuck > 0.8) && blocked >= 0 && u.cd <= 0 && u.def.role !== 'healer') this.siegeHit(u, blocked);
      const kd = Math.max(0, 1 - 7 * DT);
      u.kx *= kd;
      u.ky *= kd;

      // Heading: face the enemy when fighting, otherwise the direction of travel.
      let want = u.heading;
      if (u.faceAngle != null) want = u.faceAngle;
      else if (u.vx * u.vx + u.vy * u.vy > 25) want = Math.atan2(u.vy, u.vx);
      let diff = want - u.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const turn = 10 * DT;
      u.heading += Math.max(-turn, Math.min(turn, diff));
    }

    this.separate();
    this.stepProjectiles();
    this.units = this.units.filter((u) => u.alive);
    this.checkEnd();
  }

  siegeHit(u, i) {
    const d = u.def;
    const dmg = d.melee ? d.melee.damage : d.ranged.damage * 0.5;
    const cd = d.melee ? d.melee.cooldown : d.ranged.cooldown * 0.6;
    this.damageWall(i, dmg * (0.85 + this.rng() * 0.3));
    u.cd = cd * (0.9 + this.rng() * 0.2);
    u.attackAnim = 1;
    const tx = ((i % COLS) + 0.5) * TILE;
    const ty = (((i / COLS) | 0) + 0.5) * TILE;
    u.heading = Math.atan2(ty - u.y, tx - u.x);
  }

  /** Push overlapping units apart, heavier units push lighter ones more. */
  separate() {
    this.rebuildHash();
    for (const u of this.units) {
      if (!u.alive) continue;
      this.forNear(u.x, u.y, u.r + MAX_RADIUS, (o) => {
        if (o.id <= u.id || !o.alive) return;
        const dx = o.x - u.x;
        const dy = o.y - u.y;
        const min = u.r + o.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) return;
        let d = Math.sqrt(d2);
        let nx;
        let ny;
        if (d < 1e-4) {
          const a = this.rng() * Math.PI * 2;
          nx = Math.cos(a); ny = Math.sin(a); d = 0;
        } else {
          nx = dx / d; ny = dy / d;
        }
        const overlap = (min - d) * 0.5;
        const total = u.mass + o.mass;
        const pu = overlap * (o.mass / total) * 2;
        const po = overlap * (u.mass / total) * 2;
        const ux = u.x - nx * pu;
        const uy = u.y - ny * pu;
        if (!this.circleBlocked(ux, uy, u.r)) { u.x = ux; u.y = uy; }
        const ox = o.x + nx * po;
        const oy = o.y + ny * po;
        if (!this.circleBlocked(ox, oy, o.r)) { o.x = ox; o.y = oy; }
      });
    }
  }

  checkEnd() {
    const alive = [];
    for (let side = 0; side < this.sides; side++) if (this.countSide(side) > 0) alive.push(side);
    if (alive.length <= 1) {
      this.over = true;
      this.winner = alive.length ? alive[0] : -1;
      this.reason = this.winner === -1 ? 'Mutual destruction' : this.sides > 2 ? 'Last army standing' : 'Army destroyed';
      return;
    }
    if (this.time >= BATTLE_TIME_LIMIT) {
      // Decide on the share of starting strength each surviving army kept.
      const frac = alive.map((side) => [side, this.valueOf(side) / Math.max(1, this.stats.startValue[side])]);
      frac.sort((p, q) => q[1] - p[1]);
      this.over = true;
      if (frac[0][1] - frac[1][1] < 0.02) { this.winner = -1; this.reason = 'Time up, too close to call'; }
      else { this.winner = frac[0][0]; this.reason = 'Time up, decided on surviving strength'; }
    }
  }

  summary() {
    return {
      winner: this.winner,
      reason: this.reason,
      time: Math.round(this.time),
      sides: this.sides,
      survivors: Array.from({ length: this.sides }, (_, i) => this.countSide(i)),
      start: this.stats.start,
      kills: this.stats.kills,
      healed: this.stats.healed.map(Math.round),
      shots: this.stats.shots,
    };
  }
}
