// Regression tests for the combat systems: mines, kegs, fire, ice, morale and props.
// Runs the battle sim headlessly.
//   node test/systems.js

import { Battle } from '../host/sim.js';
import { COLS, ROWS, UNITS, UNIT_INDEX, T, defaultSettings, TICK_RATE } from '../shared/config.js';
import { encodeSnapshot, decodeSnapshot } from '../shared/protocol.js';

const settings = defaultSettings();
let failed = 0;
const ok = (m) => console.log('  ok -', m);
const bad = (m) => { console.log('  FAIL -', m); failed++; };
const check = (cond, good, fail) => (cond ? ok(good) : bad(fail));

const U = UNIT_INDEX;
function grid() { return new Uint8Array(COLS * ROWS); }
function fill(g, c0, r0, c1, r1, t) {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r * COLS + c] = t;
}
const battle = (d0, d1, seed = 5) => new Battle({ drafts: [d0, d1], settings, seed });
const steps = (b, seconds) => { for (let i = 0; i < seconds * TICK_RATE && !b.over; i++) b.step(); return b; };

// 1. A mine goes off under an enemy militia, but not under a light hound.
{
  const b = battle(
    { units: [[U.mine, 600, 360], [U.spear, 100, 360]], grid: grid() },
    { units: [[U.militia, 640, 360]], grid: grid() },
  );
  let boom = false;
  for (let i = 0; i < 3 * TICK_RATE && !boom; i++) { b.step(); boom = b.takeEvents().some((e) => e.k === 'boom'); }
  check(boom, 'mine explodes under an enemy militia', 'mine never went off under a militia');

  const h = battle(
    { units: [[U.mine, 600, 360], [U.militia, 120, 100]], grid: grid() },
    { units: [[U.hound, 601, 360]], grid: grid() },
  );
  let hboom = false;
  for (let i = 0; i < TICK_RATE && !hboom; i++) { h.step(); hboom = h.takeEvents().some((e) => e.k === 'boom'); }
  check(!hboom, 'hounds are too light to set off mines', 'a hound set off a mine');
}

// 2. A powder keg caught in a bomb blast explodes and lights the brambles around it.
{
  const g = grid();
  fill(g, 50, 30, 70, 40, T.BRAMBLE);
  const b = battle(
    { units: [[U.bomber, 300, 355]], grid: grid() },
    { units: [[U.keg, 600, 355], [U.spear, 1200, 100]], grid: g },
  );
  b.rebuildHash();
  b.explode(600, 355, { radius: 40, damage: 60, knockback: 0 }, 0, null);
  let kegBoom = false;
  let fires = 0;
  for (let i = 0; i < 2 * TICK_RATE; i++) {
    b.step();
    for (const e of b.takeEvents()) {
      if (e.k === 'boom') kegBoom = true;
      if (e.k === 'fire') fires++;
    }
  }
  check(kegBoom && !b.units.some((u) => u.type === U.keg), 'keg explodes when caught in a blast', 'keg survived a blast');
  check(fires > 10, `fire spreads through brambles (${fires} tiles lit)`, `fire barely spread (${fires} tiles)`);
  steps(b, 8);
  let burnt = 0;
  for (let i = 0; i < g.length; i++) if (g[i] === T.BRAMBLE && b.grid[i] === T.NONE) burnt++;
  check(burnt > 20, `brambles burn away to bare ground (${burnt} tiles)`, `only ${burnt} bramble tiles burnt`);
}

// 3. A burning unit runs to nearby water and is put out.
{
  const g = grid();
  fill(g, 70, 30, 80, 40, T.WATER);
  const b = battle(
    { units: [[U.archer, 640, 355]], grid: g },
    { units: [[U.spear, 1250, 40]], grid: grid() },
  );
  const a = b.units[0];
  a.burn = 4;
  steps(b, 2.5);
  check(a.alive && a.burn <= 0, 'burning archer runs into water and is put out', `archer still burning=${a.burn.toFixed(2)} alive=${a.alive}`);
}

// 4. Lancers charging across ice skid and fall.
{
  const g = grid();
  fill(g, 20, 0, 110, ROWS - 1, T.ICE);
  const units0 = [];
  for (let i = 0; i < 12; i++) units0.push([U.rider, 240, 80 + i * 48]);
  const b = battle({ units: units0, grid: g }, { units: [[U.spear, 1250, 360]], grid: grid() });
  let slips = 0;
  for (let i = 0; i < 10 * TICK_RATE; i++) { b.step(); slips += b.takeEvents().filter((e) => e.k === 'slip').length; }
  check(slips > 0, `lancers slip on ice (${slips} falls)`, 'no lancer ever slipped on ice');
}

// 5. A small militia band facing a golem breaks and runs; routed units leave at the map edge.
{
  const units1 = [];
  for (let i = 0; i < 6; i++) units1.push([U.militia, 1150, 300 + i * 20]);
  const b = battle({ units: [[U.golem, 900, 350]], grid: grid() }, { units: units1, grid: grid() });
  steps(b, 30);
  check(b.stats.routed[1] > 0, `militia rout in front of a golem (${b.stats.routed[1]} broke)`, 'militia never broke');
  check(b.stats.fled[1] > 0, `routed units flee off the map (${b.stats.fled[1]} fled)`, 'no routed unit left the field');
}

// 5b. With morale switched off in the lobby, the same militia fight to the end.
{
  const units1 = [];
  for (let i = 0; i < 6; i++) units1.push([U.militia, 1150, 300 + i * 20]);
  const s0 = defaultSettings();
  s0.morale = false;
  const b = new Battle({ drafts: [{ units: [[U.golem, 900, 350]], grid: grid() }, { units: units1, grid: grid() }], settings: s0, seed: 5 });
  steps(b, 30);
  check(b.stats.routed[1] === 0 && b.stats.fled[1] === 0, 'morale can be switched off: nobody breaks', `routed=${b.stats.routed[1]} fled=${b.stats.fled[1]}`);
}

// 6. Props don't keep an army alive.
{
  const b = battle(
    { units: [[U.spear, 600, 360], [U.spear, 610, 380]], grid: grid() },
    { units: [[U.keg, 1200, 100], [U.mine, 1200, 600]], grid: grid() },
  );
  b.step();
  check(b.over && b.winner === 0, 'an army of only props has already lost', `props kept an army alive (over=${b.over})`);
}

// 6b. New units.
{
  const count = (b, key, side) => b.units.filter((u) => u.alive && u.type === U[key] && u.side === side).length;
  const evs = (b, seconds, k) => {
    let n = 0;
    for (let i = 0; i < seconds * TICK_RATE && !b.over; i++) { b.step(); n += b.takeEvents().filter((e) => e.k === k).length; }
    return n;
  };

  // A legionary's shield soaks up most of an arrow from the front, none from behind.
  {
    const b = battle({ units: [[U.legion, 600, 360]], grid: grid() }, { units: [[U.archer, 900, 360]], grid: grid() });
    const l = b.units[0];
    const a = b.units[1];
    l.heading = 0;
    b.damage(l, 40, a);
    const front = 130 - l.hp;
    l.hp = 130;
    l.heading = Math.PI;
    b.damage(l, 40, a);
    const back = 130 - l.hp;
    check(front < 20 && back === 40, `shield blocks from the front (${front.toFixed(0)} vs ${back} from behind)`, `shield front=${front} back=${back}`);
  }

  // Ghoul bites turn militia into ghouls for the biting side.
  {
    const units1 = [];
    for (let i = 0; i < 6; i++) units1.push([U.militia, 760, 300 + i * 22]);
    const b = battle({ units: [[U.ghoul, 600, 330], [U.ghoul, 600, 370], [U.ghoul, 600, 410]], grid: grid() }, { units: units1, grid: grid() });
    const rises = evs(b, 40, 'rise');
    check(rises > 0 && b.stats.kills[0] > 0, `bitten militia rise as ghouls (${rises} turned)`, 'no unit was turned by a ghoul bite');
  }

  // A medic cures a bite before it takes hold.
  {
    const b = battle({ units: [[U.medic, 600, 360], [U.militia, 620, 360]], grid: grid() }, { units: [[U.spear, 1250, 40]], grid: grid() });
    const m = b.units[1];
    m.infected = 1;
    m.turnT = 3;
    steps(b, 2.5);
    check(m.alive && m.infected < 0, 'medic cures a ghoul bite', `bite not cured (alive=${m.alive} infected=${m.infected})`);
  }

  // An ooze splits into halves and then quarters as it takes hits.
  {
    const units1 = [];
    for (let i = 0; i < 4; i++) units1.push([U.archer, 1000, 300 + i * 30]);
    const b = battle({ units: [[U.ooze, 600, 360]], grid: grid() }, { units: units1, grid: grid() });
    let sawHalf = false;
    let sawQuarter = false;
    for (let i = 0; i < 30 * TICK_RATE && !b.over; i++) {
      b.step();
      if (count(b, 'ooze_m', 0)) sawHalf = true;
      if (count(b, 'ooze_s', 0)) sawQuarter = true;
    }
    check(sawHalf && sawQuarter, 'ooze splits into halves, then quarters', `ooze split half=${sawHalf} quarter=${sawQuarter}`);
  }

  // A marksman's bullet passes through a line of militia.
  {
    const units1 = [];
    for (let i = 0; i < 4; i++) units1.push([U.militia, 800 + i * 16, 360]);
    const b = battle({ units: [[U.sniper, 420, 360]], grid: grid() }, { units: units1, grid: grid() });
    for (const u of b.units) if (u.side === 1) { u.stun = 99; u.def = { ...u.def, morale: { canBreak: false } }; }
    steps(b, 4);
    const hurt = b.units.filter((u) => u.side === 1 && u.hp < u.maxHp).length;
    check(hurt >= 2, `marksman's shot pierces a line of units (${hurt} hit)`, `only ${hurt} militia hurt by a piercing shot`);
  }

  // Lightning striking a unit in water shocks everyone else in the pond.
  {
    const g = grid();
    fill(g, 70, 20, 100, 50, T.WATER);
    const units1 = [[U.militia, 760, 360], [U.militia, 960, 300], [U.militia, 960, 440]];
    const b = battle({ units: [[U.storm, 560, 360]], grid: grid() }, { units: units1, grid: g });
    for (const u of b.units) if (u.side === 1) u.stun = 99;
    const ponds = evs(b, 4, 'pond');
    const far = b.units.filter((u) => u.side === 1 && u.x > 900 && u.hp < u.maxHp).length;
    check(ponds > 0 && far === 2, `lightning electrifies the pond (${far} distant waders hurt)`, `pond shock ponds=${ponds} far=${far}`);
  }

  // A badly hurt shade drops smoke, and enemies lose track of it.
  {
    const b = battle({ units: [[U.shade, 600, 360]], grid: grid() }, { units: [[U.spear, 640, 360]], grid: grid() });
    const s = b.units[0];
    s.hp = s.maxHp * 0.3;
    const smokes = evs(b, 1, 'smoke');
    check(smokes === 1 && b.smokes.length === 1, 'hurt shade vanishes in smoke', `smoke events=${smokes}`);
  }

  // Firebrands set enemies alight but can't hurt stone.
  {
    const units1 = [];
    for (let i = 0; i < 3; i++) units1.push([U.militia, 700, 330 + i * 30]);
    const b = battle({ units: [[U.torch, 600, 360]], grid: grid() }, { units: units1, grid: grid() });
    const ign = evs(b, 6, 'ignite');
    check(ign > 0, `firebrand sets militia alight (${ign} caught fire)`, 'firebrand never lit anyone');
    const gb = battle({ units: [[U.torch, 600, 360]], grid: grid() }, { units: [[U.golem, 680, 360]], grid: grid() });
    const golem = gb.units[1];
    golem.stun = 99;
    steps(gb, 4);
    check(golem.hp === golem.maxHp, 'flames do nothing to a golem', `golem took ${golem.maxHp - golem.hp} fire damage`);
  }
}

// 6c. Animals, monsters and the last props.
{
  const evs = (b, seconds, k) => {
    let n = 0;
    for (let i = 0; i < seconds * TICK_RATE && !b.over; i++) { b.step(); n += b.takeEvents().filter((e) => e.k === k).length; }
    return n;
  };
  const far = [U.spear, 1250, 40];

  // Rats spread plague; fire burns it out.
  {
    const b = battle({ units: [[U.rat, 600, 360]], grid: grid() }, { units: [[U.militia, 606, 360], [U.militia, 612, 368]], grid: grid() });
    const m = b.units[1];
    for (const u of b.units) if (u.side === 1) u.stun = 99;
    for (let i = 0; i < 6 * TICK_RATE && m.plague <= 0 && m.alive; i++) b.step();
    check(m.plague > 0, 'touching a rat spreads plague', 'nobody caught plague from a rat');
    b.ignite(m, 10);
    check(m.plague <= 0 && m.immune, 'fire burns the plague out', 'plague survived fire');
  }

  // Boars graze until an enemy comes close.
  {
    const b = battle({ units: [[U.boar, 300, 360], [U.boar, 300, 400]], grid: grid() }, { units: [[U.militia, 1000, 360]], grid: grid() });
    steps(b, 3);
    const calm = b.units.filter((u) => u.type === U.boar && !u.alert).length;
    check(calm === 2, 'boars graze while no enemy is near', `${2 - calm} boars woke up with nobody near`);
    b.units.find((u) => u.type === U.militia).x = 420;
    steps(b, 1);
    const awake = b.units.filter((u) => u.type === U.boar && u.alert).length;
    check(awake === 2, 'an enemy close by wakes the whole herd', `only ${awake} boars alerted`);
  }

  // An anthill keeps hatching ants that guard it.
  {
    const b = battle({ units: [[U.anthill, 300, 360]], grid: grid() }, { units: [far], grid: grid() });
    steps(b, 12);
    const ants = b.units.filter((u) => u.type === U.ant);
    const near = ants.every((a) => Math.hypot(a.x - 300, a.y - 360) < 120);
    check(ants.length >= 3 && near, `anthill hatches ants that stay home (${ants.length})`, `ants=${ants.length} near=${near}`);
  }

  // A gator hides in its pond and is tougher there; piranhas only go for waders.
  {
    const g = grid();
    fill(g, 50, 25, 75, 45, T.WATER);
    const b = battle({ units: [[U.gator, 620, 350], [U.piranha, 560, 300]], grid: g }, { units: [[U.archer, 950, 350], [U.militia, 950, 100]], grid: grid() });
    b.step();
    const gt = b.units[0];
    const archer = b.units.find((u) => u.type === U.archer);
    check(gt.inWater && !b.canSee(archer, gt, 330 * 330), 'gator is hidden while in its pond', 'gator visible from far away');
    const hp = gt.hp;
    b.damage(gt, 40, archer);
    check(hp - gt.hp === 20, 'gator takes half damage in water', `gator took ${hp - gt.hp}`);
    const pir = b.units.find((u) => u.type === U.piranha);
    check(!b.canTarget(pir, archer) && b.chooseTarget(pir) === null, 'piranhas ignore enemies on dry land', 'piranha targeted a land unit');
  }

  // A snake swallows a badly wounded victim whole and grows.
  {
    const b = battle({ units: [[U.snake, 600, 360]], grid: grid() }, { units: [[U.militia, 615, 360]], grid: grid() });
    const s = b.units[0];
    b.units[1].hp = 10;
    b.units[1].stun = 5;
    const gulps = evs(b, 3, 'gulp');
    check(gulps === 1 && s.maxHp > 70, `snake swallows its prey and grows (max HP ${Math.round(s.maxHp)})`, `gulps=${gulps} maxHp=${s.maxHp}`);
  }

  // A cheetah pounces and pins its prey.
  {
    const b = battle({ units: [[U.cheetah, 500, 360]], grid: grid() }, { units: [[U.archer, 720, 360]], grid: grid() });
    const n = evs(b, 4, 'pounce');
    check(n > 0, 'cheetah sprints in and pounces', 'cheetah never pounced');
  }

  // A hexer turns the strongest enemy into a frog.
  {
    const b = battle({ units: [[U.hexer, 500, 360]], grid: grid() }, { units: [[U.militia, 700, 330], [U.rider, 700, 390]], grid: grid() });
    const n = evs(b, 8, 'hex');
    const frogs = b.units.filter((u) => u.type === U.frog).length;
    check(n > 0 && frogs > 0, 'hexer turns an enemy into a frog', `hexes=${n} frogs=${frogs}`);
  }

  // A giant flees from rats.
  {
    const b = battle({ units: [[U.giant, 600, 360]], grid: grid() }, { units: [[U.rat, 640, 360]], grid: grid() });
    const gi = b.units[0];
    steps(b, 1);
    check(gi.ratFearT > 0, 'giant is terrified of rats', 'giant ignored a rat');
  }

  // A walled-in target: the dragon flies over the wall and lands on the far side.
  {
    const g = grid();
    fill(g, 80, 0, 81, ROWS - 1, T.WALL);
    const b = battle({ units: [[U.dragon, 600, 360]], grid: grid() }, { units: [[U.militia, 900, 360]], grid: g });
    let flew = false;
    for (let i = 0; i < 12 * TICK_RATE && !b.over; i++) { b.step(); if (b.units[0].flying) flew = true; }
    check(flew && (b.over || b.units[0].x > 820), 'dragon flies over a wall to reach its target', `flew=${flew} x=${Math.round(b.units[0].x)}`);
  }

  // A necromancer raises the fallen as skeletons.
  {
    const b = battle({ units: [[U.necro, 300, 360], [U.spear, 340, 360]], grid: grid() }, { units: [far], grid: grid() });
    for (let i = 0; i < 4; i++) b.corpses.push({ x: 380 + i * 8, y: 420, r: 6, t: 0 });
    const n = evs(b, 6, 'raise');
    const sk = b.units.filter((u) => u.type === U.skeleton && u.side === 0).length;
    check(n > 0 && sk === 4, `necromancer raises skeletons (${sk})`, `raises=${n} skeletons=${sk}`);
  }

  // Trees catch most arrows; banana peels trip runners.
  {
    const b = battle({ units: [[U.archer, 500, 360]], grid: grid() }, { units: [[U.tree, 700, 360], [U.militia, 760, 360]], grid: grid() });
    b.units[2].stun = 999;
    steps(b, 12);
    const tree = b.units.find((u) => u.type === U.tree);
    check(tree && tree.hp < tree.maxHp, 'trees catch arrows', 'no arrow hit the tree');
    const p = battle({ units: [[U.peel, 700, 360], [U.archer, 300, 360]], grid: grid() }, { units: [[U.hound, 900, 360]], grid: grid() });
    const slips = evs(p, 6, 'slip');
    check(slips === 1, 'a running hound slips on a banana peel', `slips=${slips}`);
  }
}

// 6d. Generals: XP, levels, command and level 4 abilities.
{
  const evs = (b, seconds, k) => {
    let n = 0;
    for (let i = 0; i < seconds * TICK_RATE && !b.over; i++) { b.step(); n += b.takeEvents().filter((e) => e.k === k).length; }
    return n;
  };
  const far = [U.spear, 1250, 40];

  // Kills give XP; levelling up heals, adds a title and more damage.
  {
    const b = battle({ units: [[U.spear, 300, 360]], grid: grid() }, { units: [far, [U.golem, 1200, 600]], grid: grid() });
    const s = b.units[0];
    const victim = b.units[1];
    s.hp = 20;
    b.gainXp(s, victim);
    check(s.lvl === 1 && s.xp === 2, 'a kill earns XP worth the victim\'s cost', `lvl=${s.lvl} xp=${s.xp}`);
    b.gainXp(s, victim);
    check(s.lvl === 2 && s.title.startsWith('Sgt. ') && s.hp > 60, `level 2 heals and earns a title (${s.title})`, `lvl=${s.lvl} title=${s.title} hp=${s.hp}`);
    const golem = b.units[2];
    const before = golem.hp;
    b.damage(golem, 10, s);
    check(Math.abs(before - golem.hp - 12) < 0.01, 'each level adds 20% damage', `level 2 hit did ${before - golem.hp}`);
    b.gainXp(b.units[2], s); // the golem kills a pikeman (2 XP)
    check(b.stats.best[1] && b.stats.best[1].kills === 1, 'best unit per side is tracked', 'no best unit recorded');
  }

  // With generals turned off, nobody levels up.
  {
    const s0 = defaultSettings();
    s0.generals = false;
    const b = new Battle({ drafts: [{ units: [[U.spear, 300, 360]], grid: grid() }, { units: [far], grid: grid() }], settings: s0, seed: 5 });
    const s = b.units[0];
    for (let i = 0; i < 10; i++) b.gainXp(s, b.units[1]);
    check(s.lvl === 1 && s.kills === 10, 'generals can be switched off', `lvl=${s.lvl}`);
  }

  // A captain inspires nearby friends and rallies runners.
  {
    const b = battle({ units: [[U.spear, 300, 360], [U.militia, 340, 360], [U.militia, 600, 360]], grid: grid() }, { units: [far], grid: grid() });
    const [cap, near, away] = b.units;
    while (cap.lvl < 3) b.levelUp(cap);
    near.fleeing = true;
    near.fleeT = 2;
    near.morale = 0.1;
    steps(b, 0.7);
    check(near.inspT > 0 && near.leader === cap && away.inspT <= 0, `captain inspires friends close by (${cap.title})`, `near=${near.inspT} away=${away.inspT}`);
    check(!near.fleeing, 'captain rallies a routed unit', 'routed unit kept running');
  }

  // Level 4: melee whirlwind, ranged volley, medic mass heal.
  {
    const units1 = [];
    for (let i = 0; i < 4; i++) units1.push([U.militia, 620 + (i % 2) * 14, 350 + (i >> 1) * 14]);
    const b = battle({ units: [[U.spear, 600, 360]], grid: grid() }, { units: units1, grid: grid() });
    while (b.units[0].lvl < 4) b.levelUp(b.units[0]);
    check(evs(b, 3, 'whirl') > 0, 'level 4 melee units whirlwind', 'no whirlwind');

    const a = battle({ units: [[U.archer, 500, 360]], grid: grid() }, { units: [[U.golem, 700, 360]], grid: grid() });
    while (a.units[0].lvl < 4) a.levelUp(a.units[0]);
    check(evs(a, 3, 'volley') > 0, 'level 4 ranged units fire a volley', 'no volley');

    const m = battle({ units: [[U.medic, 500, 360], [U.spear, 520, 360], [U.spear, 520, 380]], grid: grid() }, { units: [far], grid: grid() });
    while (m.units[0].lvl < 4) m.levelUp(m.units[0]);
    m.units[1].hp = 20;
    m.units[2].hp = 20;
    check(evs(m, 2, 'cry') > 0, 'level 4 medics mass heal', 'no mass heal');
  }
}

// 7. Every unit type survives a big mixed battle without errors, and snapshots round-trip.
{
  const g0 = grid();
  const g1 = grid();
  fill(g0, 20, 10, 30, 20, T.BRAMBLE);
  fill(g0, 20, 40, 30, 50, T.ICE);
  fill(g1, 90, 10, 100, 20, T.WATER);
  fill(g1, 90, 40, 100, 50, T.MUD);
  fill(g1, 85, 25, 86, 35, T.WALL);
  const d0 = [];
  const d1 = [];
  UNITS.forEach((u, type) => {
    for (let i = 0; i < 6; i++) {
      d0.push([type, 100 + (type % 8) * 48 + (i % 3) * 14, 40 + Math.floor(type / 8) * 130 + Math.floor(i / 3) * 40]);
      d1.push([type, 1180 - (type % 8) * 48 - (i % 3) * 14, 40 + Math.floor(type / 8) * 130 + Math.floor(i / 3) * 40]);
    }
  });
  let err = null;
  let b;
  const t0 = Date.now();
  try {
    b = battle({ units: d0, grid: g0 }, { units: d1, grid: g1 }, 11);
    steps(b, 120);
  } catch (e) { err = e; }
  if (err) bad(`mixed battle threw: ${err.stack}`);
  else ok(`mixed battle ran ${Math.round(b.time)}s in ${Date.now() - t0}ms (${b.reason || 'still going'})`);
  if (b) {
    const snap = decodeSnapshot(encodeSnapshot(b.tick, b.units, b.projectiles).buffer);
    check(snap.units.size === b.units.length, 'snapshot round-trips every unit', 'snapshot unit count mismatch');
  }
}

console.log(failed ? `\n${failed} system test(s) failed` : '\nAll system tests passed');
process.exitCode = failed ? 1 : 0;
