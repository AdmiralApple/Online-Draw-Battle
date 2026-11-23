// Pathfinding regression tests around walls. Runs the battle sim headlessly.
//   node test/walls.js

import { Battle } from '../host/sim.js';
import { COLS, ROWS, UNIT_INDEX, T, defaultSettings, TICK_RATE } from '../shared/config.js';

const settings = defaultSettings();
let failed = 0;
const ok = (m) => console.log('  ok -', m);
const bad = (m) => { console.log('  FAIL -', m); failed++; };

function grid() { return new Uint8Array(COLS * ROWS); }
function wallRect(g, c0, r0, c1, r1) {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r * COLS + c] = T.WALL;
}
function boxOutline(g, c0, r0, c1, r1, thick = 1) {
  wallRect(g, c0, r0, c1, r0 + thick - 1);
  wallRect(g, c0, r1 - thick + 1, c1, r1);
  wallRect(g, c0, r0, c0 + thick - 1, r1);
  wallRect(g, c1 - thick + 1, r0, c1, r1);
}

/** Run until over or `seconds`; returns the battle. */
function run(drafts, seconds, seed = 7) {
  const b = new Battle({ drafts, settings, seed });
  const maxTicks = seconds * TICK_RATE;
  while (!b.over && b.tick < maxTicks) b.step();
  return b;
}

const M = UNIT_INDEX.militia;
const G = UNIT_INDEX.golem;

// 1. Units whose bodies overlap a wall (centre just outside the wall tile) must still move.
{
  const g0 = grid();
  wallRect(g0, 30, 10, 30, 60); // wall column x = 300..310
  const units0 = [];
  for (let i = 0; i < 25; i++) units0.push([M, 296, 110 + i * 18]); // 4px from the wall: body overlaps it
  for (let i = 0; i < 25; i++) units0.push([M, 314, 110 + i * 18]); // other side, also overlapping
  const units1 = [];
  for (let i = 0; i < 20; i++) units1.push([M, 1100, 150 + i * 20]);
  const b = new Battle({ drafts: [{ units: units0, grid: g0 }, { units: units1, grid: grid() }], settings, seed: 3 });
  const start = new Map(b.units.map((u) => [u.id, [u.x, u.y]]));
  for (let i = 0; i < 3 * TICK_RATE; i++) b.step();
  let frozen = 0;
  for (const u of b.units) {
    if (u.side !== 0) continue;
    const [x, y] = start.get(u.id);
    if (Math.hypot(u.x - x, u.y - y) < 3) frozen++;
  }
  if (frozen === 0) ok('units touching a wall get unstuck and move');
  else bad(`${frozen} of 50 units touching a wall never moved`);
}

// 2. An army fully enclosed by walls: the battle must still be decided by fighting, not stall.
{
  const g0 = grid();
  boxOutline(g0, 5, 20, 40, 50, 2);
  const units0 = [];
  for (let i = 0; i < 30; i++) units0.push([M, 100 + (i % 10) * 20, 260 + Math.floor(i / 10) * 30]);
  const units1 = [];
  for (let i = 0; i < 40; i++) units1.push([M, 1000 + (i % 10) * 20, 260 + Math.floor(i / 10) * 30]);
  const b = run([{ units: units0, grid: g0 }, { units: units1, grid: grid() }], 120);
  if (b.over && b.reason === 'Army destroyed') ok(`walled-in army: decided by combat in ${Math.round(b.time)}s (winner ${b.winner})`);
  else bad(`walled-in army: stalled (over=${b.over}, ${b.reason || 'no result'} after ${Math.round(b.time)}s, kills ${b.stats.kills})`);
}

// 3. Both armies enclosed.
{
  const g0 = grid();
  boxOutline(g0, 5, 20, 40, 50, 1);
  const g1 = grid();
  boxOutline(g1, 85, 15, 122, 55, 1);
  const units0 = [];
  for (let i = 0; i < 20; i++) units0.push([M, 120 + (i % 5) * 20, 300 + Math.floor(i / 5) * 25]);
  const units1 = [];
  for (let i = 0; i < 20; i++) units1.push([M, 1000 + (i % 5) * 20, 300 + Math.floor(i / 5) * 25]);
  const b = run([{ units: units0, grid: g0 }, { units: units1, grid: g1 }], 150);
  if (b.over && b.reason !== '' && !b.reason.startsWith('Time')) ok(`both walled in: decided by combat in ${Math.round(b.time)}s`);
  else bad(`both walled in: stalled (${b.reason || 'no result'} after ${Math.round(b.time)}s, kills ${b.stats.kills})`);
}

// 4. A golem behind a wall with a gap too narrow for it must still reach the enemy.
{
  const g0 = grid();
  wallRect(g0, 40, 0, 41, 33);
  wallRect(g0, 40, 36, 41, ROWS - 1); // 2-tile (20px) gap at rows 34-35; golem is 36px wide
  const units0 = [[G, 200, 350]];
  const units1 = [];
  for (let i = 0; i < 6; i++) units1.push([M, 1100, 300 + i * 20]);
  const b = run([{ units: units0, grid: g0 }, { units: units1, grid: grid() }], 90);
  if (b.over && b.winner === 0) ok(`golem behind a narrow gap reached the enemy (${Math.round(b.time)}s)`);
  else bad(`golem behind a narrow gap: ${b.reason || 'no result'} after ${Math.round(b.time)}s, kills ${b.stats.kills}`);
}

// 5. A wall with a normal-sized gap: armies path through the gap.
{
  const g1 = grid();
  wallRect(g1, 75, 0, 76, 40);
  wallRect(g1, 75, 46, 76, ROWS - 1); // 5-tile gap
  const units0 = [];
  for (let i = 0; i < 30; i++) units0.push([M, 150 + (i % 6) * 20, 200 + Math.floor(i / 6) * 30]);
  const units1 = [];
  for (let i = 0; i < 20; i++) units1.push([M, 1150, 150 + i * 22]);
  const b = run([{ units: units0, grid: grid() }, { units: units1, grid: g1 }], 120);
  if (b.over && !b.reason.startsWith('Time') && b.broken.length <= 3) ok(`armies path through a gap (${Math.round(b.time)}s, ${b.broken.length} wall tiles broken)`);
  else bad(`gap pathing: ${b.reason || 'no result'} after ${Math.round(b.time)}s, kills ${b.stats.kills}`);
}

console.log(failed ? `\n${failed} wall test(s) failed` : '\nAll wall tests passed');
process.exitCode = failed ? 1 : 0;
