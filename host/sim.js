// Authoritative battle simulation. Runs in the host player's browser at TICK_RATE.
// Units are plain objects; a uniform spatial hash answers neighbour queries and
// a per-side Dijkstra flow field steers units around walls and slow terrain.
// Supports any number of sides (1v1 and free-for-all). Every other side is an enemy.
//
// Walls: the flow field may route *through* wall tiles at a high cost, so units use
// real gaps when they exist but break through when an army is fully walled in.
// Wall tiles have hit points; broken tiles become open ground for everyone.
//
// On top of movement and attacks, units have:
//   - morale: they weigh up local odds, fear from nearby deaths, losses in their group
//     and their own wounds, break and flee when it runs out, and rally later;
//   - reaction times and weighted target choice (crowded targets are less attractive,
//     swarmers hunt ranged and support units, sticky units keep their target);
//   - fire (spreads by touch and through brambles, put out by water and medics),
//     ice (low grip, slipping), throws (airborne, landing damage) and explosions
//     (mines, powder kegs and bombs share one blast model).

import {
  WORLD, COLS, ROWS, DT, UNITS, UNIT_INDEX, TERRAIN, T, BATTLE_TIME_LIMIT, mapTerrain,
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
const TAU = Math.PI * 2;

// Fire
const BURN_DPS = 12; // HP per second while burning
const BURN_TIME = 4; // a unit burns for 50-100% of this
const BURN_MORALE = 1.2; // morale lost per second while burning
const BURN_SPREAD = 0.8; // chance per second (x flammability) to catch from a touching burning unit
const TILE_BURN = 3.5; // seconds a bramble tile burns (+0-50%)
const TILE_SPREAD = 1.6; // chance per second for fire to jump to each neighbouring bramble tile
const TILE_IGNITE = 2.5; // chance per second (x flammability) to catch fire standing in flames
const WATER_SEARCH = 220; // burning units run to water this close
// Throws and ice
const GRAVITY = 900;
const SLIP_SPEED = 70;
const SLIP_CHANCE = 0.3; // per second, for low-grip units moving fast on ice
// Morale
const ODDS_RADIUS = 110;
const FEAR_CELL = 32;
const FC = Math.ceil(WORLD.width / FEAR_CELL);
const FR = Math.ceil(WORLD.height / FEAR_CELL);
const FEAR_DECAY = 0.2; // per second
const DEATH_FEAR = 0.3; // left within 90 px of a death, felt by the dead unit's side
const PANIC_FEAR = 0.15; // left within 70 px when a unit breaks
const MORALE_DROP = 0.6; // per second, towards the target morale
const MORALE_RECOVER = 0.12;
const MAX_FLEE = 9; // a routed unit still running after this long turns at bay
const SKITTISH_RADIUS = 240;

export const PROJ = { ARROW: 0, BOMB: 1, BULLET: 2, BOLT: 3 };
const CORPSE_TIME = 40; // seconds a corpse stays fresh enough to raise

// Generals: units earn XP from kills (the victim's base cost) and level up to 4.
const LEVEL_XP = [0, 0, 3, 8, 16]; // XP needed to reach each level
const LEVEL_DMG = 0.2; // extra damage per level above 1
const LEVEL_HP = 0.1; // max HP gained per level
const LEVEL_HEAL = 0.5; // share of max HP healed on levelling up
const COMMAND_RADIUS = 150; // level 3+ units inspire friends this close
const INSPIRE_DMG = 0.15;
const INSPIRE_MORALE = 0.25;
const NAMES = [
  'Bram', 'Odo', 'Wren', 'Tamsin', 'Hal', 'Ivo', 'Mira', 'Cole', 'Juno', 'Alder', 'Bess', 'Rook',
  'Pip', 'Garr', 'Edda', 'Finn', 'Ysolde', 'Hob', 'Nell', 'Corwin', 'Ada', 'Tobin', 'Sable', 'Mott',
  'Ruth', 'Osric', 'Kit', 'Lark', 'Dunstan', 'Vera', 'Quill', 'Basil', 'Greta', 'Ned', 'Ottilie', 'Fen',
];
const EPITHETS = [
  'Bold', 'Unbroken', 'Fierce', 'Grim', 'Wise', 'Swift', 'Mighty', 'Dread', 'Lionheart', 'Stout',
  'Relentless', 'Fearless', 'Wallbreaker', 'Iron', 'Red', 'Undying', 'Terrible', 'Lucky', 'Patient', 'Wild',
];
const SMOKE_SEE = 50; // units inside a smoke cloud can only be seen this close
const POND_MAX = 900; // most water tiles one lightning strike electrifies
const DEFAULT_BOMB_MIN_FRAC = 0.4;

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
const NEIGH4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Battle {
  /**
   * @param {{drafts: {units: number[][], grid: Uint8Array}[], settings: object, seed: number}} opts
   */
  constructor({ drafts, settings, seed, layout }) {
    this.settings = settings;
    this.generals = settings.generals !== false;
    this.moraleOn = settings.morale !== false; // off: nobody ever breaks and runs
    this.rng = mulberry32(seed || 1);
    this.tick = 0;
    this.time = 0;
    this.over = false;
    this.winner = null; // winning side, or -1 for a draw
    this.sides = drafts.length;
    this.reason = '';
    this.events = [];
    this.projectiles = [];
    this.smokes = []; // smoke clouds: { x, y, r, t }
    this.corpses = []; // fresh corpses for necromancers: { x, y, r, t }
    this.units = [];
    this.nextId = 1;

    // The map's own terrain, then every player's terrain on top.
    this.grid = layout ? mapTerrain(layout).slice() : new Uint8Array(COLS * ROWS);
    for (const d of drafts) {
      for (let i = 0; i < this.grid.length; i++) if (d.grid[i]) this.grid[i] = d.grid[i];
    }
    this.speed = new Float32Array(COLS * ROWS);
    this.solid = new Uint8Array(COLS * ROWS);
    this.wallHp = new Float32Array(COLS * ROWS);
    this.broken = []; // wall tiles destroyed so far (sent to late joiners)
    this.changed = new Map(); // other tile changes (burnt brambles, melted ice): index -> new type
    this.tileBurn = new Float32Array(COLS * ROWS); // seconds of fire left on a tile
    this.burning = []; // indexes of burning tiles
    this.iceHp = new Float32Array(COLS * ROWS);
    for (let i = 0; i < this.grid.length; i++) {
      const t = TERRAIN[this.grid[i]];
      this.solid[i] = t && t.solid ? 1 : 0;
      this.speed[i] = t ? (t.solid ? 0 : t.speed) : 1;
      if (this.solid[i]) this.wallHp[i] = WALL_HP;
      if (this.grid[i] === T.ICE) this.iceHp[i] = 1;
    }
    this.fear = Array.from({ length: drafts.length }, () => new Float32Array(FC * FR));

    drafts.forEach((d, side) => {
      for (const [type, x, y] of d.units) this.spawn(type, side, x, y);
    });
    this.buildGroups();

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
      routed: perSide(() => 0),
      fled: perSide(() => 0),
      best: perSide(() => null), // each side's unit with the most kills
    };
  }

  // ---------------------------------------------------------------------------
  spawn(type, side, x, y) {
    const d = UNITS[type];
    const prop = !!d.prop;
    const r = prop ? d.radius : d.radius * (1 + (this.rng() - 0.5) * 0.1);
    const toCentre = Math.atan2(WORLD.height / 2 - y, WORLD.width / 2 - x);
    // Every unit is a little different: braver or more timid, quicker or slower to react.
    const bravery = 0.85 + this.rng() * 0.3;
    const m = d.morale;
    const u = {
      id: this.nextId, type, side, def: d, prop,
      x, y, vx: 0, vy: 0, kx: 0, ky: 0, z: 0, vz: 0,
      hp: d.hp, maxHp: d.hp, r, mass: d.mass,
      heading: toCentre,
      cd: this.rng() * 0.8, healCd: 0,
      target: null, los: false, retarget: this.rng() * 0.4,
      fdx: Math.cos(toCentre), fdy: Math.sin(toCentre),
      attackAnim: 0, stun: 0, hurt: 0, inWater: false, alive: true, siege: false, flowing: false, stuck: 0, chasing: false, chaseBlock: 0,
      bravery, reactMul: 0.4 + this.rng() * 1.6, spd: 0.9 + this.rng() * 0.2,
      morale: m.canBreak ? m.baseline * bravery : 1,
      moraleT: this.rng() * 0.2, moraleAt: 0, fleeing: false, fleeT: 0, steadyT: 0, threat: null,
      reactT: 0, meleeOn: 0, shotOn: 0, dodgeT: 0, dodx: 0, dody: 0,
      panicT: 0, px: x, py: y, burn: 0, wander: this.rng() * TAU, wanderT: 0, waterT: 0, waterX: -1, waterY: -1,
      armed: false, fuse: 0, group: null,
      infected: -1, infBy: null, turnT: 0,
      dashCd: d.dash ? this.rng() * d.dash.cooldown * 0.5 : 0, dashT: 0, dashVx: 0, dashVy: 0, dashHit: null,
      smoked: false, escapeT: 0,
      fuel: d.flame ? d.flame.fuel : 0, reloadT: 0, spray: false,
      aimT: 0, aiming: false, aimTarget: null, castT: 0, castTarget: null,
      restT: this.rng() * 0.4, hopping: false,
      ammo: d.ranged?.mag || 0, alert: !d.provoke, plague: 0, plagueInc: 0, immune: false,
      brood: null, home: null, spawnT: d.nest ? 1 : 0, rageT: 0, hurlCd: 2 + this.rng() * 2, beatCd: this.rng() * 4,
      homeX: -1, homeY: -1, dmgMul: 1, sprintT: 0, sprintCd: 0, maulT: 0, maulHitT: 0, maulTarget: null, retreatT: 0,
      hexCd: 2 + this.rng() * 3, blinkCd: 0, castKind: null, ratFearT: 0, ratX: 0, ratY: 0,
      breathT: 0, breathCd: 1 + this.rng() * 2, roarCd: 0, flyCd: 3, flying: false, flyTX: 0, flyTY: 0, landShock: false,
      hurled: false, hopT: 0, burnt: false, noCorpse: false, grazing: false,
      xp: 0, lvl: 1, kills: 0, name: '', title: '', inspT: 0, leader: null, abilCd: 0, cmdT: this.rng() * 0.5,
    };
    // Gators remember the nearest pond as home.
    if (d.aquatic?.leash) {
      const w = this.findWater(x, y, 450);
      if (w) { u.homeX = w[0]; u.homeY = w[1]; }
    }
    // Units drawn right next to a wall can overlap it. Pop them out to open ground,
    // otherwise every move they try is blocked and they never budge.
    this.unstick(u);
    this.nextId = (this.nextId % 65535) + 1;
    this.units.push(u);
    return u;
  }

  /** Brush strokes aren't recorded, so a "group" is a connected cluster of one unit type. */
  buildGroups() {
    const buckets = new Map();
    for (const u of this.units) {
      if (u.prop) continue;
      const key = u.side * 64 + u.type;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(u);
    }
    for (const list of buckets.values()) {
      const link = list[0].def.spacing * 1.8;
      const l2 = link * link;
      for (const seed of list) {
        if (seed.group) continue;
        const g = { size: 0, dead: 0 };
        const stack = [seed];
        seed.group = g;
        while (stack.length) {
          const a = stack.pop();
          g.size++;
          for (const b of list) {
            if (b.group) continue;
            if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= l2) { b.group = g; stack.push(b); }
          }
        }
      }
    }
  }

  /** Fighting units only: props (mines, kegs) don't count towards an army's survival. */
  countSide(side) {
    let n = 0;
    for (const u of this.units) if (u.alive && !u.prop && u.side === side) n++;
    return n;
  }

  valueOf(side) {
    let v = 0;
    for (const u of this.units) {
      if (u.alive && !u.prop && u.side === side) v += unitCost(u.type, this.settings) * (u.hp / u.maxHp);
    }
    return v;
  }

  emit(ev) {
    // Terrain changes must always reach clients; cosmetic events can be dropped in a flood.
    if (this.events.length < MAX_EVENTS || ev.k === 'wall' || ev.k === 'tile' || ev.k === 'fire' || ev.k === 'lvl') this.events.push(ev);
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Tile changes other than broken walls, as [index, type] pairs (for late joiners). */
  tileChanges() {
    return [...this.changed.entries()];
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
        if (o.side === u.side || !o.alive || o.prop) return;
        const dx = o.x - u.x;
        const dy = o.y - u.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD && this.canSee(u, o, d2) && this.canTarget(u, o)) { bestD = d2; best = o; }
      });
      if (best) return best;
    }
    return null;
  }

  /** Smoke hides the units inside it from anyone further than SMOKE_SEE away. */
  canSee(u, o, d2) {
    // Hidden units (submerged gators and piranhas, necromancers) only show up close.
    if (!u.def.seesHidden) {
      const hide = o.def.stealth || (o.inWater && o.def.aquatic ? o.def.aquatic.hide : 0);
      if (hide && d2 > hide * hide) return false;
    }
    if (!this.smokes.length || d2 <= SMOKE_SEE * SMOKE_SEE) return true;
    for (const s of this.smokes) if ((o.x - s.x) ** 2 + (o.y - s.y) ** 2 < s.r * s.r) return false;
    return true;
  }

  /** Targets a unit can actually go after. */
  canTarget(u, o) {
    if (u.def.waterOnly && !o.inWater) return false;
    if (o.z > 30 && u.def.role === 'melee' && !u.def.flight) return false; // flying out of reach
    return true;
  }

  anyEnemyNear(side, x, y, r) {
    let found = false;
    this.forNear(x, y, r, (o) => {
      if (!found && o.alive && !o.prop && o.side !== side && Math.hypot(o.x - x, o.y - y) < r) found = true;
    });
    return found;
  }

  /** Piranhas can't leave the water once they're in it. */
  okTile(u, x, y) {
    if (!u.def.waterOnly || !u.inWater) return true;
    const i = this.tileIndex(x, y);
    return i >= 0 && this.grid[i] === T.WATER;
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

  /** Change a non-wall tile (brambles burning away, ice melting) and tell clients. */
  setTile(i, t, burnt = false) {
    if (this.grid[i] === t) return;
    this.grid[i] = t;
    const def = TERRAIN[t];
    this.speed[i] = def ? def.speed : 1;
    this.iceHp[i] = t === T.ICE ? 1 : 0;
    this.changed.set(i, t);
    this.emit({ k: 'tile', i, t, b: burnt ? 1 : 0 });
  }

  /** Set a bramble tile alight. */
  igniteTile(i) {
    if (i < 0 || this.tileBurn[i] > 0 || !TERRAIN[this.grid[i]]?.flammable) return;
    const dur = TILE_BURN * (1 + this.rng() * 0.5);
    this.tileBurn[i] = dur;
    this.burning.push(i);
    this.emit({ k: 'fire', i, d: Math.round(dur * 10) / 10 });
  }

  /** Ice loses strength; at zero it turns into a puddle. */
  damageIce(i, amount) {
    if (i < 0 || this.grid[i] !== T.ICE) return;
    const before = this.iceHp[i];
    this.iceHp[i] -= amount;
    if (this.iceHp[i] <= 0) this.setTile(i, T.WATER);
    else if (Math.floor(before * 3) !== Math.floor(this.iceHp[i] * 3)) {
      this.emit({ k: 'crack', x: ((i % COLS) + 0.5) * TILE, y: (((i / COLS) | 0) + 0.5) * TILE });
    }
  }

  stepTiles() {
    if (!this.burning.length) return;
    const list = this.burning;
    const n = list.length; // tiles lit during this pass are appended and start next tick
    const keep = [];
    for (let k = 0; k < n; k++) {
      const i = list[k];
      this.tileBurn[i] -= DT;
      if (this.tileBurn[i] <= 0) {
        this.tileBurn[i] = 0;
        this.setTile(i, T.NONE, true); // burnt to bare ground
        continue;
      }
      keep.push(i);
      const c = i % COLS;
      const r = (i / COLS) | 0;
      for (const [ox, oy] of NEIGH4) {
        const nc = c + ox;
        const nr = r + oy;
        if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
        const ni = nr * COLS + nc;
        if (this.grid[ni] === T.ICE) { this.damageIce(ni, 0.4 * DT); continue; }
        if (this.rng() < TILE_SPREAD * DT) this.igniteTile(ni);
      }
    }
    for (let k = n; k < list.length; k++) keep.push(list[k]);
    this.burning = keep;
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

  /** Nearest water tile within `range` (tile centre), or null. */
  findWater(x, y, range) {
    const rt = Math.ceil(range / TILE);
    const c0 = Math.floor(x / TILE);
    const r0 = Math.floor(y / TILE);
    let best = null;
    let bestD = range * range;
    for (let r = Math.max(0, r0 - rt); r <= Math.min(ROWS - 1, r0 + rt); r++) {
      for (let c = Math.max(0, c0 - rt); c <= Math.min(COLS - 1, c0 + rt); c++) {
        if (this.grid[r * COLS + c] !== T.WATER) continue;
        const wx = (c + 0.5) * TILE;
        const wy = (r + 0.5) * TILE;
        const d2 = (wx - x) ** 2 + (wy - y) ** 2;
        if (d2 < bestD) { bestD = d2; best = [wx, wy]; }
      }
    }
    return best;
  }

  // --- Fear field ------------------------------------------------------------------
  addFear(side, x, y, radius, amount) {
    const f = this.fear[side];
    if (!f) return;
    const c0 = Math.max(0, Math.floor((x - radius) / FEAR_CELL));
    const c1 = Math.min(FC - 1, Math.floor((x + radius) / FEAR_CELL));
    const r0 = Math.max(0, Math.floor((y - radius) / FEAR_CELL));
    const r1 = Math.min(FR - 1, Math.floor((y + radius) / FEAR_CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot((c + 0.5) * FEAR_CELL - x, (r + 0.5) * FEAR_CELL - y);
        if (d > radius) continue;
        const i = r * FC + c;
        f[i] = Math.min(1.5, f[i] + amount * (1 - d / radius));
      }
    }
  }

  fearAt(side, x, y) {
    const c = Math.min(FC - 1, Math.max(0, (x / FEAR_CELL) | 0));
    const r = Math.min(FR - 1, Math.max(0, (y / FEAR_CELL) | 0));
    return Math.min(1, this.fear[side][r * FC + c]);
  }

  decayFear() {
    const k = FEAR_DECAY * DT;
    for (const f of this.fear) {
      for (let i = 0; i < f.length; i++) if (f[i] > 0) f[i] = Math.max(0, f[i] - k);
    }
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
      if (!u.alive || u.prop || u.side === side) continue;
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
        // Burning ground is avoided where possible.
        const fire = this.tileBurn[ni] > 0 ? 6 : 1;
        const nd = d + (wall ? w * WALL_PASS_COST : (w * fire) / Math.max(0.2, this.speed[ni]));
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
    const wx = bx / len;
    const wy = by / len;
    if (wx * u.fdx + wy * u.fdy < -0.3) {
      // Route reverses: snap to it. Smoothing towards an exactly opposite direction
      // would cancel out and renormalise back to the old one.
      u.fdx = wx;
      u.fdy = wy;
    } else {
      u.fdx += (wx - u.fdx) * 0.35;
      u.fdy += (wy - u.fdy) * 0.35;
    }
    const fl = Math.hypot(u.fdx, u.fdy) || 1;
    u.fdx /= fl;
    u.fdy /= fl;
    return true;
  }

  /** Uphill on the flow field: the open neighbour tile farthest from the enemy. */
  escapeDir(u) {
    const dist = this.flow[u.side];
    const i = this.tileIndex(u.x, u.y);
    if (i < 0 || !Number.isFinite(dist[i])) return null;
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
      if (this.solid[ni] || (ox !== 0 && oy !== 0 && (this.solid[r * COLS + nc] || this.solid[nr * COLS + c]))) continue;
      if (Number.isFinite(dist[ni]) && dist[ni] > best) { best = dist[ni]; bx = ox; by = oy; }
    }
    if (bx === 0 && by === 0) return null;
    const len = Math.hypot(bx, by);
    return [bx / len, by / len];
  }

  // --- Damage, status and physics ---------------------------------------------------
  damage(t, amount, from, noShield = false) {
    if (!t.alive) return;
    if (t.prop) {
      t.hp -= amount;
      if (t.hp > 0) return;
      // Explosive props go off on a short fuse; anything else just breaks.
      if (t.def.blast) this.arm(t, 0.15);
      else t.alive = false;
      return;
    }
    if (!noShield && from && t.def.shield) amount *= this.shieldFactor(t, from);
    if (from && from.plague > 0 && from.plagueInc <= 0) amount *= 0.7; // plague saps strength
    if (from && !from.prop) {
      if (from.lvl > 1) amount *= 1 + LEVEL_DMG * (from.lvl - 1);
      if (from.inspT > 0) amount *= 1 + INSPIRE_DMG;
    }
    if (t.inWater && t.def.aquatic) amount *= t.def.aquatic.armour;
    if (t.def.rage && amount >= 5) t.rageT = t.def.rage.time;
    if (t.def.provoke && !t.alert && amount >= 2) this.alertHerd(t);
    t.hp -= amount;
    // Real hits flash the unit and rattle it a little. Damage over time (fire, brambles) doesn't.
    if (amount >= 2) {
      t.hurt = 0.15;
      if (t.def.morale.canBreak) t.morale -= t.def.morale.shock * (0.5 + Math.min(1.5, amount / 20));
    }
    if (t.hp <= 0) { this.kill(t, from); return; }
    if (amount >= 5) this.emit({ k: 'hit', x: Math.round(t.x), y: Math.round(t.y), s: t.side });
    if (t.def.split && amount >= 4) this.split(t);
  }

  /** How much of a hit from `from` gets past a shield: blocks from the front only. */
  shieldFactor(t, from) {
    const sh = t.def.shield;
    if (!sh || t.stun > 0 || t.fleeing || t.z > 0) return 1;
    let a = Math.atan2(from.y - t.y, from.x - t.x) - t.heading;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    if (Math.abs(a) > sh.arc) return 1;
    this.emit({ k: 'block', x: Math.round(t.x + Math.cos(t.heading) * t.r), y: Math.round(t.y + Math.sin(t.heading) * t.r) });
    return 1 - sh.block;
  }

  kill(t, from) {
    t.alive = false;
    this.emit({ k: 'die', x: Math.round(t.x), y: Math.round(t.y), s: t.side, ty: t.type });
    if (from && from.side !== t.side) {
      this.stats.kills[from.side]++;
      this.gainXp(from, t);
    }
    if (t.group) t.group.dead++;
    this.addFear(t.side, t.x, t.y, 90, DEATH_FEAR);
    if (t.infected >= 0) this.rise(t);
    else if (!t.def.noCorpse && !t.noCorpse) {
      this.corpses.push({ x: t.x, y: t.y, r: t.r, t: this.time });
      if (this.corpses.length > 400) this.corpses.shift();
    }
    if (from && from.def && from.def.rage && from.alive) from.rageT = from.def.rage.time;
  }

  // --- Generals ------------------------------------------------------------------
  /** A kill earns XP worth the victim's base cost; enough XP and the killer levels up. */
  gainXp(u, t) {
    if (!u || u.prop || !u.alive || !u.def) return;
    u.kills++;
    if (this.generals) {
      const d = t.def;
      const worth = d.spawnOnly ? (d.parent ? UNITS[UNIT_INDEX[d.parent]].cost * d.share : 0.5) : d.cost;
      u.xp += Math.max(0.5, worth);
      while (u.lvl < 4 && u.xp >= LEVEL_XP[u.lvl + 1]) this.levelUp(u);
    }
    const b = this.stats.best[u.side];
    if (!b || b.id === u.id || u.kills > b.kills) {
      this.stats.best[u.side] = { id: u.id, type: u.type, kills: u.kills, lvl: u.lvl, title: u.title };
    }
  }

  levelUp(u) {
    u.lvl++;
    const gain = u.maxHp * LEVEL_HP;
    u.maxHp += gain;
    u.hp = Math.min(u.maxHp, u.hp + gain + u.maxHp * LEVEL_HEAL);
    if (u.def.morale.canBreak) {
      u.morale = Math.max(u.morale, u.def.morale.baseline);
      u.fleeing = false;
    }
    if (!u.name) u.name = NAMES[(this.rng() * NAMES.length) | 0];
    if (u.lvl === 2) u.title = `Sgt. ${u.name}`;
    else if (u.lvl === 3) u.title = `Capt. ${u.name}`;
    else {
      u.title = `${u.name} the ${EPITHETS[(this.rng() * EPITHETS.length) | 0]}`;
      u.abilCd = 1;
    }
    this.emit({ k: 'lvl', id: u.id, x: Math.round(u.x), y: Math.round(u.y), l: u.lvl, n: u.title, s: u.side });
  }

  /** Captains (level 3+) inspire nearby friends, rally runners and point idle troops at their target. */
  command(u) {
    const t = u.target;
    this.forNear(u.x, u.y, COMMAND_RADIUS, (o) => {
      if (o === u || !o.alive || o.prop || o.side !== u.side || o.def.role === 'nest') return;
      if (o.lvl >= u.lvl && o.lvl >= 3) return; // officers don't take orders from their equals
      if (Math.hypot(o.x - u.x, o.y - u.y) > COMMAND_RADIUS) return;
      o.inspT = 0.8;
      o.leader = u;
      if (o.fleeing && o.fleeT > 1 && o.def.morale.canBreak) {
        o.fleeing = false;
        o.steadyT = 3;
        o.morale = Math.max(o.morale, o.def.morale.rally);
      }
      if (t && t.alive && !o.target && o.def.role !== 'healer'
        && Math.hypot(t.x - o.x, t.y - o.y) < o.def.sight * 1.3 && this.canTarget(o, t)) o.target = t;
    });
  }

  /** Level 4 units get a bonus ability that suits their role. */
  useAbility(u) {
    const d = u.def;
    const t = u.target;
    if (d.role === 'healer') {
      // Mass heal.
      let hurt = 0;
      this.forNear(u.x, u.y, 130, (o) => {
        if (o.alive && !o.prop && o.side === u.side && o.hp < o.maxHp * 0.8 && Math.hypot(o.x - u.x, o.y - u.y) < 130) hurt++;
      });
      if (hurt < 2) { u.abilCd = 1; return; }
      this.forNear(u.x, u.y, 130, (o) => {
        if (!o.alive || o.prop || o.side !== u.side || Math.hypot(o.x - u.x, o.y - u.y) >= 130) return;
        const amount = Math.min(30, o.maxHp - o.hp);
        o.hp += amount;
        this.stats.healed[u.side] += amount;
        this.extinguish(o, false);
        o.infected = -1;
      });
      this.emit({ k: 'cry', x: Math.round(u.x), y: Math.round(u.y), r: 130, h: 1 });
      u.abilCd = 10;
    } else if (d.role === 'melee' && d.melee && !d.hop && !d.pounce && !d.flight) {
      // Whirlwind: hit everyone around at once.
      const R = u.r + 30;
      let n = 0;
      this.forNear(u.x, u.y, R + MAX_RADIUS, (o) => {
        if (o.alive && !o.prop && o.side !== u.side && o.z <= 20 && Math.hypot(o.x - u.x, o.y - u.y) < R + o.r) n++;
      });
      if (n < 2) { u.abilCd = 0.5; return; }
      this.forNear(u.x, u.y, R + MAX_RADIUS, (o) => {
        if (!o.alive || o.prop || o.side === u.side || o.z > 20) return;
        const dx = o.x - u.x;
        const dy = o.y - u.y;
        const dd = Math.hypot(dx, dy) || 1;
        if (dd >= R + o.r) return;
        this.damage(o, d.melee.damage * 1.5, u);
        if (o.alive) this.knock(o, dx / dd, dy / dd, 160, 0.3);
      });
      u.attackAnim = 1;
      this.emit({ k: 'whirl', x: Math.round(u.x), y: Math.round(u.y), r: R });
      u.abilCd = 7;
    } else if (d.role === 'ranged' && d.ranged && d.ranged.projectile && t && t.alive) {
      // Volley: three shots at once.
      const rg = d.ranged;
      const dist = Math.hypot(t.x - u.x, t.y - u.y);
      if (dist > rg.range || (rg.minRange && dist < rg.minRange) || (!rg.lob && !u.los) || u.inWater) { u.abilCd = 0.5; return; }
      for (let k = 0; k < 3; k++) this.fire(u, t);
      this.emit({ k: 'volley', x: Math.round(u.x), y: Math.round(u.y) });
      u.abilCd = 8;
    } else {
      // Battle cry: steadies friends, shakes enemies, and second wind for the hero.
      if (!this.anyEnemyNear(u.side, u.x, u.y, 200)) { u.abilCd = 1; return; }
      this.forNear(u.x, u.y, 150, (o) => {
        if (!o.alive || o.prop || !o.def.morale.canBreak || Math.hypot(o.x - u.x, o.y - u.y) >= 150) return;
        if (o.side === u.side) {
          o.morale = Math.min(1, o.morale + 0.4);
          if (o.fleeing) { o.fleeing = false; o.steadyT = 3; }
        } else o.morale -= 0.1;
      });
      u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.2);
      this.emit({ k: 'cry', x: Math.round(u.x), y: Math.round(u.y), r: 150 });
      u.abilCd = 12;
    }
  }

  /** An infected unit rises again as a ghoul for the side that bit it. */
  rise(t) {
    const g = this.spawn(UNIT_INDEX.ghoul, t.infected, t.x, t.y);
    g.heading = t.heading;
    g.stun = 0.6;
    g.burn = t.burn;
    this.emit({ k: 'rise', x: Math.round(t.x), y: Math.round(t.y), s: t.infected });
    // Watching a friend rise is terrifying.
    this.addFear(t.side, t.x, t.y, 90, DEATH_FEAR);
  }

  /** An ooze hit hard enough splits into two smaller ones sharing what's left of its HP. */
  split(t) {
    const nt = UNIT_INDEX[t.def.split];
    const hp = t.hp / 2;
    t.alive = false;
    const a = this.rng() * TAU;
    for (const s of [-1, 1]) {
      const cx = Math.cos(a) * s;
      const cy = Math.sin(a) * s;
      const c = this.spawn(nt, t.side, t.x + cx * t.r * 0.5, t.y + cy * t.r * 0.5);
      c.hp = Math.min(c.maxHp, hp);
      c.burn = t.burn;
      c.target = t.target;
      c.heading = t.heading;
      c.kx = t.kx + cx * 90;
      c.ky = t.ky + cy * 90;
      c.restT = 0.25 + this.rng() * 0.3;
    }
    this.emit({ k: 'split', x: Math.round(t.x), y: Math.round(t.y), r: Math.round(t.r), s: t.side });
  }

  /** Bite: a chance to infect. Mounted units carry it until they die; others turn soon. */
  infect(u, t, chance) {
    if (!t.alive || t.prop || t.def.undead || t.def.noInfect || t.infected >= 0) return;
    if (this.rng() >= chance) return;
    t.infected = u.side;
    t.infBy = u;
    t.turnT = t.def.mounted ? Infinity : 2 + this.rng() * 1.5;
  }

  catchPlague(t, chance) {
    if (!t.alive || t.prop || t.plague > 0 || t.immune || t.def.undead || t.def.plagueCarrier || t.def.noInfect) return;
    if (this.rng() >= chance) return;
    t.plagueInc = 4;
    t.plague = 4 + 24 * (0.7 + this.rng() * 0.6);
  }

  /** A provoked boar wakes up the rest of its herd. */
  alertHerd(u) {
    u.alert = true;
    const R = u.def.provoke.herd;
    this.forNear(u.x, u.y, R, (o) => {
      if (o.alive && !o.alert && o.type === u.type && o.side === u.side && Math.hypot(o.x - u.x, o.y - u.y) < R) o.alert = true;
    });
  }

  /** A snake swallows its victim whole and grows bigger and stronger. */
  swallow(u, t) {
    t.noCorpse = true;
    t.infected = -1;
    if (t.burn > 0) this.ignite(u, 1);
    this.kill(t, u);
    const gain = t.maxHp * 0.5;
    u.maxHp += gain;
    u.hp = Math.min(u.maxHp, u.hp + gain);
    u.dmgMul = Math.min(2.5, u.dmgMul + 0.15 + t.maxHp / 600);
    u.mass += t.mass * 0.3;
    u.attackAnim = 1;
    this.emit({ k: 'gulp', x: Math.round(t.x), y: Math.round(t.y) });
  }

  /** A giant's swing hits everything in an arc in front of it. */
  sweep(u, t, dx, dy, dmg) {
    const m = u.def.melee;
    const a0 = Math.atan2(dy, dx);
    const reach = u.r + m.reach;
    this.emit({ k: 'sweep', x: Math.round(u.x), y: Math.round(u.y), a: Math.round(a0 * 100) / 100, r: Math.round(reach + 8) });
    this.forNear(u.x, u.y, reach + MAX_RADIUS, (o) => {
      if (o.side === u.side || !o.alive || o.prop || o.z > 20) return;
      const ox = o.x - u.x;
      const oy = o.y - u.y;
      const d = Math.hypot(ox, oy) || 1;
      if (d > reach + o.r) return;
      let da = Math.atan2(oy, ox) - a0;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) > m.sweep + Math.atan2(o.r, d)) return;
      this.damage(o, dmg * this.bonus(u, o), u);
      if (!o.alive) return;
      if (o.mass < m.throwMass && this.rng() < m.throwChance) this.throwUnit(o, ox / d, oy / d, m.knockback, 260);
      else this.knock(o, ox / d, oy / d, m.knockback, 0.5);
    });
  }

  /** Throw a unit or prop so it lands at (x, y) after T seconds. */
  hurlAt(o, x, y, T) {
    o.z = 1;
    o.vz = (GRAVITY * T) / 2;
    o.vx = (x - o.x) / T;
    o.vy = (y - o.y) / T;
    o.kx = 0;
    o.ky = 0;
    o.hurled = true;
    if (!o.prop) o.stun = Math.max(o.stun, T + 0.3);
  }

  /** Something thrown lands on whoever is underneath. */
  crush(o) {
    this.emit({ k: 'land', x: Math.round(o.x), y: Math.round(o.y), r: Math.round(o.r + 4) });
    this.forNear(o.x, o.y, o.r + MAX_RADIUS + 4, (q) => {
      if (q === o || !q.alive || q.prop || q.z > 0) return;
      const dx = q.x - o.x;
      const dy = q.y - o.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > o.r + q.r + 4) return;
      this.damage(q, 18, null);
      if (q.alive) this.knock(q, dx / d, dy / d, 120, 0.4);
    });
  }

  /** The Hexer's curse: the victim becomes a frog that fights for nobody. */
  hex(u, t) {
    if (!t.alive || t.prop) return;
    t.alive = false;
    t.infected = -1;
    if (t.group) t.group.dead++;
    if (t.side !== u.side) {
      this.stats.kills[u.side]++;
      this.gainXp(u, t);
    }
    this.addFear(t.side, t.x, t.y, 90, DEATH_FEAR);
    const f = this.spawn(UNIT_INDEX.frog, t.side, t.x, t.y);
    f.heading = t.heading;
    this.emit({ k: 'hex', x: Math.round(t.x), y: Math.round(t.y) });
  }

  tryHex(u) {
    const hx = u.def.hex;
    if (u.hexCd > 0 || u.castT > 0 || u.reactT > 0 || u.inWater) return;
    let best = null;
    let bs = 0;
    this.forNear(u.x, u.y, hx.range, (o) => {
      if (!o.alive || o.prop || o.side === u.side || o.z > 20) return;
      const d2 = (o.x - u.x) ** 2 + (o.y - u.y) ** 2;
      if (d2 > hx.range * hx.range || !this.canSee(u, o, d2)) return;
      const s = o.def.strength * o.maxHp;
      if (s > bs && this.lineOfSight(u.x, u.y, o.x, o.y)) { bs = s; best = o; }
    });
    if (!best) { u.hexCd = 0.5; return; }
    u.castT = hx.cast;
    u.castKind = 'hex';
    u.castTarget = best;
    u.hexCd = hx.cooldown * (0.8 + this.rng() * 0.4);
    this.emit({ k: 'cast', x: Math.round(u.x), y: Math.round(u.y) });
  }

  /** Teleport away from a threat to a spot with no enemies close by. */
  tryBlink(u, fromX, fromY) {
    const b = u.def.blink;
    const base = Math.atan2(u.y - fromY, u.x - fromX);
    for (let k = 0; k < 8; k++) {
      const a = base + (this.rng() - 0.5) * (k < 4 ? 1.2 : 3.5);
      const x = u.x + Math.cos(a) * b.dist;
      const y = u.y + Math.sin(a) * b.dist;
      if (x < 20 || y < 20 || x > WORLD.width - 20 || y > WORLD.height - 20 || this.circleBlocked(x, y, u.r)) continue;
      if (k < 7 && this.anyEnemyNear(u.side, x, y, 100)) continue;
      this.emit({ k: 'blink', x: Math.round(u.x), y: Math.round(u.y), x1: Math.round(x), y1: Math.round(y) });
      u.x = x;
      u.y = y;
      u.vx = u.vy = u.kx = u.ky = 0;
      u.blinkCd = b.cooldown;
      return true;
    }
    u.blinkCd = 1;
    return false;
  }

  /** Every fresh corpse near the necromancer rises as a skeleton on its side. */
  raise(u) {
    const R = u.def.raise.radius;
    let n = 0;
    this.corpses = this.corpses.filter((c) => {
      if (n >= 12 || Math.hypot(c.x - u.x, c.y - u.y) > R) return true;
      const s = this.spawn(UNIT_INDEX.skeleton, u.side, c.x, c.y);
      s.stun = 0.5;
      n++;
      return false;
    });
    if (!n) return;
    this.emit({ k: 'raise', x: Math.round(u.x), y: Math.round(u.y), r: R });
    const T = u.def.raise.terror;
    const hit = Math.min(0.8, 0.12 + 0.08 * n);
    this.forNear(u.x, u.y, T, (o) => {
      if (!o.alive || o.prop || o.side === u.side || !o.def.morale.canBreak) return;
      const dd = Math.hypot(o.x - u.x, o.y - u.y);
      if (dd < T) o.morale -= hit * (1 - 0.5 * dd / T);
    });
  }

  roar(u) {
    const ro = u.def.roar;
    u.roarCd = ro.every * (0.85 + this.rng() * 0.3);
    u.attackAnim = 1;
    this.emit({ k: 'roar', x: Math.round(u.x), y: Math.round(u.y), r: ro.radius });
    this.forNear(u.x, u.y, ro.radius, (o) => {
      if (!o.alive || o.prop || o.side === u.side || !o.def.morale.canBreak) return;
      const dd = Math.hypot(o.x - u.x, o.y - u.y);
      if (dd < ro.radius) o.morale -= ro.morale * (1 - 0.5 * dd / ro.radius);
    });
  }

  beatChest(u) {
    const b = u.def.beat;
    u.beatCd = b.every;
    u.attackAnim = 1;
    this.emit({ k: 'beat', x: Math.round(u.x), y: Math.round(u.y), r: b.radius });
    this.forNear(u.x, u.y, b.radius, (o) => {
      if (!o.alive || o.prop || o.side === u.side || !o.def.morale.canBreak) return;
      if (Math.hypot(o.x - u.x, o.y - u.y) < b.radius) o.morale -= b.morale;
    });
  }

  /** An ape grabs a powder keg (preferred) or a light enemy and hurls it at its target. */
  tryHurl(u, t) {
    const h = u.def.hurl;
    let best = null;
    let bd = Infinity;
    this.forNear(u.x, u.y, h.grab + MAX_RADIUS, (o) => {
      if (!o.alive || o === u || o === t || o.z > 0 || o.hurled) return;
      const keg = o.prop && o.def.blast && !o.def.mine && !o.armed;
      const light = !o.prop && o.side !== u.side && o.mass <= h.maxMass && !o.def.noStun;
      if (!keg && !light) return;
      const dd = Math.hypot(o.x - u.x, o.y - u.y);
      if (dd > h.grab + o.r) return;
      const score = dd - (keg ? 60 : 0);
      if (score < bd) { bd = score; best = o; }
    });
    if (!best) return false;
    const T = 0.45 + Math.hypot(t.x - best.x, t.y - best.y) / 420;
    this.hurlAt(best, t.x + t.vx * T * 0.6, t.y + t.vy * T * 0.6, T);
    u.hurlCd = h.cooldown * (0.8 + this.rng() * 0.4);
    u.attackAnim = 1;
    this.face(u, t.x, t.y);
    this.emit({ k: 'hurl', x: Math.round(best.x), y: Math.round(best.y) });
    return true;
  }

  landShockwave(u) {
    const sh = u.def.flight.shock;
    const R = u.r + sh.radius;
    this.emit({ k: 'smash', x: Math.round(u.x), y: Math.round(u.y), r: R });
    this.forNear(u.x, u.y, R + MAX_RADIUS, (o) => {
      if (o === u || !o.alive || o.prop || o.side === u.side || o.z > 0) return;
      const dx = o.x - u.x;
      const dy = o.y - u.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > R + o.r) return;
      this.damage(o, sh.damage, u);
      if (o.alive) this.knock(o, dx / d, dy / d, sh.knockback, 0.4);
    });
  }

  safeToThrow(u, t, R) {
    let ok = true;
    this.forNear(t.x, t.y, R + MAX_RADIUS, (o) => {
      if (ok && o !== u && o.alive && !o.prop && o.side === u.side && Math.hypot(o.x - t.x, o.y - t.y) < R) ok = false;
    });
    return ok;
  }

  knock(t, dx, dy, impulse, stun) {
    if (t.prop) return;
    const k = impulse / Math.max(1, t.mass * 0.8);
    t.kx += dx * k;
    t.ky += dy * k;
    if (stun > 0 && !t.def.noStun) t.stun = Math.max(t.stun, stun);
  }

  /** Launch a unit into the air. Heavy and unstoppable units only get shoved. */
  throwUnit(t, dx, dy, impulse, vz) {
    if (t.prop) return;
    if (t.def.noStun || t.mass >= 8) { this.knock(t, dx, dy, impulse * 0.5, 0.3); return; }
    this.knock(t, dx, dy, impulse, 0);
    if (t.z <= 0) { t.z = 0.5; t.vz = vz; }
    t.stun = Math.max(t.stun, (2 * t.vz) / GRAVITY + 0.3);
  }

  /** Roll to set a unit alight. `chance` is scaled by its flammability. */
  ignite(t, chance) {
    if (!t.alive || t.inWater || t.def.flammability <= 0) return;
    if (this.rng() >= chance * t.def.flammability) return;
    if (t.prop) {
      if (t.def.blast) this.arm(t, 1.3); // a burning keg goes off shortly
      else if (t.def.tree && !t.burnt) {
        t.burnt = true; // a tree burns once, for a long time
        t.burn = t.def.tree.burn;
        this.emit({ k: 'ignite', x: Math.round(t.x), y: Math.round(t.y) });
      }
      return;
    }
    if (t.burn <= 0) this.emit({ k: 'ignite', x: Math.round(t.x), y: Math.round(t.y) });
    t.burn = Math.max(t.burn, BURN_TIME * (0.5 + this.rng() * 0.5));
    if (t.plague > 0) { t.plague = 0; t.immune = true; } // fire burns the plague out
    if (t.def.skittish) this.panic(t, t.x - Math.cos(t.heading) * 20, t.y - Math.sin(t.heading) * 20, 1.5);
  }

  extinguish(t, steam) {
    if (t.burn <= 0) return;
    t.burn = 0;
    if (steam) this.emit({ k: 'steam', x: Math.round(t.x), y: Math.round(t.y) });
  }

  /** Skittish units bolt away from a frightening spot. */
  panic(t, x, y, dur) {
    if (!t.alive || t.prop || !t.def.skittish) return;
    t.panicT = Math.max(t.panicT, dur);
    t.px = x;
    t.py = y;
  }

  /** Light the fuse on a mine or keg. Shorter fuses replace longer ones. */
  arm(p, fuse) {
    if (!p.alive || !p.def.blast) return;
    if (p.armed && p.fuse <= fuse) return;
    if (!p.armed && p.def.mine) this.emit({ k: 'beep', x: Math.round(p.x), y: Math.round(p.y) });
    p.armed = true;
    p.fuse = fuse;
  }

  startFlee(u) {
    if (u.fleeing || !this.moraleOn) return;
    u.fleeing = true;
    u.fleeT = 0;
    u.target = null;
    this.stats.routed[u.side]++;
    this.addFear(u.side, u.x, u.y, 70, PANIC_FEAR);
  }

  /**
   * One explosion model for bombs, mines and kegs. `side` >= 0 spares that side's units
   * (no friendly fire from bombs); -1 hurts everyone. `source` is credited with kills.
   */
  explode(x, y, b, side, source) {
    const R = b.radius;
    const minFrac = b.minFrac ?? DEFAULT_BOMB_MIN_FRAC;
    this.emit({ k: 'boom', x: Math.round(x), y: Math.round(y), r: R });
    // Terrain: crack walls, light brambles, shatter ice.
    const c0 = Math.max(0, Math.floor((x - R) / TILE));
    const c1 = Math.min(COLS - 1, Math.floor((x + R) / TILE));
    const r0 = Math.max(0, Math.floor((y - R) / TILE));
    const r1 = Math.min(ROWS - 1, Math.floor((y + R) / TILE));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = row * COLS + col;
        const d = Math.hypot((col + 0.5) * TILE - x, (row + 0.5) * TILE - y);
        if (d > R) continue;
        if (this.solid[i] === 1) this.damageWall(i, b.damage * 0.6 * (1 - 0.6 * Math.min(1, d / R)));
        else if (d <= R * 0.6) {
          if (this.grid[i] === T.ICE) this.damageIce(i, 1);
          else if (TERRAIN[this.grid[i]]?.flammable) this.igniteTile(i);
        }
      }
    }
    // Units and props. Walls between the blast and a unit shield it.
    this.forNear(x, y, R * 1.25 + MAX_RADIUS, (o) => {
      if (!o.alive || o === source) return;
      const dx = o.x - x;
      const dy = o.y - y;
      const d = Math.hypot(dx, dy);
      if (o.prop) {
        if (o.def.mine && d <= R * 1.25) this.arm(o, 0.07 + this.rng() * 0.16); // chain reaction
        else if (o.def.blast && d <= R + o.r) this.damage(o, b.damage, source);
        return;
      }
      if (side >= 0 && o.side === side) return;
      if (d > R + o.r || o.z > 20) return;
      if (d > o.r && !this.lineOfSight(x, y, o.x, o.y)) return;
      const fall = Math.max(minFrac, 1 - d / (R + o.r));
      const dmg = b.damage * fall;
      this.damage(o, dmg, source, true);
      if (!o.alive) return;
      const kd = d || 1;
      if (dmg >= o.maxHp * 0.35) this.throwUnit(o, dx / kd, dy / kd, b.knockback * fall, 220 + 260 * fall);
      else this.knock(o, dx / kd, dy / kd, b.knockback * fall, 0.5);
      if (b.ignite) this.ignite(o, b.ignite);
    });
    // The bang startles horses well beyond the blast.
    this.forNear(x, y, SKITTISH_RADIUS, (o) => {
      if (o.def.skittish && Math.hypot(o.x - x, o.y - y) < SKITTISH_RADIUS) this.panic(o, x, y, 1 + this.rng() * 0.8);
    });
  }

  explodeProp(p) {
    p.alive = false;
    this.explode(p.x, p.y, p.def.blast, -1, p);
  }

  // --- Combat ------------------------------------------------------------------
  meleeHit(u, t, dist) {
    const m = u.def.melee;
    const dx = (t.x - u.x) / (dist || 1);
    const dy = (t.y - u.y) / (dist || 1);
    let dmg = m.damage * (0.85 + this.rng() * 0.3) * u.dmgMul;
    // Giants sometimes snatch up a small victim and eat it.
    if (m.eat && t.mass < m.eat.maxMass && !t.def.noStun && t.z <= 0 && this.rng() < m.eat.chance) {
      t.noCorpse = true;
      t.infected = -1;
      this.kill(t, u);
      u.hp = Math.min(u.maxHp, u.hp + m.eat.heal);
      u.attackAnim = 1;
      this.emit({ k: 'gulp', x: Math.round(t.x), y: Math.round(t.y) });
      return;
    }
    // Snakes swallow wounded prey whole.
    const sw = u.def.swallow;
    if (sw && (t.hp <= t.maxHp * sw.hpFrac || t.hp <= dmg) && t.r <= u.r * sw.sizeMul && !t.def.noStun && t.mass < 8 && t.z <= 0) {
      this.swallow(u, t);
      return;
    }
    if (m.chargeDamage) {
      const frac = Math.min(1, Math.hypot(u.vx, u.vy) / u.def.speed);
      dmg += m.chargeDamage * frac * frac;
      if (frac > 0.4) {
        if (m.throwChance && this.rng() < m.throwChance * frac) this.throwUnit(t, dx, dy, m.knockback * frac, 240);
        else this.knock(t, dx, dy, m.knockback * frac, 0.5);
      }
    }
    if (m.sweep) {
      this.sweep(u, t, dx, dy, dmg);
    } else if (m.aoe) {
      const cx = u.x + dx * (u.r + m.reach);
      const cy = u.y + dy * (u.r + m.reach);
      this.emit({ k: 'smash', x: Math.round(cx), y: Math.round(cy), r: m.aoe });
      this.forNear(cx, cy, m.aoe + MAX_RADIUS, (o) => {
        if (o.side === u.side || !o.alive || o.prop || o.z > 20) return;
        const ox = o.x - cx;
        const oy = o.y - cy;
        const d = Math.hypot(ox, oy);
        if (d > m.aoe + o.r) return;
        const fall = 1 - 0.5 * Math.min(1, d / m.aoe);
        this.damage(o, dmg * fall * this.bonus(u, o), u);
        if (!o.alive) return;
        const kd = d || 1;
        const kx = (ox / kd) * 0.6 + dx * 0.4;
        const ky = (oy / kd) * 0.6 + dy * 0.4;
        if (m.throwChance && this.rng() < m.throwChance * fall) this.throwUnit(o, kx, ky, m.knockback * fall, 260);
        else this.knock(o, kx, ky, m.knockback * fall, 0.6);
      });
    } else {
      this.damage(t, dmg * this.bonus(u, t), u);
      if (m.knockback && !m.chargeDamage && t.alive) this.knock(t, dx, dy, m.knockback, 0.3);
      if (m.infect) this.infect(u, t, m.infect);
      if (m.plague && t.alive) this.catchPlague(t, m.plague);
      if (m.pull && t.alive) this.knock(t, -dx, -dy, m.pull, 0.5);
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
    // Lead the target a little, then add spread that grows with distance and with nerves.
    let tx = t.x + t.vx * flight * 0.8;
    let ty = t.y + t.vy * flight * 0.8;
    const shaky = u.def.morale.canBreak ? 1 + Math.max(0, 0.6 - u.morale) * 2 : 1;
    const spread = rg.spread * (0.3 + 0.7 * dist / rg.range) * shaky;
    const a = this.rng() * Math.PI * 2;
    const s = Math.sqrt(this.rng()) * spread;
    tx += Math.cos(a) * s;
    ty += Math.sin(a) * s;
    const len = Math.hypot(tx - u.x, ty - u.y) || 1;
    // Arrows keep flying a bit past the aim point so they can still hit something.
    const travel = rg.lob || rg.projectile === 'bolt' ? len : len + (rg.pierce ? 160 : 40);
    const dirx = (tx - u.x) / len;
    const diry = (ty - u.y) / len;
    const dur = Math.max(0.05, travel / rg.speed);
    this.nextProjId = ((this.nextProjId || 0) % 65535) + 1;
    this.projectiles.push({
      id: this.nextProjId,
      kind: rg.lob ? PROJ.BOMB : rg.projectile === 'bullet' ? PROJ.BULLET : rg.projectile === 'bolt' ? PROJ.BOLT : PROJ.ARROW,
      side: u.side, owner: u,
      sx: u.x + dirx * u.r, sy: u.y + diry * u.r,
      ex: u.x + dirx * travel, ey: u.y + diry * travel,
      x: u.x, y: u.y, z: 0,
      t: 0, dur,
      arc: rg.lob ? 30 + len * 0.3 : 0,
      angle: Math.atan2(diry, dirx),
      damage: rg.damage, aoe: rg.aoe || 0, knockback: rg.knockback || 0,
      supp: null, pierce: rg.pierce || 0, hits: null,
      bounces: rg.bounces ? Math.floor(this.rng() * (rg.bounces + 1)) : 0,
    });
    this.stats.shots[u.side]++;
    u.attackAnim = 1;
    if (rg.pierce) this.emit({ k: 'shot', x: Math.round(u.x + dirx * u.r * 1.6), y: Math.round(u.y + diry * u.r * 1.6) });
    if (rg.lob) {
      this.emit({ k: 'lob', x: Math.round(u.x), y: Math.round(u.y) });
      this.warnDodge(u.x + dirx * travel, u.y + diry * travel, (rg.aoe || 0) + 12, dur, u.side);
    }
  }

  /** Trained units near a bomb's landing spot sidestep it, if they react in time. */
  warnDodge(x, y, radius, flight, side) {
    this.forNear(x, y, radius + MAX_RADIUS, (o) => {
      if (!o.alive || o.prop || o.side === side || o.def.iq !== 'trained' || o.stun > 0 || o.fleeing) return;
      const dx = o.x - x;
      const dy = o.y - y;
      const d = Math.hypot(dx, dy);
      if (d > radius + o.r) return;
      if (o.def.react * o.reactMul >= flight || this.rng() > 0.8) return;
      let nx = dx / (d || 1);
      let ny = dy / (d || 1);
      if (d < 1) { const a = this.rng() * TAU; nx = Math.cos(a); ny = Math.sin(a); }
      o.dodgeT = Math.min(0.7, flight);
      o.dodx = nx;
      o.dody = ny;
    });
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
      if (p.kind === PROJ.BOLT) {
        // Plasma bolt: flies straight and bursts on a wall, an enemy, or at the aim point.
        let burst = f >= 1 || this.isSolidAt(p.x, p.y);
        if (!burst) {
          this.forNear(p.x, p.y, MAX_RADIUS + 4, (o) => {
            if (!burst && o.alive && !o.prop && o.side !== p.side && o.z <= 12 && Math.hypot(o.x - p.x, o.y - p.y) < o.r + 3) burst = true;
          });
        }
        if (burst) {
          this.explode(p.x, p.y, { radius: p.aoe, damage: p.damage, knockback: p.knockback, ignite: 0 }, p.side, p.owner);
          continue;
        }
        keep.push(p);
        continue;
      }
      if (p.kind === PROJ.BOMB) {
        p.z = Math.sin(Math.PI * f) * p.arc;
        p.angle = Math.atan2(p.y - py, p.x - px);
        if (f >= 1) {
          // Grenades bounce along a little before going off (not in water; further on ice).
          const ti = this.tileIndex(p.x, p.y);
          const tt = ti >= 0 ? this.grid[ti] : 0;
          if (p.bounces > 0 && tt !== T.WATER) {
            p.bounces--;
            let dx = p.ex - p.sx;
            let dy = p.ey - p.sy;
            const dl = Math.hypot(dx, dy) || 1;
            dx /= dl;
            dy /= dl;
            const hop = (12 + this.rng() * 18) * (tt === T.ICE ? 2 : 1);
            if (this.isSolidAt(p.x + dx * hop, p.y + dy * hop)) { dx = -dx; dy = -dy; }
            p.sx = p.x; p.sy = p.y;
            p.ex = p.x + dx * hop; p.ey = p.y + dy * hop;
            p.t = 0; p.dur = 0.2; p.arc = 5;
            keep.push(p);
            continue;
          }
          this.explode(p.x, p.y, { radius: p.aoe, damage: p.damage, knockback: p.knockback, ignite: 0 }, p.side, p.owner);
          continue;
        }
        keep.push(p);
        continue;
      }
      // Arrows and bullets: blocked by walls, hit the first enemy (or enemy powder keg) they
      // touch. Fast bullets are checked along their whole path this tick and can punch
      // through several units, unless a shield stops them.
      const bullet = p.kind === PROJ.BULLET;
      const steps = bullet ? Math.max(1, Math.ceil(Math.hypot(p.x - px, p.y - py) / 5)) : 1;
      let done = false;
      for (let s = 1; s <= steps && !done; s++) {
        const qx = bullet ? px + (p.x - px) * (s / steps) : p.x;
        const qy = bullet ? py + (p.y - py) * (s / steps) : p.y;
        if (this.isSolidAt(qx, qy)) { done = true; break; }
        let hit = null;
        this.forNear(qx, qy, MAX_RADIUS + 10, (o) => {
          if (hit || (o.side === p.side && !o.def.tree) || !o.alive || o.def.mine || o.def.peel || o.def.frog || o.z > 12) return;
          if (p.hits && p.hits.includes(o.id)) return;
          const dx = o.x - qx;
          const dy = o.y - qy;
          const d2 = dx * dx + dy * dy;
          if (d2 <= (o.r + 2) * (o.r + 2)) { hit = o; return; }
          // Near misses rattle the target's nerves.
          if (!o.prop && d2 <= (o.r + 10) * (o.r + 10) && o.def.morale.canBreak) {
            if (!p.supp) p.supp = [];
            if (!p.supp.includes(o.id)) { p.supp.push(o.id); o.morale -= o.def.morale.supp; }
          }
        });
        if (!hit) continue;
        // Trees catch most shots; the rest slip past.
        if (hit.def.tree && this.rng() >= hit.def.tree.cover) { (p.hits || (p.hits = [])).push(hit.id); continue; }
        const sf = hit.prop ? 1 : this.shieldFactor(hit, p.owner);
        this.damage(hit, p.damage * (0.85 + this.rng() * 0.3) * sf, p.owner, true);
        if (!bullet || sf < 1 || --p.pierce <= 0) { done = true; break; }
        (p.hits || (p.hits = [])).push(hit.id);
      }
      if (done) continue;
      if (f < 1) keep.push(p);
    }
    this.projectiles = keep;
  }

  // --- Props ---------------------------------------------------------------------------
  stepProp(u) {
    // Hurled through the air by an ape: fly, then land with a crash.
    if (u.z > 0) {
      u.x = Math.max(u.r, Math.min(WORLD.width - u.r, u.x + u.vx * DT));
      u.y = Math.max(u.r, Math.min(WORLD.height - u.r, u.y + u.vy * DT));
      u.z += u.vz * DT;
      u.vz -= GRAVITY * DT;
      if (u.z <= 0) {
        u.z = 0;
        u.vz = u.vx = u.vy = 0;
        if (u.hurled) { u.hurled = false; this.crush(u); }
        if (u.def.blast) this.arm(u, 0.05);
      }
      return;
    }
    if (u.burn > 0) {
      u.burn -= DT;
      const tr = u.def.tree;
      if (tr) {
        // A burning tree slowly chars and sets fire to anything close.
        this.damage(u, 6 * DT, null);
        if (!u.alive) return;
        this.forNear(u.x, u.y, u.r + tr.reach + MAX_RADIUS, (o) => {
          if (o === u || !o.alive || o.burn > 0 || o.z > 0) return;
          if (Math.hypot(o.x - u.x, o.y - u.y) < u.r + o.r + tr.reach) this.ignite(o, BURN_SPREAD * DT);
        });
        const ti = this.tileIndex(u.x, u.y);
        if (ti >= 0 && TERRAIN[this.grid[ti]]?.flammable && this.rng() < DT) this.igniteTile(ti);
      }
    }
    if (u.def.frog) { this.stepFrog(u); return; }
    const pl = u.def.peel;
    if (pl) {
      let slipped = null;
      this.forNear(u.x, u.y, pl.trigger + MAX_RADIUS, (o) => {
        if (slipped || !o.alive || o.prop || o.z > 0 || o.def.noStun || o.def.hop) return;
        if (Math.hypot(o.vx, o.vy) < pl.minSpeed) return;
        if (Math.hypot(o.x - u.x, o.y - u.y) < pl.trigger + o.r) slipped = o;
      });
      if (slipped) {
        const sp = Math.hypot(slipped.vx, slipped.vy) || 1;
        this.throwUnit(slipped, slipped.vx / sp, slipped.vy / sp, 40, 170);
        this.emit({ k: 'slip', x: Math.round(u.x), y: Math.round(u.y) });
        u.alive = false;
      }
      return;
    }
    if (u.armed) {
      u.fuse -= DT;
      if (u.fuse <= 0) this.explodeProp(u);
      return;
    }
    const mn = u.def.mine;
    if (!mn) return;
    // A mine goes off under any enemy heavy enough, on the ground.
    let trip = false;
    this.forNear(u.x, u.y, mn.trigger + MAX_RADIUS, (o) => {
      if (trip || !o.alive || o.prop || o.side === u.side || o.z > 0 || o.mass < mn.minMass) return;
      if (Math.hypot(o.x - u.x, o.y - u.y) < mn.trigger + o.r) trip = true;
    });
    if (trip) this.arm(u, mn.fuse);
  }

  /** Frogs hop about, away from anyone who comes close. */
  stepFrog(u) {
    if (u.hopT > 0) {
      u.hopT -= DT;
      const nx = u.x + u.vx * DT;
      const ny = u.y + u.vy * DT;
      if (nx > 5 && ny > 5 && nx < WORLD.width - 5 && ny < WORLD.height - 5 && !this.circleBlocked(nx, ny, u.r)) { u.x = nx; u.y = ny; }
      return;
    }
    u.restT -= DT;
    if (u.restT > 0) return;
    u.restT = 0.6 + this.rng() * 1.2;
    let ax = 0;
    let ay = 0;
    this.forNear(u.x, u.y, 70, (o) => {
      if (o === u || !o.alive || o.prop) return;
      const dx = u.x - o.x;
      const dy = u.y - o.y;
      const dl = Math.hypot(dx, dy) || 1;
      if (dl < 70) { ax += dx / dl; ay += dy / dl; }
    });
    const a = ax || ay ? Math.atan2(ay, ax) + (this.rng() - 0.5) : this.rng() * TAU;
    u.vx = Math.cos(a) * 90;
    u.vy = Math.sin(a) * 90;
    u.heading = a;
    u.hopT = 0.25;
  }

  // --- Unit brains --------------------------------------------------------------
  /** Recompute morale from local odds, fear, group losses and wounds. */
  updateMorale(u) {
    const dt = this.time - u.moraleAt;
    u.moraleAt = this.time;
    const m = u.def.morale;
    let hostile = 0;
    let friend = u.def.strength;
    let nearest = null;
    let nd = ODDS_RADIUS;
    this.forNear(u.x, u.y, ODDS_RADIUS, (o) => {
      if (o === u || !o.alive || o.prop) return;
      const dx = u.x - o.x;
      const dy = u.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d > ODDS_RADIUS) return;
      let s = o.def.strength * (0.3 + 0.7 * (1 - d / ODDS_RADIUS));
      if (o.side !== u.side) {
        // Enemies charging straight in count for up to double.
        const toward = (dx * o.vx + dy * o.vy) / (d || 1);
        if (toward > 0.6 * o.def.speed) s *= 1 + Math.min(1, toward / Math.max(1, o.def.speed));
        if (o.fleeing) s *= 0.3;
        hostile += s;
        if (d < nd) { nd = d; nearest = o; }
      } else if (!o.fleeing) {
        friend += s;
      }
    });
    if (nearest) u.threat = nearest;
    else if (u.threat && (!u.threat.alive || Math.hypot(u.threat.x - u.x, u.threat.y - u.y) > 300)) u.threat = null;
    if (!m.canBreak) return;
    // Morale switched off in the lobby: everyone stays steady.
    if (!this.moraleOn) { u.morale = m.baseline * u.bravery; u.fleeing = false; return; }

    const odds = hostile / friend;
    const fear = this.fearAt(u.side, u.x, u.y);
    const cas = u.group ? u.group.dead / u.group.size : 0;
    const wound = 1 - Math.max(0, u.hp) / u.maxHp;
    const target = m.baseline * u.bravery
      - Math.max(0, odds - 1) * m.odds - fear * m.fear - cas * m.cas - wound * m.wound
      + (u.inspT > 0 ? INSPIRE_MORALE : 0);
    if (u.morale > target) u.morale = Math.max(target, u.morale - (m.drop ?? MORALE_DROP) * dt);
    else u.morale = Math.min(target, u.morale + (m.recover ?? MORALE_RECOVER) * dt);
    if (u.steadyT > 0) u.morale = Math.max(u.morale, m.brk + 0.02);
    u.morale = Math.max(0, Math.min(1, u.morale));

    if (!u.fleeing && u.morale < m.brk) this.startFlee(u);
    else if (u.fleeing && u.morale > m.rally && u.fleeT >= m.minFlee) u.fleeing = false;
  }

  /** Weighted choice between nearby enemies. */
  chooseTarget(u) {
    const d = u.def;
    const sight = u.target ? d.sight * 1.2 : d.sight;
    const nearest = this.nearestEnemy(u, sight);
    if (!nearest) return null;
    const near = Math.hypot(nearest.x - u.x, nearest.y - u.y);
    const swarm = d.targeting === 'swarm';
    const melee = d.role === 'melee';
    const ranged = d.role === 'ranged';
    const R = near + 40 + (swarm ? 110 : d.targeting === 'assassin' ? 160 : 0);
    const cand = [];
    const weight = [];
    let total = 0;
    this.forNear(u.x, u.y, R, (o) => {
      if (o.side === u.side || !o.alive || o.prop) return;
      const dist = Math.hypot(o.x - u.x, o.y - u.y);
      if (dist > R || !this.canSee(u, o, dist * dist) || !this.canTarget(u, o)) return;
      let s = 1 / ((dist + 15) * (dist + 15));
      // Spread out: an enemy already mobbed or under fire is less attractive.
      if (melee) {
        const crowd = o.meleeOn - (u.target === o ? 1 : 0);
        s /= 1 + crowd * (swarm ? 0.15 : 0.7);
        if (crowd >= 4 && !swarm) s *= 0.05;
      } else if (ranged) {
        const crowd = o.shotOn - (u.target === o ? 1 : 0);
        s /= 1 + crowd * 0.4;
        if (crowd >= 3) s *= 0.3;
      }
      if (swarm) {
        if (o.def.role !== 'melee') s *= 4;
        if (o.fleeing) s *= 3;
      }
      if (d.targeting === 'assassin') s *= o.def.role === 'melee' ? 0.5 : 6;
      if (u.leader && u.leader.target === o) s *= 3; // focus on the captain's target
      if (d.targeting === 'predator') s *= (o.fleeing ? 3 : 1) * (2 - o.hp / o.maxHp) * (o.mass < 1.5 ? 1.5 : 0.6);
      if (d.flame && o.def.flammability <= 0) s *= 0.05; // flames can't hurt it
      if (d.melee?.infect && o.infected >= 0) s *= 0.3; // already bitten
      cand.push(o);
      weight.push(s);
      total += s;
    });
    if (!cand.length) return nearest;
    let pick = cand[cand.length - 1];
    let roll = this.rng() * total;
    for (let i = 0; i < cand.length; i++) {
      roll -= weight[i];
      if (roll <= 0) { pick = cand[i]; break; }
    }
    // Sticky units keep their target unless the new one is much closer.
    const cur = u.target;
    if (d.targeting === 'sticky' && cur && cur.alive && cur !== pick) {
      const dc = Math.hypot(cur.x - u.x, cur.y - u.y);
      if (dc <= sight && Math.hypot(pick.x - u.x, pick.y - u.y) > dc * 0.6) return cur;
    }
    return pick;
  }

  think(u) {
    const d = u.def;
    if (u.target && !u.target.alive) { u.target = null; u.retarget = 0; }
    const run = d.speed * 1.25;

    // A badly hurt Shade with an enemy close vanishes in smoke and slips away.
    const sm = d.smoke;
    if (sm && !u.smoked && u.hp <= u.maxHp * sm.hp && u.threat && u.threat.alive
      && Math.hypot(u.threat.x - u.x, u.threat.y - u.y) < 140) this.dropSmoke(u);
    if (u.escapeT > 0) {
      const t = u.threat;
      let ex = Math.cos(u.heading);
      let ey = Math.sin(u.heading);
      if (t && t.alive) {
        const dl = Math.hypot(u.x - t.x, u.y - t.y) || 1;
        ex = (u.x - t.x) / dl;
        ey = (u.y - t.y) / dl;
      }
      return [ex * d.speed * 1.3, ey * d.speed * 1.3];
    }

    // Panicked horses bolt away from whatever frightened them.
    if (u.panicT > 0) {
      const dx = u.x - u.px;
      const dy = u.y - u.py;
      const dl = Math.hypot(dx, dy) || 1;
      return [dx / dl * run, dy / dl * run];
    }
    // On fire: run for water if there's any close, otherwise run around wildly.
    if (u.burn > 0) {
      if (d.iq !== 'mindless') {
        u.waterT -= DT;
        if (u.waterT <= 0) {
          u.waterT = 0.5;
          const w = this.findWater(u.x, u.y, WATER_SEARCH);
          u.waterX = w ? w[0] : -1;
          u.waterY = w ? w[1] : -1;
        }
        if (u.waterX >= 0) {
          const dx = u.waterX - u.x;
          const dy = u.waterY - u.y;
          const dl = Math.hypot(dx, dy) || 1;
          return [dx / dl * run, dy / dl * run];
        }
      }
      u.wanderT -= DT;
      if (u.wanderT <= 0) { u.wanderT = 0.3 + this.rng() * 0.5; u.wander += (this.rng() - 0.5) * 3; }
      return [Math.cos(u.wander) * run, Math.sin(u.wander) * run];
    }
    // Cornered casters blink away.
    const bl = d.blink;
    if (bl && u.blinkCd <= 0 && u.threat && u.threat.alive && (bl.always || u.fleeing || u.hp < u.maxHp * 0.5)
      && Math.hypot(u.threat.x - u.x, u.threat.y - u.y) < bl.trigger) this.tryBlink(u, u.threat.x, u.threat.y);
    // Giants run from rats.
    if (u.ratFearT > 0) {
      const dl = Math.hypot(u.x - u.ratX, u.y - u.ratY) || 1;
      return [(u.x - u.ratX) / dl * run, (u.y - u.ratY) / dl * run];
    }
    // Piranhas out of water flop back towards it.
    if (d.waterOnly && !u.inWater && u.z <= 0) {
      const w = this.findWater(u.x, u.y, 40);
      if (w) return this.moveTo(u, w[0], w[1], 30);
      u.wanderT -= DT;
      if (u.wanderT <= 0) { u.wanderT = 0.3; u.wander = this.rng() * TAU; }
      return [Math.cos(u.wander) * 20, Math.sin(u.wander) * 20];
    }
    // Sidestepping an incoming bomb.
    if (u.dodgeT > 0) return [u.dodx * run, u.dody * run];
    if (u.fleeing) return this.flee(u);
    // Boars graze until an enemy comes close or they get hurt.
    if (!u.alert) {
      if (this.nearestEnemy(u, d.provoke.radius)) this.alertHerd(u);
      else {
        u.wanderT -= DT;
        if (u.wanderT <= 0) { u.wanderT = 1 + this.rng() * 2; u.wander = this.rng() * TAU; u.grazing = this.rng() < 0.5; }
        return u.grazing ? [0, 0] : [Math.cos(u.wander) * 14, Math.sin(u.wander) * 14];
      }
    }
    if (d.hex) this.tryHex(u);

    u.retarget -= DT;
    if (u.retarget <= 0) {
      u.retarget = 0.25 + this.rng() * 0.15;
      const prev = u.target;
      u.target = this.chooseTarget(u);
      u.los = u.target ? this.lineOfSight(u.x, u.y, u.target.x, u.target.y) : false;
      // A newly spotted enemy takes a moment to react to; switching targets is quicker.
      if (u.target && u.target !== prev) u.reactT = d.react * u.reactMul * (prev ? 0.4 : 1);
    }
    // Ants guard their hill: they only chase enemies near it, or ones right next to them.
    const home = u.home;
    if (home && home.alive && u.target) {
      const t = u.target;
      if (Math.hypot(t.x - home.x, t.y - home.y) > home.def.nest.guard && Math.hypot(t.x - u.x, t.y - u.y) > 40) u.target = null;
    }
    // Gators don't stray far from their pond.
    if (d.aquatic?.leash && u.homeX >= 0 && u.target
      && Math.hypot(u.target.x - u.homeX, u.target.y - u.homeY) > d.aquatic.leash) u.target = null;
    let v;
    if (d.role === 'nest') return this.thinkNest(u);
    if (d.role === 'raiser') return this.avoidMines(u, this.thinkRaiser(u));
    if (d.flight) v = this.thinkDragon(u);
    else if (d.pounce) v = this.thinkCheetah(u);
    else if (d.role === 'healer') v = this.thinkHealer(u);
    else if (d.hop) v = this.thinkHop(u);
    else if (d.flame) v = this.thinkFlame(u);
    else if (d.role === 'ranged') v = this.thinkRanged(u);
    else v = this.thinkMelee(u);
    return this.avoidMines(u, v);
  }

  /** Routed units run away from the enemy, using the flow field to get round walls. */
  flee(u) {
    const d = u.def;
    const sp = d.speed * 1.15;
    let vx = 0;
    let vy = 0;
    const t = u.threat;
    if (t && t.alive) {
      const dx = u.x - t.x;
      const dy = u.y - t.y;
      const dl = Math.hypot(dx, dy) || 1;
      vx += (dx / dl) * 0.7;
      vy += (dy / dl) * 0.7;
    }
    const e = this.escapeDir(u);
    if (e) { vx += e[0]; vy += e[1]; }
    const l = Math.hypot(vx, vy);
    if (l < 0.01) return [0, 0];
    return [vx / l * sp, vy / l * sp];
  }

  /** Trained units hear an armed mine beep and step away from it. */
  avoidMines(u, v) {
    if (u.def.iq !== 'trained') return v;
    let ax = 0;
    let ay = 0;
    this.forNear(u.x, u.y, 50, (o) => {
      if (!o.alive || !o.def.mine || !o.armed) return;
      const dx = u.x - o.x;
      const dy = u.y - o.y;
      const dl = Math.hypot(dx, dy) || 1;
      const lim = 30 + u.r;
      if (dl < lim) { ax += (dx / dl) * (1 - dl / lim); ay += (dy / dl) * (1 - dl / lim); }
    });
    if (!ax && !ay) return v;
    const sp = u.def.speed * 1.3;
    return [v[0] * 0.3 + ax * sp, v[1] * 0.3 + ay * sp];
  }

  advance(u, speed) {
    const t = u.target;
    // Troops with nothing to fight stay with their captain.
    if (!t && u.leader && u.leader.alive && Math.hypot(u.leader.x - u.x, u.leader.y - u.y) > 60) {
      return this.moveTo(u, u.leader.x, u.leader.y, speed);
    }
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
    if (!t) {
      if (u.home && u.home.alive) return this.mill(u, u.home.x, u.home.y, u.home.r + 30);
      if (d.waterOnly) return this.mill(u, u.x, u.y, 40);
      if (d.aquatic?.leash && u.homeX >= 0) return u.inWater ? this.mill(u, u.x, u.y, 30, 0.3) : this.moveTo(u, u.homeX, u.homeY, d.speed);
      return this.advance(u, d.speed);
    }
    const dist = Math.hypot(t.x - u.x, t.y - u.y);
    const contact = u.r + t.r + d.melee.reach;
    // Apes hurl kegs and enemies at targets that are out of reach, and beat their chests.
    if (d.hurl && u.hurlCd <= 0 && dist >= d.hurl.min && dist <= d.hurl.max && u.los
      && (!u.threat || Math.hypot(u.threat.x - u.x, u.threat.y - u.y) > 60) && this.tryHurl(u, t)) return [0, 0];
    if (d.beat && u.beatCd <= 0 && dist < 260 && dist > contact + 20) this.beatChest(u);
    // Dash strike: cover the gap in a blink, slashing through whoever is in the way.
    const ds = d.dash;
    if (ds && u.dashCd <= 0 && u.los && u.reactT <= 0 && !u.inWater && t.z <= 20
      && dist >= ds.min + u.r + t.r && dist <= ds.max && this.startDash(u, t, dist)) return [u.dashVx, u.dashVy];
    // Legionaries rush in when the enemy is close; ghouls lunge.
    let speed = d.speed;
    if (d.rush && dist < d.rush.dist) speed *= d.rush.mul;
    else if (d.sprint && dist < d.sprint.dist) speed = d.sprint.speed;
    if (dist <= contact && u.los) {
      this.face(u, t.x, t.y);
      if (u.cd <= 0 && u.reactT <= 0 && t.z <= 20) {
        this.meleeHit(u, t, dist);
        u.cd = d.melee.cooldown * (0.9 + this.rng() * 0.2) * (u.rageT > 0 ? d.rage.rate : 1);
      }
      // Riders keep pushing through; everyone else holds position.
      if (d.melee.chargeDamage) return this.advance(u, d.speed * 0.6);
      return [0, 0];
    }
    return this.advance(u, speed);
  }

  mill(u, cx, cy, R, frac = 0.4) {
    u.wanderT -= DT;
    if (u.wanderT <= 0 || u.millX === undefined) {
      u.wanderT = 1 + this.rng() * 1.5;
      const a = this.rng() * TAU;
      const rr = this.rng() * R;
      u.millX = cx + Math.cos(a) * rr;
      u.millY = cy + Math.sin(a) * rr;
    }
    return this.moveTo(u, u.millX, u.millY, u.def.speed * frac);
  }

  moveTo(u, x, y, sp) {
    const dx = x - u.x;
    const dy = y - u.y;
    const dl = Math.hypot(dx, dy);
    if (dl < 4) return [0, 0];
    return [dx / dl * sp, dy / dl * sp];
  }

  /** Anthills don't move; they hatch a new ant every few seconds, up to a limit. */
  thinkNest(u) {
    const n = u.def.nest;
    u.spawnT -= DT;
    if (!u.brood) u.brood = [];
    if (u.spawnT <= 0) {
      u.spawnT = n.every * (0.85 + this.rng() * 0.3);
      u.brood = u.brood.filter((a) => a.alive);
      if (u.brood.length < n.max) {
        const a0 = this.rng() * TAU;
        const ant = this.spawn(UNIT_INDEX[n.spawn], u.side, u.x + Math.cos(a0) * (u.r + 4), u.y + Math.sin(a0) * (u.r + 4));
        ant.home = u;
        u.brood.push(ant);
      }
    }
    return [0, 0];
  }

  /** Cheetahs sprint in, pin their prey and maul it, then back off before striking again. */
  thinkCheetah(u) {
    const d = u.def;
    const p = d.pounce;
    if (u.retreatT > 0) {
      const f = u.maulTarget && u.maulTarget.alive ? u.maulTarget : u.threat;
      if (!f || !f.alive) return [0, 0];
      const dl = Math.hypot(u.x - f.x, u.y - f.y) || 1;
      return [(u.x - f.x) / dl * 150, (u.y - f.y) / dl * 150];
    }
    if (u.maulT > 0) {
      const m = u.maulTarget;
      if (!m || !m.alive) { u.maulT = 0; u.retreatT = p.retreat; return [0, 0]; }
      m.stun = Math.max(m.stun, 0.35);
      this.face(u, m.x, m.y);
      u.maulHitT -= DT;
      if (u.maulHitT <= 0) {
        u.maulHitT = p.every;
        this.damage(m, p.damage * (0.85 + this.rng() * 0.3), u);
        u.attackAnim = 1;
      }
      u.maulT -= DT;
      if (u.maulT <= 0) u.retreatT = p.retreat;
      const dl = Math.hypot(m.x - u.x, m.y - u.y) || 1;
      return dl > u.r + m.r + 2 ? [(m.x - u.x) / dl * 120, (m.y - u.y) / dl * 120] : [0, 0];
    }
    const t = u.target;
    if (!t) return this.advance(u, d.speed);
    const dist = Math.hypot(t.x - u.x, t.y - u.y);
    const contact = u.r + t.r + d.melee.reach;
    if (u.sprintT > 0 || (u.sprintCd <= 0 && u.los && u.reactT <= 0 && dist < p.range * (t.fleeing ? 1.35 : 1))) {
      if (u.sprintT <= 0) u.sprintT = p.time;
      u.sprintT -= DT;
      if (u.sprintT <= 0) u.sprintCd = p.cooldown;
      if (dist <= contact + 4) {
        u.sprintT = 0;
        u.sprintCd = p.cooldown;
        if (t.mass >= 3 || t.def.noStun) {
          this.damage(t, 20, u);
          u.retreatT = p.retreat * 0.6;
        } else {
          this.damage(t, p.damage * 1.5, u);
          if (t.alive) {
            u.maulT = p.hits * p.every;
            u.maulHitT = p.every;
            u.maulTarget = t;
            t.stun = Math.max(t.stun, p.pin);
          } else u.retreatT = p.retreat * 0.5;
        }
        u.attackAnim = 1;
        this.emit({ k: 'pounce', x: Math.round(t.x), y: Math.round(t.y) });
        return [0, 0];
      }
      const lead = dist / p.speed;
      const tx = t.x + t.vx * lead;
      const ty = t.y + t.vy * lead;
      const dl = Math.hypot(tx - u.x, ty - u.y) || 1;
      return [(tx - u.x) / dl * p.speed, (ty - u.y) / dl * p.speed];
    }
    if (dist <= contact && u.los) {
      this.face(u, t.x, t.y);
      if (u.cd <= 0 && u.reactT <= 0 && t.z <= 20) {
        this.meleeHit(u, t, dist);
        u.cd = d.melee.cooldown * (0.9 + this.rng() * 0.2);
      }
      return [0, 0];
    }
    return this.advance(u, d.speed);
  }

  /** Dragons roar, breathe fire, bite, and take to the air to reach targets they can't walk to. */
  thinkDragon(u) {
    const d = u.def;
    const fl = d.flight;
    if (u.roarCd <= 0) {
      if (this.nearestEnemy(u, d.roar.radius) || this.time < 0.5) this.roar(u);
      else u.roarCd = 0.5;
    }
    if (u.flying) {
      if (u.breathT > 0) { u.breathT -= DT; this.sprayFlame(u, u.heading, d.breath); }
      const dx = u.flyTX - u.x;
      const dy = u.flyTY - u.y;
      const dl = Math.hypot(dx, dy);
      if (dl < 14) { u.flying = false; u.landShock = true; return [0, 0]; }
      return [dx / dl * fl.speed, dy / dl * fl.speed];
    }
    const t = u.target;
    if (!t) return this.advance(u, d.speed);
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    const dist = Math.hypot(dx, dy) || 1;
    const contact = u.r + t.r + d.melee.reach;
    if (u.flyCd <= 0 && u.z <= 0) {
      let crowd = 0;
      this.forNear(u.x, u.y, u.r * 1.9 + MAX_RADIUS, (o) => {
        if (o.alive && !o.prop && o.side !== u.side && Math.hypot(o.x - u.x, o.y - u.y) < u.r * 1.9 + o.r) crowd++;
      });
      if (crowd >= 7) {
        const th = u.threat || t;
        const al = Math.hypot(u.x - th.x, u.y - th.y) || 1;
        this.takeOff(u, u.x + (u.x - th.x) / al * 180, u.y + (u.y - th.y) / al * 180);
      } else if (!u.los || t.inWater || dist > 260 || u.stuck > 0.5) {
        const past = this.rng() < 0.5 ? 60 : -(u.r + t.r + 10);
        this.takeOff(u, t.x + dx / dist * past, t.y + dy / dist * past);
      }
      if (u.flying) return [0, 0];
    }
    if (u.breathT > 0) {
      u.breathT -= DT;
      this.face(u, t.x, t.y);
      this.sprayFlame(u, Math.atan2(dy, dx), d.breath);
    } else if (u.breathCd <= 0 && u.los && dist < d.breath.range && u.reactT <= 0) {
      u.breathT = d.breath.time;
      u.breathCd = d.breath.cooldown * (0.85 + this.rng() * 0.3);
    }
    if (dist <= contact && u.los) {
      this.face(u, t.x, t.y);
      if (u.cd <= 0 && u.reactT <= 0 && t.z <= 20) {
        this.meleeHit(u, t, dist);
        u.cd = d.melee.cooldown * (0.9 + this.rng() * 0.2);
      }
      return [0, 0];
    }
    return this.advance(u, d.speed);
  }

  takeOff(u, x, y) {
    const m = u.r + 6;
    u.flying = true;
    u.z = Math.max(u.z, 1);
    u.vz = 0;
    u.flyTX = Math.max(m, Math.min(WORLD.width - m, x));
    u.flyTY = Math.max(m, Math.min(WORLD.height - m, y));
    u.flyCd = u.def.flight.cooldown * (0.85 + this.rng() * 0.3);
    u.breathT = Math.max(u.breathT, 1.2);
    this.emit({ k: 'takeoff', x: Math.round(u.x), y: Math.round(u.y), r: Math.round(u.r) });
  }

  /** Necromancers keep out of the fight, then raise the dead wherever it's safe. */
  thinkRaiser(u) {
    const d = u.def;
    const rz = d.raise;
    if (u.castT > 0) {
      if (!this.anyEnemyNear(u.side, u.x, u.y, rz.interrupt)) return [0, 0];
      u.castT = 0;
      u.castKind = null;
    }
    const e = this.nearestEnemy(u, 160);
    if (e) {
      const dl = Math.hypot(u.x - e.x, u.y - e.y) || 1;
      return [(u.x - e.x) / dl * d.speed, (u.y - e.y) / dl * d.speed];
    }
    u.retargetHeal = (u.retargetHeal || 0) - DT;
    if (u.retargetHeal <= 0) {
      u.retargetHeal = 0.5;
      let best = null;
      let bd = 420;
      for (const c of this.corpses) {
        const dd = Math.hypot(c.x - u.x, c.y - u.y);
        if (dd >= bd || this.anyEnemyNear(u.side, c.x, c.y, rz.interrupt)) continue;
        bd = dd;
        best = c;
      }
      u.corpse = best;
      if (!best) {
        let buddy = null;
        let bb = 500 * 500;
        this.forNear(u.x, u.y, 500, (o) => {
          if (o === u || o.side !== u.side || !o.alive || o.prop || o.def.role === 'raiser' || o.def.role === 'nest') return;
          const dd = (o.x - u.x) ** 2 + (o.y - u.y) ** 2;
          if (dd < bb) { bb = dd; buddy = o; }
        });
        u.buddy = buddy;
      }
    }
    const c = u.corpse;
    if (c && this.corpses.includes(c)) {
      if (Math.hypot(c.x - u.x, c.y - u.y) < rz.radius * 0.5) {
        u.castT = rz.cast;
        u.castKind = 'raise';
        this.emit({ k: 'cast', x: Math.round(u.x), y: Math.round(u.y) });
        return [0, 0];
      }
      return this.moveTo(u, c.x, c.y, d.speed);
    }
    const b = u.buddy;
    if (b && b.alive && Math.hypot(b.x - u.x, b.y - u.y) > 70) return this.moveTo(u, b.x, b.y, d.speed);
    return [0, 0];
  }

  startDash(u, t, dist) {
    const ds = u.def.dash;
    const dx = (t.x - u.x) / dist;
    const dy = (t.y - u.y) / dist;
    const len = dist + ds.past;
    if (!this.lineOfSight(u.x, u.y, u.x + dx * len, u.y + dy * len)) return false;
    u.dashT = ds.time;
    u.dashVx = (dx * len) / ds.time;
    u.dashVy = (dy * len) / ds.time;
    u.dashCd = ds.cooldown * (0.85 + this.rng() * 0.3);
    u.dashHit = [];
    u.attackAnim = 1;
    this.emit({ k: 'dash', x: Math.round(u.x), y: Math.round(u.y), x1: Math.round(u.x + dx * len), y1: Math.round(u.y + dy * len) });
    return true;
  }

  dashSlash(u) {
    const ds = u.def.dash;
    if (u.dashHit.length >= ds.hits) return;
    const sp = Math.hypot(u.dashVx, u.dashVy) || 1;
    this.forNear(u.x, u.y, u.r + MAX_RADIUS + 4, (o) => {
      if (u.dashHit.length >= ds.hits || !o.alive || o.prop || o.side === u.side || o.z > 20) return;
      if (u.dashHit.includes(o.id) || Math.hypot(o.x - u.x, o.y - u.y) > u.r + o.r + 4) return;
      u.dashHit.push(o.id);
      this.damage(o, ds.damage * (0.85 + this.rng() * 0.3), u);
      if (o.alive) this.knock(o, u.dashVy / sp, -u.dashVx / sp, 70, 0.25);
    });
  }

  dropSmoke(u) {
    const sm = u.def.smoke;
    u.smoked = true;
    this.smokes.push({ x: u.x, y: u.y, r: sm.radius, t: sm.time });
    this.emit({ k: 'smoke', x: Math.round(u.x), y: Math.round(u.y), r: sm.radius, d: sm.time });
    u.target = null;
    u.retarget = sm.escape;
    u.escapeT = sm.escape;
  }

  /** Oozes only move by hopping. Each landing shoves enemies away and slams one of them. */
  thinkHop(u) {
    const h = u.def.hop;
    if (u.z > 0) return [u.vx, u.vy];
    u.restT -= DT;
    if (u.restT > 0) return [0, 0];
    const t = u.target;
    let dx = 0;
    let dy = 0;
    let dist = h.dist;
    if (t && u.los) {
      const td = Math.hypot(t.x - u.x, t.y - u.y) || 1;
      dx = (t.x - u.x) / td;
      dy = (t.y - u.y) / td;
      dist = Math.min(h.dist, Math.max(8, td - u.r - t.r + 2));
    } else if (this.flowDir(u)) {
      dx = u.fdx;
      dy = u.fdy;
    } else return [0, 0];
    const sp = dist / h.air;
    u.vx = dx * sp;
    u.vy = dy * sp;
    u.z = 0.5;
    u.vz = (GRAVITY * h.air) / 2;
    u.hopping = true;
    u.restT = h.rest * (0.8 + this.rng() * 0.6);
    return [u.vx, u.vy];
  }

  hopLand(u) {
    const h = u.def.hop;
    this.emit({ k: 'splat', x: Math.round(u.x), y: Math.round(u.y), r: Math.round(u.r), s: u.side });
    const R = u.r * h.pushR;
    let best = null;
    let bestGap = 6;
    this.forNear(u.x, u.y, R + MAX_RADIUS, (o) => {
      if (!o.alive || o.prop || o.side === u.side || o.z > 0) return;
      const dx = o.x - u.x;
      const dy = o.y - u.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > R + o.r) return;
      const f = 1 - Math.min(1, d / (R + o.r)) * 0.7;
      this.knock(o, dx / d, dy / d, h.push * f, 0.3 * f);
      const gap = d - u.r - o.r;
      if (gap < bestGap) { bestGap = gap; best = o; }
    });
    if (best) {
      this.damage(best, h.slam * (0.85 + this.rng() * 0.3), u);
      u.attackAnim = 1;
    }
  }

  /** Firebrands close in and hose the target with flame until the tank runs dry. */
  thinkFlame(u) {
    const d = u.def;
    const fl = d.flame;
    const t = u.target;
    if (!t) return this.advance(u, d.speed);
    const dist = Math.hypot(t.x - u.x, t.y - u.y);
    if (dist > (fl.range + t.r) * 0.85 || !u.los) return this.advance(u, d.speed);
    this.face(u, t.x, t.y);
    if (!u.inWater && u.reloadT <= 0 && u.reactT <= 0) this.sprayFlame(u, Math.atan2(t.y - u.y, t.x - u.x));
    return [0, 0];
  }

  sprayFlame(u, a0, fl = u.def.flame) {
    u.spray = true;
    if (fl.fuel) {
      u.fuel -= DT;
      if (u.fuel <= 0) { u.fuel = 0; u.reloadT = fl.reload; }
    }
    this.forNear(u.x, u.y, fl.range + MAX_RADIUS, (o) => {
      if (!o.alive || o === u || o.z > 20 || o.def.flammability <= 0) return;
      if (o.prop ? !(o.def.blast || o.def.tree) : o.side === u.side) return; // enemies, kegs and trees
      const ox = o.x - u.x;
      const oy = o.y - u.y;
      const dd = Math.hypot(ox, oy) || 1;
      if (dd > fl.range + o.r) return;
      let da = Math.atan2(oy, ox) - a0;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) > fl.arc + Math.atan2(o.r, dd)) return;
      if (u.z <= 20 && !this.lineOfSight(u.x, u.y, o.x, o.y)) return;
      if (!o.prop) this.damage(o, fl.dps * DT, u);
      this.ignite(o, fl.ignite * DT);
    });
    // The flames also lick the ground: brambles catch, ice melts, water steams.
    for (let k = 0; k < 2; k++) {
      const r = fl.range * Math.sqrt(this.rng());
      const a = a0 + (this.rng() * 2 - 1) * fl.arc;
      const x = u.x + Math.cos(a) * r;
      const y = u.y + Math.sin(a) * r;
      const i = this.tileIndex(x, y);
      if (i < 0 || this.solid[i]) continue;
      const g = this.grid[i];
      if (g === T.ICE) this.damageIce(i, 0.08);
      else if (TERRAIN[g]?.flammable && this.rng() < 0.12 && this.lineOfSight(u.x, u.y, x, y)) this.igniteTile(i);
      else if (g === T.WATER && this.rng() < 0.04) this.emit({ k: 'steam', x: Math.round(x), y: Math.round(y) });
    }
  }

  /** Chain lightning: hits the target, then jumps to the nearest unit in reach, weaker each time. */
  zap(u, t) {
    const z = u.def.ranged.zap;
    let dmg = u.def.ranged.damage;
    const struck = new Set([t.id]);
    const pts = [Math.round(u.x), Math.round(u.y), Math.round(t.x), Math.round(t.y)];
    let wet = t.inWater ? t : null;
    let cur = t;
    this.zapHit(u, t, dmg);
    for (let j = 0; j < z.jumps; j++) {
      dmg *= z.falloff;
      let best = null;
      let bd = Infinity;
      this.forNear(cur.x, cur.y, z.jumpRange * 2 + MAX_RADIUS, (o) => {
        if (!o.alive || o.prop || o === u || struck.has(o.id)) return;
        // Metal-clad troops draw the lightning further, whichever side they're on.
        const c = o.def.conduct || 1;
        if (c < 1.5 && o.side === u.side) return;
        const dd = Math.hypot(o.x - cur.x, o.y - cur.y) - o.r;
        if (dd > z.jumpRange * c || dd >= bd) return;
        bd = dd;
        best = o;
      });
      if (!best) break;
      struck.add(best.id);
      pts.push(Math.round(best.x), Math.round(best.y));
      if (!wet && best.inWater) wet = best;
      cur = best;
      this.zapHit(u, best, dmg);
    }
    this.emit({ k: 'zap', p: pts });
    this.stats.shots[u.side]++;
    if (wet) this.shockPond(u, wet);
  }

  zapHit(u, o, dmg) {
    const z = u.def.ranged.zap;
    this.damage(o, dmg * (0.85 + this.rng() * 0.3), u, true);
    if (!o.alive) return;
    this.knock(o, 0, 0, 0, z.stun);
    this.ignite(o, z.ignite);
  }

  /** Lightning striking water electrifies every unit standing in the same pond. */
  shockPond(u, wet) {
    const z = u.def.ranged.zap;
    const start = this.tileIndex(wet.x, wet.y);
    if (start < 0 || this.grid[start] !== T.WATER) return;
    const mark = this.pondMark || (this.pondMark = new Uint8Array(COLS * ROWS));
    mark.fill(0);
    mark[start] = 1;
    const tiles = [start];
    for (let n = 0; n < tiles.length && tiles.length < POND_MAX; n++) {
      const i = tiles[n];
      const c = i % COLS;
      const r = (i / COLS) | 0;
      for (const [dc, dr] of NEIGH4) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
        const j = nr * COLS + nc;
        if (!mark[j] && this.grid[j] === T.WATER) { mark[j] = 1; tiles.push(j); }
      }
    }
    for (const o of this.units) {
      if (!o.alive || o.prop || !o.inWater || o.z > 0) continue;
      const i = this.tileIndex(o.x, o.y);
      if (i < 0 || !mark[i]) continue;
      const dd = Math.hypot(o.x - wet.x, o.y - wet.y);
      this.damage(o, z.pond * Math.max(0.35, 1 - dd / 300), u, true);
      if (o.alive) this.knock(o, 0, 0, 0, z.pondStun);
    }
    const sample = [];
    for (let k = 0; k < Math.min(30, tiles.length); k++) sample.push(tiles[(this.rng() * tiles.length) | 0]);
    this.emit({ k: 'pond', t: sample });
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
      // Marksmen hold their ground against a target they can see but not yet reach.
      if (!(rg.hold && u.los && !u.inWater && !tooClose)) [vx, vy] = this.advance(u, d.speed);
    }
    if (!canShoot) u.aiming = false;
    if (canShoot) {
      this.face(u, t.x, t.y);
      if (u.cd <= 0 && u.reactT <= 0 && u.castKind !== 'hex') {
        if (rg.aim) {
          // Steady the aim first; moving spoils it.
          const prevT = u.aimTarget;
          const turned = prevT && prevT !== t && prevT.alive
            ? Math.abs(Math.atan2(Math.sin(Math.atan2(t.y - u.y, t.x - u.x) - Math.atan2(prevT.y - u.y, prevT.x - u.x)), Math.cos(Math.atan2(t.y - u.y, t.x - u.x) - Math.atan2(prevT.y - u.y, prevT.x - u.x)))) > 0.25
            : prevT !== t;
          u.aimTarget = t;
          if (!u.aiming || turned) { u.aiming = true; u.aimT = rg.aim; }
          else if (Math.hypot(u.vx, u.vy) < 12) u.aimT -= DT;
          if (u.aimT <= 0) {
            u.aiming = false;
            this.fire(u, t);
            u.cd = rg.cooldown * (0.85 + this.rng() * 0.3);
          }
        } else if (rg.zap) {
          if (u.castT <= 0) {
            u.castT = rg.zap.cast;
            u.castKind = 'zap';
            u.castTarget = t;
            this.emit({ k: 'cast', x: Math.round(u.x), y: Math.round(u.y) });
          }
        } else if (!rg.safe || this.safeToThrow(u, t, rg.safe)) {
          this.fire(u, t);
          u.cd = rg.cooldown * (0.85 + this.rng() * 0.3);
          if (rg.mag && --u.ammo <= 0) { u.ammo = rg.mag; u.cd = rg.reload * (0.9 + this.rng() * 0.25); }
        } else u.cd = 0.3;
      }
    }
    return [vx, vy];
  }

  thinkHealer(u) {
    const d = u.def;
    const h = d.heal;
    u.retargetHeal = (u.retargetHeal || 0) - DT;
    const p0 = u.patient;
    if (u.retargetHeal <= 0 || (p0 && (!p0.alive || (p0.hp >= p0.maxHp && p0.burn <= 0 && !p0.fleeing && p0.infected < 0)))) {
      u.retargetHeal = 0.4 + this.rng() * 0.2;
      let best = null;
      let bestScore = Infinity;
      this.forNear(u.x, u.y, h.search, (o) => {
        if (o === u || o.side !== u.side || !o.alive || o.prop) return;
        // Burning allies come first, then the badly hurt, then anyone shaken.
        const needs = o.burn > 0 || o.infected >= 0 || o.hp < o.maxHp * 0.95 || (o.fleeing && o.def.morale.canBreak);
        if (!needs) return;
        const dd = Math.hypot(o.x - u.x, o.y - u.y);
        if (dd > h.search) return;
        const score = (o.hp / o.maxHp) * 200 + dd - (o.burn > 0 ? 300 : 0) - (o.infected >= 0 ? 250 : 0);
        if (score < bestScore) { bestScore = score; best = o; }
      });
      u.patient = best;
      if (!best) {
        // Nobody hurt: tag along behind the nearest friendly fighter.
        let buddy = null;
        let bd = 500 * 500;
        this.forNear(u.x, u.y, 500, (o) => {
          if (o === u || o.side !== u.side || !o.alive || o.prop || o.def.role === 'healer') return;
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
          this.extinguish(p, false);
          p.infected = -1; // medics cure a ghoul bite
          if (p.def.morale.canBreak) p.morale = Math.min(1, p.morale + h.morale);
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

    // Who is already attacking whom, so target choice can spread out.
    for (const u of this.units) { u.meleeOn = 0; u.shotOn = 0; }
    for (const u of this.units) {
      const t = u.target;
      if (!u.alive || !t || u.fleeing) continue;
      if (u.def.role === 'melee') t.meleeOn++;
      else if (u.def.role === 'ranged') t.shotOn++;
    }

    this.stepTiles();
    if (this.smokes.length) {
      for (const s of this.smokes) s.t -= DT;
      this.smokes = this.smokes.filter((s) => s.t > 0);
    }
    if (this.corpses.length && this.corpses[0].t < this.time - CORPSE_TIME) {
      this.corpses = this.corpses.filter((c) => c.t >= this.time - CORPSE_TIME);
    }

    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.prop) { this.stepProp(u); continue; }
      this.stepUnit(u);
    }

    this.separate();
    this.stepProjectiles();
    this.decayFear();
    this.units = this.units.filter((u) => u.alive);
    this.checkEnd();
  }

  stepUnit(u) {
    const d = u.def;
    u.cd -= DT;
    if (u.healCd > 0) u.healCd -= DT;
    if (u.hurt > 0) u.hurt -= DT;
    if (u.reactT > 0) u.reactT -= DT;
    if (u.dodgeT > 0) u.dodgeT -= DT;
    if (u.panicT > 0) u.panicT -= DT;
    if (u.steadyT > 0) u.steadyT -= DT;
    if (u.dashCd > 0) u.dashCd -= DT;
    if (u.escapeT > 0) u.escapeT -= DT;
    if (u.reloadT > 0) { u.reloadT -= DT; if (u.reloadT <= 0) u.fuel = d.flame.fuel; }
    if (u.hexCd > 0) u.hexCd -= DT;
    if (u.blinkCd > 0) u.blinkCd -= DT;
    if (u.sprintCd > 0) u.sprintCd -= DT;
    if (u.retreatT > 0) u.retreatT -= DT;
    if (u.breathCd > 0) u.breathCd -= DT;
    if (u.roarCd > 0) u.roarCd -= DT;
    if (u.flyCd > 0) u.flyCd -= DT;
    if (u.hurlCd > 0) u.hurlCd -= DT;
    if (u.beatCd > 0) u.beatCd -= DT;
    if (u.ratFearT > 0) u.ratFearT -= DT;
    if (u.rageT > 0) { u.rageT -= DT; u.morale = Math.max(u.morale, 0.6); }
    if (u.inspT > 0) { u.inspT -= DT; if (u.inspT <= 0) u.leader = null; }
    if (u.abilCd > 0) u.abilCd -= DT;
    u.spray = false;
    if (u.attackAnim > 0) u.attackAnim = Math.max(0, u.attackAnim - DT / 0.3);
    u.faceAngle = null;
    // A Stormcaller's spell goes off at the end of its cast, unless it was knocked out of it.
    if (u.castT > 0) {
      u.castT -= DT;
      u.attackAnim = Math.max(u.attackAnim, 0.6);
      if (u.stun > 0) { u.castT = 0; u.castTarget = null; }
      else if (u.castT <= 0) {
        const ct = u.castTarget;
        const kind = u.castKind;
        u.castTarget = null;
        u.castKind = null;
        const cd = ct && ct.alive ? Math.hypot(ct.x - u.x, ct.y - u.y) : Infinity;
        if (kind === 'raise') this.raise(u);
        else if (kind === 'hex' && cd <= d.hex.range * 1.3) this.hex(u, ct);
        else if (kind === 'zap' && cd <= d.ranged.range * 1.2) {
          this.zap(u, ct);
          u.cd = d.ranged.cooldown * (0.85 + this.rng() * 0.3);
        }
      }
    }

    // Airborne: thrown units fly, then land hard.
    // Flying dragons hold their altitude; everything else in the air falls.
    if (u.flying) u.z += (d.flight.alt - u.z) * Math.min(1, 3 * DT);
    const air = u.z > 0 && !u.flying;
    if (air) {
      u.z += u.vz * DT;
      u.vz -= GRAVITY * DT;
      if (u.z <= 0) {
        const impact = Math.abs(u.vz);
        u.z = 0;
        u.vz = 0;
        if (this.circleBlocked(u.x, u.y, u.r)) this.unstick(u);
        if (u.landShock) {
          u.landShock = false;
          this.landShockwave(u);
        } else if (u.hopping) {
          u.hopping = false;
          this.hopLand(u);
        } else if (u.hurled) {
          u.hurled = false;
          this.crush(u);
          this.damage(u, 15, null);
        } else {
          this.emit({ k: 'land', x: Math.round(u.x), y: Math.round(u.y), r: Math.round(u.r) });
          if (impact > 150) this.damage(u, (impact - 150) * 0.03, null);
        }
        if (!u.alive) return;
      }
    }

    const ti = this.tileIndex(u.x, u.y);
    const tid = ti >= 0 ? this.grid[ti] : 0;
    const terr = TERRAIN[tid];
    let speedMul = 1;
    let grip = 1;
    u.inWater = false;
    if (u.z <= 0) {
      u.inWater = tid === T.WATER;
      if (terr && !terr.solid) speedMul = terr.speed;
      if (u.inWater && d.wade) speedMul = Math.max(speedMul, d.wade);
      if (u.inWater && d.aquatic) speedMul = d.aquatic.swim;
      if (d.waterOnly && !u.inWater) this.damage(u, (u.maxHp / 7) * DT, null); // gasping
      if (!u.alive) return;
      if (terr && terr.dps) this.damage(u, terr.dps * DT, null);
      if (!u.alive) return;
      if (u.inWater) this.extinguish(u, true);
      else if (this.tileBurn[ti] > 0) this.ignite(u, TILE_IGNITE * DT);
      if (tid === T.ICE) grip = d.iceGrip;
    }

    // Burning: hurts, terrifies, spreads to anyone touching and to the ground.
    if (u.burn > 0) {
      u.burn -= DT;
      this.damage(u, BURN_DPS * DT, null);
      if (!u.alive) return;
      if (d.morale.canBreak) {
        u.morale = Math.max(0, u.morale - BURN_MORALE * DT);
        if (u.morale < d.morale.brk) this.startFlee(u);
      }
      this.forNear(u.x, u.y, u.r + MAX_RADIUS + 3, (o) => {
        if (o === u || !o.alive || o.burn > 0 || o.z > 0) return;
        if (Math.hypot(o.x - u.x, o.y - u.y) < u.r + o.r + 3) this.ignite(o, BURN_SPREAD * DT);
      });
      if (!air && ti >= 0) {
        if (terr?.flammable && this.rng() < 1.5 * DT) this.igniteTile(ti);
        if (tid === T.ICE) this.damageIce(ti, 0.6 * DT);
      }
    }

    // Plague: a few seconds' incubation, then it saps health and nerve until it passes.
    if (u.plague > 0) {
      u.plague -= DT;
      if (u.plagueInc > 0) u.plagueInc -= DT;
      else {
        this.damage(u, 1.5 * DT, null);
        if (!u.alive) return;
        if (d.morale.canBreak) u.morale = Math.max(0, u.morale - 0.05 * DT);
      }
      if (u.plague <= 0) { u.plague = 0; u.immune = true; }
    }
    // It spreads by touch, from rats and from the sick.
    if (d.plagueCarrier || u.plague > 0) {
      const rate = d.plagueCarrier ? 0.15 : u.plagueInc > 0 ? 0.125 : 0.25;
      this.forNear(u.x, u.y, u.r + MAX_RADIUS + 3, (o) => {
        if (o === u || o.plague > 0 || o.immune || o.prop) return;
        if (Math.hypot(o.x - u.x, o.y - u.y) < u.r + o.r + 3) this.catchPlague(o, rate * DT);
      });
    }
    // Rats and snakes spook horses; rats send giants running.
    if (d.scaresHorses && this.rng() < 0.25) {
      this.forNear(u.x, u.y, 60 + MAX_RADIUS, (o) => {
        if (!o.alive || o.prop || o.side === u.side) return;
        const dd = Math.hypot(o.x - u.x, o.y - u.y);
        if (o.def.skittish && dd < 50 + o.r) this.panic(o, u.x, u.y, 1);
        if (d.plagueCarrier && o.def.fearsRats && dd < o.def.fearsRats + o.r) { o.ratFearT = 2.5; o.ratX = u.x; o.ratY = u.y; }
      });
    }

    // Bitten: the infection takes hold and the unit rises as a ghoul.
    if (u.infected >= 0) {
      u.turnT -= DT;
      if (u.turnT <= 0) { this.kill(u, u.infBy); return; }
    }

    // Morale, about every 0.2 s.
    u.moraleT -= DT;
    if (u.moraleT <= 0) {
      u.moraleT = 0.15 + this.rng() * 0.1;
      this.updateMorale(u);
    }
    if (u.fleeing) {
      u.fleeT += DT;
      // Cornered for too long: turn and fight.
      if (u.fleeT > MAX_FLEE) { u.fleeing = false; u.steadyT = 6; u.morale = d.morale.brk + 0.05; }
    }
    // Captains command; heroes use their bonus ability.
    if (u.lvl >= 3 && !u.fleeing) {
      u.cmdT -= DT;
      if (u.cmdT <= 0) { u.cmdT = 0.5; this.command(u); }
      if (u.lvl >= 4 && u.abilCd <= 0 && u.stun <= 0) this.useAbility(u);
      if (!u.alive) return;
    }

    let dvx = 0;
    let dvy = 0;
    u.siege = false;
    u.flowing = false;
    u.chasing = false;
    let direct = false;
    if (u.dashT > 0) {
      // Mid-dash: straight line at full speed, slashing whoever is in the way.
      u.dashT -= DT;
      dvx = u.dashVx;
      dvy = u.dashVy;
      direct = true;
      this.dashSlash(u);
    } else if (u.stun > 0) {
      u.stun -= DT;
    } else {
      [dvx, dvy] = this.think(u);
    }
    const sm = direct ? 1 : speedMul * u.spd * (u.rageT > 0 ? d.rage.speed : 1);
    dvx *= sm;
    dvy *= sm;

    // Accelerate towards the desired velocity. Ice cuts grip; in the air there's none.
    const ax = dvx - u.vx;
    const ay = dvy - u.vy;
    const al = Math.hypot(ax, ay);
    const maxA = air ? 0 : d.accel * DT * grip;
    if (al > maxA && !direct) {
      if (maxA > 0) {
        u.vx += ax / al * maxA;
        u.vy += ay / al * maxA;
      }
    } else {
      u.vx = dvx;
      u.vy = dvy;
    }

    // Slipping on ice.
    if (grip < 0.5 && !air && u.stun <= 0 && Math.hypot(u.vx, u.vy) > SLIP_SPEED && this.rng() < SLIP_CHANCE * DT) {
      this.throwUnit(u, u.vx / 100, u.vy / 100, 20, 110);
      this.emit({ k: 'slip', x: Math.round(u.x), y: Math.round(u.y) });
    }

    // Integrate (walk velocity + knockback), sliding along walls.
    const mx = (u.vx + u.kx) * DT;
    const my = (u.vy + u.ky) * DT;
    const x0 = u.x;
    const y0 = u.y;
    let blocked = -1;
    if (u.flying || u.z > 25) {
      // High enough to clear walls.
      u.x = Math.max(u.r, Math.min(WORLD.width - u.r, u.x + mx));
      u.y = Math.max(u.r, Math.min(WORLD.height - u.r, u.y + my));
    } else {
      if (!this.circleBlocked(u.x + mx, u.y, u.r) && this.okTile(u, u.x + mx, u.y)) u.x += mx;
      else { blocked = this.blockingTile(u.x + mx, u.y, u.r); u.vx = 0; u.kx *= -0.3; }
      if (!this.circleBlocked(u.x, u.y + my, u.r) && this.okTile(u, u.x, u.y + my)) u.y += my;
      else { if (blocked === -1) blocked = this.blockingTile(u.x, u.y + my, u.r); u.vy = 0; u.ky *= -0.3; }
    }
    if (blocked !== -1 && this.circleBlocked(u.x, u.y, u.r)) this.unstick(u);
    // Pinned against a wall (e.g. by a gap too narrow for this unit)? Keep count.
    const wanted = Math.hypot(mx, my);
    const pinned = blocked >= 0 && wanted > 0 && Math.hypot(u.x - x0, u.y - y0) < wanted * 0.3;
    if (pinned) u.stuck += DT;
    else u.stuck = Math.max(0, u.stuck - DT * 2);
    if (blocked >= 0 && u.chasing) u.chaseBlock = 0.6;
    else if (u.chaseBlock > 0) u.chaseBlock -= DT;
    // Breaking through: a unit routed through a wall, or stuck against one, attacks the tile in its way.
    if ((u.siege || u.stuck > 0.8) && blocked >= 0 && u.cd <= 0 && d.role !== 'healer' && d.role !== 'raiser' && !u.fleeing) this.siegeHit(u, blocked);
    // A routed unit that reaches the edge of the map leaves the battle for good.
    if (u.fleeing && (u.x < u.r + 4 || u.y < u.r + 4 || u.x > WORLD.width - u.r - 4 || u.y > WORLD.height - u.r - 4)) {
      u.alive = false;
      this.stats.fled[u.side]++;
      if (u.group) u.group.dead++;
      this.emit({ k: 'fled', x: Math.round(u.x), y: Math.round(u.y), s: u.side });
      return;
    }
    // Knockback fades; on ice and in the air it carries much further.
    const kd = Math.max(0, 1 - 7 * DT * (air ? 0.15 : grip < 1 ? 0.25 : 1));
    u.kx *= kd;
    u.ky *= kd;

    // Heading: face the enemy when fighting, otherwise the direction of travel.
    let want = u.heading;
    if (u.faceAngle != null) want = u.faceAngle;
    else if (u.vx * u.vx + u.vy * u.vy > 25) want = Math.atan2(u.vy, u.vx);
    let diff = want - u.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const turn = (air ? 4 : 10) * DT;
    u.heading += Math.max(-turn, Math.min(turn, diff));
  }

  siegeHit(u, i) {
    const d = u.def;
    const dmg = d.melee ? d.melee.damage : d.ranged ? d.ranged.damage * 0.5 : 8;
    const cd = d.melee ? d.melee.cooldown : d.ranged ? d.ranged.cooldown * 0.6 : 1;
    this.damageWall(i, dmg * (0.85 + this.rng() * 0.3));
    u.cd = cd * (0.9 + this.rng() * 0.2);
    u.attackAnim = 1;
    const tx = ((i % COLS) + 0.5) * TILE;
    const ty = (((i / COLS) | 0) + 0.5) * TILE;
    u.heading = Math.atan2(ty - u.y, tx - u.x);
  }

  /** Push overlapping units apart, heavier units push lighter ones more. Mines and peels lie flat. */
  separate() {
    this.rebuildHash();
    for (const u of this.units) {
      if (!u.alive || u.def.mine || u.def.peel || u.z > 0) continue;
      this.forNear(u.x, u.y, u.r + MAX_RADIUS, (o) => {
        if (o.id <= u.id || !o.alive || o.def.mine || o.def.peel || o.z > 0) return;
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
        const pu = u.prop ? 0 : overlap * (o.mass / total) * 2 * (o.prop ? 2 : 1);
        const po = o.prop ? 0 : overlap * (u.mass / total) * 2 * (u.prop ? 2 : 1);
        const ux = u.x - nx * pu;
        const uy = u.y - ny * pu;
        if (pu && !this.circleBlocked(ux, uy, u.r)) { u.x = ux; u.y = uy; }
        const ox = o.x + nx * po;
        const oy = o.y + ny * po;
        if (po && !this.circleBlocked(ox, oy, o.r)) { o.x = ox; o.y = oy; }
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
      routed: this.stats.routed,
      fled: this.stats.fled,
      best: this.stats.best,
    };
  }
}
