// Shared game constants, unit and terrain definitions.
// Imported by both the Node server and the browser client.

export const WORLD = { width: 1280, height: 720, tile: 10 };
export const COLS = WORLD.width / WORLD.tile; // 128
export const ROWS = WORLD.height / WORLD.tile; // 72

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 2; // snapshots at 15 Hz
export const BATTLE_TIME_LIMIT = 180; // seconds before the battle is decided on points

// Neutral strip in the middle of the map where nobody may draw.
export const NO_MANS_LAND = 120;

export const SIDE_NAMES = ['Teal', 'Coral', 'Plum'];
export const MAX_PLAYERS = 3;

// ---------------------------------------------------------------------------
// Map layouts. The layout is picked by how many players are in the match:
//   2 players: left / right halves.
//   3 players: three regions meeting at MEET: one along the top, one bottom-left,
//              one bottom-right. Every pair shares a border. MEET is placed so the
//              three drawable areas come out equal (about 26% of the map each).
// Each drawing zone is convex, written as half-planes [nx, ny, d] meaning
// nx*x + ny*y >= d. Borders between zones are pulled back by NO_MANS_LAND / 2.
// ---------------------------------------------------------------------------
const G = NO_MANS_LAND / 2;
const HALF_W = WORLD.width / 2;
const MEET_Y = 510;
// Unit normal (a, b) of the border from MEET to the top-left corner; mirrored for top-right.
const NL = Math.hypot(HALF_W, MEET_Y);
const NA = MEET_Y / NL;
const NB = HALF_W / NL;
const RIGHT_D = NA * WORLD.width; // border to the top-right corner: NA*x + NB*y = RIGHT_D
const LAYOUTS = {
  2: [
    [[-1, 0, -(HALF_W - G)]], // left half
    [[1, 0, HALF_W + G]], // right half
  ],
  3: [
    [[NA, -NB, G], [-NA, -NB, G - RIGHT_D]], // top
    [[-NA, NB, G], [-1, 0, -(HALF_W - G)]], // bottom-left
    [[NA, NB, RIGHT_D + G], [1, 0, HALF_W + G]], // bottom-right
  ],
};

/** Number of player zones for a match with `players` players (2 or 3). */
export function layoutFor(players) {
  return players >= 3 ? 3 : 2;
}

export function inZone(side, x, y, margin = 0, layout = 2) {
  if (x < margin || y < margin || x > WORLD.width - margin || y > WORLD.height - margin) return false;
  const zone = LAYOUTS[layoutFor(layout)][side];
  if (!zone) return false;
  for (const [nx, ny, d] of zone) if (nx * x + ny * y < d + margin) return false;
  return true;
}

export function tileInZone(side, col, row, layout = 2) {
  const x = (col + 0.5) * WORLD.tile;
  const y = (row + 0.5) * WORLD.tile;
  return inZone(side, x, y, 0, layout);
}

/** Outline of a side's drawing zone as [[x, y], ...] (the world rect clipped by its half-planes). */
export function zonePolygon(side, layout = 2) {
  let poly = [[0, 0], [WORLD.width, 0], [WORLD.width, WORLD.height], [0, WORLD.height]];
  const zone = LAYOUTS[layoutFor(layout)][side] || [];
  for (const [nx, ny, d] of zone) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = nx * a[0] + ny * a[1] - d;
      const db = nx * b[0] + ny * b[1] - d;
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = out;
  }
  return poly;
}

/** Centroid of a zone, e.g. for labels. */
export function zoneCentre(side, layout = 2) {
  const p = zonePolygon(side, layout);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  return a ? [cx / (3 * a), cy / (3 * a)] : [WORLD.width / 2, WORLD.height / 2];
}

// ---------------------------------------------------------------------------
// Terrain. Costs are per tile (10x10 px). A brush stroke covers many tiles.
// ---------------------------------------------------------------------------
export const T = { NONE: 0, WALL: 1, WATER: 2, MUD: 3, BRAMBLE: 4, ICE: 5 };

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
    solid: false, speed: 0.8, dps: 7, flammable: true,
    desc: 'Slows and scratches anyone inside. Burns: fire races through it and sets units alight.',
  },
  {
    id: T.ICE, key: 'ice', name: 'Ice', cost: 0.1,
    solid: false, speed: 1, dps: 0, slippery: true,
    desc: 'Almost no grip. Fast units skid and fall. Blasts and fire melt it into water.',
  },
];

export const TERRAIN_KEYS = TERRAIN.filter(Boolean).map((t) => t.key);

// ---------------------------------------------------------------------------
// Units. `spacing` is the brush grid spacing when painting them.
//
// Behaviour stats (all optional, see UNIT_DEFAULTS below):
//   iq           'trained' (dodges bombs, avoids mines and burning ground),
//                'animal' (runs to water when burning) or 'mindless' (neither)
//   react        base reaction time (s) before acting on a newly spotted target
//   strength     how much this unit counts for in morale odds
//   flammability 0 = fireproof, 1 = catches fire very easily
//   iceGrip      traction multiplier on ice (1 = full grip)
//   targeting    'swarm' (prefers ranged and support units, chases runners) or
//                'sticky' (keeps its target unless a much closer one turns up)
//   skittish     bolts away from explosions and fire
//   noStun       ignores stuns and can't be thrown
//   morale       { canBreak, baseline, brk, rally, odds, cas, wound, shock, supp, fear, minFlee }
//
// Props (`prop: true`) are placed like units but don't fight, aren't targeted and don't
// count towards an army's survival. The palette lists them in the Terrain tab.
// ---------------------------------------------------------------------------
const HUMAN_MORALE = {
  canBreak: true, baseline: 0.82, brk: 0.22, rally: 0.55, odds: 0.55,
  cas: 0.35, wound: 0.25, shock: 0.025, supp: 0.03, fear: 1, minFlee: 2.5,
};

export const UNITS = [
  {
    key: 'militia', name: 'Militia', cost: 1,
    radius: 6, hp: 60, speed: 72, accel: 500, mass: 1, sight: 320, spacing: 16,
    role: 'melee', iq: 'animal', react: 0.45, strength: 0.8, flammability: 0.5,
    melee: { damage: 8, cooldown: 0.8, reach: 3 },
    morale: { ...HUMAN_MORALE, baseline: 0.75, brk: 0.28, odds: 0.7, cas: 0.5, shock: 0.035 },
    desc: 'Cheap and plentiful, but not brave. Breaks and runs when outnumbered.',
  },
  {
    key: 'spear', name: 'Pikeman', cost: 2,
    radius: 7, hp: 95, speed: 60, accel: 450, mass: 1.3, sight: 320, spacing: 17,
    role: 'melee', iq: 'trained', react: 0.3, strength: 1.2, flammability: 0.3, targeting: 'sticky',
    melee: { damage: 10, cooldown: 0.9, reach: 9, bonusVsMounted: 3 },
    morale: { ...HUMAN_MORALE, baseline: 0.9, brk: 0.2, rally: 0.5, odds: 0.4, cas: 0.2 },
    desc: 'Long reach and steady nerves. Triple damage against riders and golems.',
  },
  {
    key: 'archer', name: 'Archer', cost: 3,
    radius: 6.5, hp: 50, speed: 62, accel: 450, mass: 1, sight: 340, spacing: 18,
    role: 'ranged', iq: 'trained', react: 0.3, strength: 0.7, flammability: 0.4,
    ranged: {
      range: 270, keep: 150, damage: 14, cooldown: 1.6, projectile: 'arrow',
      speed: 430, spread: 14, aoe: 0, lob: false,
    },
    morale: { ...HUMAN_MORALE },
    desc: 'Shoots from range and backs away from melee. Near misses rattle the enemy. Walls block arrows.',
  },
  {
    key: 'hound', name: 'Hound', cost: 2,
    radius: 6, hp: 55, speed: 118, accel: 900, mass: 0.9, sight: 380, spacing: 16,
    role: 'melee', iq: 'animal', react: 0.2, strength: 0.8, flammability: 0.7, targeting: 'swarm',
    melee: { damage: 7, cooldown: 0.5, reach: 2 },
    morale: { ...HUMAN_MORALE, baseline: 0.85, brk: 0.15, rally: 0.5, odds: 0.25, cas: 0.1, fear: 0.5, minFlee: 1.5 },
    desc: 'Very fast biter. Hunts archers, medics and anyone who runs. Too light to set off mines.',
  },
  {
    key: 'rider', name: 'Lancer', cost: 5,
    radius: 10, hp: 170, speed: 128, accel: 260, mass: 3, sight: 380, spacing: 26,
    role: 'melee', mounted: true, iq: 'trained', react: 0.3, strength: 3, flammability: 0.4,
    iceGrip: 0.05, targeting: 'sticky', skittish: true,
    melee: { damage: 12, cooldown: 1.1, reach: 3, chargeDamage: 34, knockback: 220, throwChance: 0.3 },
    morale: { ...HUMAN_MORALE, baseline: 0.9, brk: 0.18, rally: 0.5, odds: 0.25, cas: 0.3, wound: 0.3, fear: 0.4 },
    desc: 'Charges in at speed and tosses enemies aside. Horses bolt from fire and blasts, and skid on ice.',
  },
  {
    key: 'medic', name: 'Medic', cost: 4,
    radius: 6.5, hp: 60, speed: 66, accel: 450, mass: 1, sight: 300, spacing: 20,
    role: 'healer', iq: 'trained', react: 0.35, strength: 0.3, flammability: 0.4,
    heal: { amount: 14, cooldown: 1.0, range: 70, search: 260, morale: 0.15 },
    morale: { ...HUMAN_MORALE },
    desc: 'Patches up the wounded, steadies their nerves and puts out burning allies.',
  },
  {
    key: 'bomber', name: 'Bombardier', cost: 6,
    radius: 7, hp: 60, speed: 55, accel: 400, mass: 1.1, sight: 360, spacing: 22,
    role: 'ranged', iq: 'trained', react: 0.4, strength: 1, flammability: 0.5,
    ranged: {
      range: 320, minRange: 70, keep: 180, damage: 38, cooldown: 4.2, projectile: 'bomb',
      speed: 260, spread: 22, aoe: 42, lob: true, knockback: 180,
    },
    morale: { ...HUMAN_MORALE },
    desc: 'Lobs bombs over walls. Splash damage that throws units and lights brambles, but slow to reload.',
  },
  {
    key: 'golem', name: 'Golem', cost: 18,
    radius: 18, hp: 950, speed: 38, accel: 160, mass: 14, sight: 320, spacing: 50,
    role: 'melee', mounted: true, iq: 'mindless', react: 0.5, strength: 12, flammability: 0,
    iceGrip: 1, targeting: 'sticky', noStun: true,
    melee: { damage: 42, cooldown: 1.8, reach: 6, aoe: 30, knockback: 260, throwChance: 0.5 },
    morale: { canBreak: false },
    desc: 'A slow walking boulder. Fireproof and fearless. Smashes groups and sends them flying.',
  },
  {
    key: 'mine', name: 'Mine', cost: 2,
    radius: 4.5, hp: 40, speed: 0, accel: 0, mass: 50, sight: 0, spacing: 38,
    role: 'prop', prop: true, flammability: 0,
    mine: { trigger: 9.5, fuse: 0.4, minMass: 1 },
    blast: { radius: 46, damage: 110, knockback: 220, minFrac: 0.2, ignite: 0 },
    desc: 'Hidden from the enemy. Goes off under any enemy except hounds. Blasts set off nearby mines.',
  },
  {
    key: 'keg', name: 'Powder Keg', cost: 3,
    radius: 7, hp: 45, speed: 0, accel: 0, mass: 40, sight: 0, spacing: 24,
    role: 'prop', prop: true, flammability: 0.9,
    blast: { radius: 70, damage: 95, knockback: 260, minFrac: 0.2, ignite: 0.6 },
    desc: 'Explodes in a fireball when shot, burnt or caught in a blast. Hurts both sides.',
  },
];

/** Defaults for behaviour stats a unit doesn't set. */
export const UNIT_DEFAULTS = {
  iq: 'trained', react: 0.35, strength: 1, flammability: 0.4, iceGrip: 0.2,
  morale: { canBreak: false },
};
for (const u of UNITS) {
  for (const [k, v] of Object.entries(UNIT_DEFAULTS)) if (u[k] === undefined) u[k] = v;
}

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
