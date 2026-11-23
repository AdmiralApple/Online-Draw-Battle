// Shared game constants, unit and terrain definitions.
// Imported by both the Node server and the browser client.

export const WORLD = { width: 1280, height: 720, tile: 10 };
export const COLS = WORLD.width / WORLD.tile; // 128
export const ROWS = WORLD.height / WORLD.tile; // 72

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 2; // snapshots at 15 Hz
export const BATTLE_TIME_LIMIT = 180; // seconds before the battle is decided on points
export const MAX_UNITS_PER_PLAYER = 700;

// Neutral strip in the middle of the map where nobody may draw.
export const NO_MANS_LAND = 120;

export const SIDE_NAMES = ['Teal', 'Coral'];

/** Drawable x-range for a side (0 = left, 1 = right). */
export function zoneOf(side) {
  const half = WORLD.width / 2;
  const gap = NO_MANS_LAND / 2;
  return side === 0
    ? { x0: 0, x1: half - gap, y0: 0, y1: WORLD.height }
    : { x0: half + gap, x1: WORLD.width, y0: 0, y1: WORLD.height };
}

export function inZone(side, x, y, margin = 0) {
  const z = zoneOf(side);
  return x >= z.x0 + margin && x <= z.x1 - margin && y >= z.y0 + margin && y <= z.y1 - margin;
}

export function tileInZone(side, col, row) {
  const x = (col + 0.5) * WORLD.tile;
  const y = (row + 0.5) * WORLD.tile;
  return inZone(side, x, y);
}

// ---------------------------------------------------------------------------
// Terrain. Costs are per tile (10x10 px). A brush stroke covers many tiles.
// ---------------------------------------------------------------------------
export const T = { NONE: 0, WALL: 1, WATER: 2, MUD: 3, BRAMBLE: 4 };

export const TERRAIN = [
  null,
  {
    id: T.WALL, key: 'wall', name: 'Stone Wall', cost: 0.25,
    solid: true, speed: 0, dps: 0, blocksShots: true,
    desc: 'Blocks movement and arrows. Bombs fly over.',
  },
  {
    id: T.WATER, key: 'water', name: 'Pond', cost: 0.12,
    solid: false, speed: 0.45, dps: 0, noShooting: true,
    desc: 'Very slow to wade through. Units in water cannot shoot.',
  },
  {
    id: T.MUD, key: 'mud', name: 'Mud', cost: 0.08,
    solid: false, speed: 0.6, dps: 0,
    desc: 'Slows everything that crosses it.',
  },
  {
    id: T.BRAMBLE, key: 'bramble', name: 'Brambles', cost: 0.15,
    solid: false, speed: 0.8, dps: 7,
    desc: 'Slightly slows and slowly hurts anyone inside.',
  },
];

export const TERRAIN_KEYS = TERRAIN.filter(Boolean).map((t) => t.key);

// ---------------------------------------------------------------------------
// Units. `spacing` is the brush grid spacing when painting them.
// ---------------------------------------------------------------------------
export const UNITS = [
  {
    key: 'militia', name: 'Militia', cost: 1,
    radius: 6, hp: 60, speed: 72, accel: 500, mass: 1, sight: 320, spacing: 16,
    role: 'melee',
    melee: { damage: 8, cooldown: 0.8, reach: 3 },
    desc: 'Cheap, plentiful, not very brave or strong.',
  },
  {
    key: 'spear', name: 'Pikeman', cost: 2,
    radius: 7, hp: 95, speed: 60, accel: 450, mass: 1.3, sight: 320, spacing: 17,
    role: 'melee',
    melee: { damage: 10, cooldown: 0.9, reach: 9, bonusVsMounted: 3 },
    desc: 'Long reach. Triple damage against riders and golems.',
  },
  {
    key: 'archer', name: 'Archer', cost: 3,
    radius: 6.5, hp: 50, speed: 62, accel: 450, mass: 1, sight: 340, spacing: 18,
    role: 'ranged',
    ranged: {
      range: 270, keep: 150, damage: 14, cooldown: 1.6, projectile: 'arrow',
      speed: 430, spread: 14, aoe: 0, lob: false,
    },
    desc: 'Shoots arrows from range and backs away from melee. Walls block shots.',
  },
  {
    key: 'hound', name: 'Hound', cost: 2,
    radius: 6, hp: 55, speed: 118, accel: 900, mass: 0.9, sight: 380, spacing: 16,
    role: 'melee',
    melee: { damage: 7, cooldown: 0.5, reach: 2 },
    desc: 'Very fast biter. Great at running down archers.',
  },
  {
    key: 'rider', name: 'Lancer', cost: 5,
    radius: 10, hp: 170, speed: 128, accel: 260, mass: 3, sight: 380, spacing: 26,
    role: 'melee', mounted: true,
    melee: { damage: 12, cooldown: 1.1, reach: 3, chargeDamage: 34, knockback: 220 },
    desc: 'Charges in at speed. Faster means harder hits and big knockback.',
  },
  {
    key: 'medic', name: 'Medic', cost: 4,
    radius: 6.5, hp: 60, speed: 66, accel: 450, mass: 1, sight: 300, spacing: 20,
    role: 'healer',
    heal: { amount: 14, cooldown: 1.0, range: 70, search: 260 },
    desc: 'Follows the army and patches up wounded allies.',
  },
  {
    key: 'bomber', name: 'Bombardier', cost: 6,
    radius: 7, hp: 60, speed: 55, accel: 400, mass: 1.1, sight: 360, spacing: 22,
    role: 'ranged',
    ranged: {
      range: 320, minRange: 70, keep: 180, damage: 38, cooldown: 3.4, projectile: 'bomb',
      speed: 260, spread: 22, aoe: 42, lob: true, knockback: 180,
    },
    desc: 'Lobs bombs over walls. Splash damage, but slow to reload.',
  },
  {
    key: 'golem', name: 'Golem', cost: 18,
    radius: 18, hp: 950, speed: 38, accel: 160, mass: 14, sight: 320, spacing: 50,
    role: 'melee', mounted: true,
    melee: { damage: 42, cooldown: 1.8, reach: 6, aoe: 30, knockback: 260 },
    desc: 'A slow walking boulder. Smashes groups and sends them flying.',
  },
];

export const UNIT_KEYS = UNITS.map((u) => u.key);
export const UNIT_INDEX = Object.fromEntries(UNITS.map((u, i) => [u.key, i]));

// ---------------------------------------------------------------------------
// Lobby settings
// ---------------------------------------------------------------------------
export const VISIBILITY = { HIDDEN: 'hidden', VISIBLE: 'visible' };

export function defaultSettings() {
  return {
    budget: 200,
    visibility: VISIBILITY.HIDDEN,
    drawTime: 0, // seconds, 0 = no limit
    costs: {
      units: Object.fromEntries(UNITS.map((u) => [u.key, u.cost])),
      terrain: Object.fromEntries(TERRAIN.filter(Boolean).map((t) => [t.key, t.cost])),
    },
  };
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const round2 = (n) => Math.round(n * 100) / 100;

/** Sanitise settings coming from the host. Returns a fresh, valid object. */
export function sanitizeSettings(input, prev = defaultSettings()) {
  const s = input || {};
  const out = {
    budget: Math.round(clampNum(s.budget, 1, 100000, prev.budget)),
    visibility: s.visibility === VISIBILITY.VISIBLE ? VISIBILITY.VISIBLE
      : s.visibility === VISIBILITY.HIDDEN ? VISIBILITY.HIDDEN : prev.visibility,
    drawTime: Math.round(clampNum(s.drawTime, 0, 3600, prev.drawTime)),
    costs: { units: {}, terrain: {} },
  };
  for (const u of UNITS) {
    out.costs.units[u.key] = round2(clampNum(s.costs?.units?.[u.key], 0, 10000, prev.costs.units[u.key]));
  }
  for (const t of TERRAIN) {
    if (!t) continue;
    out.costs.terrain[t.key] = round2(clampNum(s.costs?.terrain?.[t.key], 0, 100, prev.costs.terrain[t.key]));
  }
  return out;
}
