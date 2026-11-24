// End-to-end smoke test. Runs the host-side Hub in-process with two fake players
// wired to it, and plays a full match (lobby -> draw -> battle -> results -> rematch).
// Also checks the local static server. No network or browser needed.
//   npm test

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hub, LOCAL_ID } from '../host/hub.js';
import { COLS, UNIT_INDEX, T, zoneCount } from '../shared/config.js';
import { encodeGrid, emptyGrid } from '../shared/draft.js';
import { decodeSnapshot, PROTOCOL_VERSION } from '../shared/protocol.js';

let failed = false;
const fail = (msg) => { console.error('FAIL:', msg); failed = true; finish(); };
const ok = (msg) => console.log('  ok -', msg);
let server = null;
function finish() {
  process.exitCode = failed ? 1 : 0;
  hub?.shutdown();
  if (server && server.exitCode === null) {
    server.once('exit', () => setTimeout(() => process.exit(process.exitCode), 50));
    server.kill();
  } else {
    setTimeout(() => process.exit(process.exitCode), 50);
  }
  setTimeout(() => process.exit(process.exitCode), 2000).unref();
}
setTimeout(() => fail('timed out'), 200000).unref();

// --- Fake transport: each connection id maps to a Client ---------------------
const clients = new Map();
const transport = {
  send(id, data) {
    const c = clients.get(id);
    // Deliver asynchronously, like a real connection.
    if (c && !c.closed) setImmediate(() => c.receive(data));
  },
  close(id, reason) {
    const c = clients.get(id);
    if (c) { c.closed = true; c.closeReason = reason; }
  },
};
const hub = new Hub('TEST', transport);
// Like real clients, every connected test client pings every 3 s so the watchdog keeps it.
const heartbeat = setInterval(() => {
  for (const c of clients.values()) if (!c.closed && c.id !== LOCAL_ID) hub.message(c.id, JSON.stringify({ t: 'ping', id: 0 }));
}, 3000);
heartbeat.unref();

class Client {
  constructor(name, id) {
    this.name = name;
    this.id = id;
    this.msgs = [];
    this.snapshots = 0;
    this.waiters = [];
    this.closed = false;
    clients.set(id, this);
    hub.open(id);
  }
  receive(data) {
    if (typeof data !== 'string') {
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const s = decodeSnapshot(ab);
      if (s) { this.snapshots++; this.lastSnap = s; }
      return;
    }
    const m = JSON.parse(data);
    this.msgs.push(m);
    this.waiters = this.waiters.filter((w) => !(w.pred(m) && (w.res(m), true)));
  }
  send(m) { hub.message(this.id, JSON.stringify(m)); }
  drop() { this.closed = true; hub.closed(this.id); }
  wait(pred, label, ms = 10000) {
    const found = this.msgs.find(pred);
    if (found) { this.msgs.splice(this.msgs.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name} waiting for ${label}`)), ms);
      this.waiters.push({ pred, res: (m) => { clearTimeout(t); this.msgs.splice(this.msgs.indexOf(m), 1); res(m); } });
    });
  }
}

function army(side, keys, count) {
  const units = [];
  for (let i = 0; i < count; i++) {
    const type = UNIT_INDEX[keys[i % keys.length]];
    const x = side === 0 ? 80 + (i % 10) * 24 : 1200 - (i % 10) * 24;
    const y = 200 + Math.floor(i / 10) * 26;
    units.push([type, x, y]);
  }
  return units;
}

try {
  // The host's own player uses the local connection id.
  const a = new Client('A', LOCAL_ID);
  a.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Alice' });
  const ja = await a.wait((m) => m.t === 'joined', 'joined');
  if (ja.side !== 0 || !ja.room.players[0].host) fail('host should be side 0');
  ok(`room ${ja.room.code} opened, Alice is host on side ${ja.side}`);

  let b = new Client('B', 'p1');
  b.send({ t: 'draft', units: [] }); // before joining: ignored
  b.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Bob' });
  let jb = await b.wait((m) => m.t === 'joined', 'joined');
  if (jb.side !== 1 || zoneCount(jb.room.layout) !== 2) fail('Bob should be side 1 on the 1v1 map');
  ok('Bob joined as side 1 (1v1 map)');

  // --- Three players: free-for-all map -------------------------------------------
  const c = new Client('C', 'p2');
  c.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Carol' });
  const jc = await c.wait((m) => m.t === 'joined', 'joined');
  if (jc.side !== 2 || zoneCount(jc.room.layout) !== 3) fail(`Carol should be side 2 on the 3-way map (side ${jc.side}, layout ${jc.room.layout})`);
  ok('Carol joined as side 2; lobby switches to the 1v1v1 map');

  const d = new Client('D', 'p3');
  d.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Dave' });
  const full = await d.wait((m) => m.t === 'error', 'room full error');
  if (!full.fatal) fail('room-full error should be fatal');
  await new Promise((r) => setTimeout(r, 600));
  if (!d.closed) fail('fourth player should be disconnected');
  ok('fourth player turned away (room full)');

  const old = new Client('Old', 'p-old');
  old.send({ t: 'join', name: 'Outdated' }); // a cached old page sends no version
  const vErr = await old.wait((m) => m.t === 'error', 'version error');
  if (!vErr.fatal || !/different version/.test(vErr.msg)) fail(`outdated client should get a fatal version error (${vErr.msg})`);
  ok('client on an old version is refused with a refresh hint');

  a.send({ t: 'start' });
  const draw3 = await c.wait((m) => m.t === 'room' && m.room.phase === 'draw', '3p draw phase');
  if (zoneCount(draw3.room.layout) !== 3 || draw3.room.you !== 2) fail('3p draw should use layout 3');
  for (const x of [a, b, c]) await x.wait((m) => m.t === 'yourDraft', 'yourDraft');
  const blob = (cx, cy) => {
    const u = [];
    for (let i = 0; i < 14; i++) u.push([i % 4 === 0 ? UNIT_INDEX.archer : UNIT_INDEX.militia, cx + (i % 5) * 18 - 36, cy + Math.floor(i / 5) * 20 - 20]);
    return u;
  };
  // Alice owns the top zone: her unit at (100, 600) is in Bob's zone and must be dropped.
  a.send({ t: 'draft', units: [...blob(640, 110), [UNIT_INDEX.militia, 100, 600]], terrain: encodeGrid(emptyGrid()) });
  const ack3 = await a.wait((m) => m.t === 'draftAck', 'draftAck');
  if (ack3.units !== 14) fail(`3p zone filter: expected 14 units, got ${ack3.units}`);
  b.send({ t: 'draft', units: blob(220, 600), terrain: encodeGrid(emptyGrid()) });
  c.send({ t: 'draft', units: blob(1060, 600), terrain: encodeGrid(emptyGrid()) });
  await b.wait((m) => m.t === 'draftAck', 'draftAck');
  await c.wait((m) => m.t === 'draftAck', 'draftAck');
  ok('3p drafts accepted, out-of-zone unit dropped');
  for (const x of [a, b, c]) x.send({ t: 'ready', ready: true });
  const bs3 = await c.wait((m) => m.t === 'battleStart', '3p battleStart');
  if (bs3.drafts.length !== 3 || zoneCount(bs3.layout) !== 3) fail('3p battle should have 3 drafts');
  const end3 = await a.wait((m) => m.t === 'battleEnd', '3p battleEnd', 190000);
  const r3 = end3.result;
  if (r3.sides !== 3 || r3.survivors.length !== 3) fail('3p result should cover 3 sides');
  ok(`1v1v1 battle over: winner=${r3.winner} (${r3.reason}) in ${r3.time}s, kills ${r3.kills}`);
  if (c.snapshots < 10) fail('side 2 got too few snapshots');
  if (c.lastSnap && ![...c.lastSnap.units.values()].every((u) => u.side >= 0 && u.side <= 2)) fail('bad side in snapshot');

  // Seats stay contiguous: kicking side 1 moves Carol to side 1.
  for (const x of [a, b, c]) x.msgs.length = 0; // drop stale room updates from before the match
  a.send({ t: 'lobby' });
  await a.wait((m) => m.t === 'room' && m.room.phase === 'lobby', 'lobby');
  a.send({ t: 'kick', side: 1 });
  await b.wait((m) => m.t === 'kicked', 'Bob kicked');
  const moved = await c.wait((m) => m.t === 'room' && m.room.you === 1 && zoneCount(m.room.layout) === 2, 'Carol moved to seat 1');
  if (moved.room.players[1].name !== 'Carol') fail('seat 1 should be Carol');
  ok('kicking seat 1 shifts Carol to seat 1 and the lobby back to 1v1');

  // Bob comes back (seat 2), then Carol is kicked, so Bob slides to seat 1 for the 1v1 tests.
  b = new Client('B', 'p4');
  b.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Bob' });
  jb = await b.wait((m) => m.t === 'joined', 'joined');
  a.send({ t: 'kick', side: 1 });
  await c.wait((m) => m.t === 'kicked', 'Carol kicked');
  await b.wait((m) => m.t === 'room' && m.room.you === 1, 'Bob moved to seat 1');
  ok('back to 1v1 with Bob in seat 1');

  // Guest cannot change settings; host can.
  b.send({ t: 'settings', settings: { budget: 9999 } });
  a.send({ t: 'settings', settings: { budget: 60, visibility: 'visible', drawTime: 0, costs: { units: { militia: 1.5 } } } });
  const rs = await b.wait((m) => m.t === 'room' && m.room.settings.budget === 60, 'settings broadcast');
  if (rs.room.settings.costs.units.militia !== 1.5) fail('custom cost not applied');
  ok('host settings applied (budget 60, militia 1.5, visible)');

  b.send({ t: 'start' }); // ignored: not host
  a.send({ t: 'start' });
  await a.wait((m) => m.t === 'room' && m.room.phase === 'draw', 'draw phase');
  await a.wait((m) => m.t === 'yourDraft', 'yourDraft');
  await b.wait((m) => m.t === 'yourDraft', 'yourDraft');
  ok('draw phase started');

  // Over-budget draft is rejected.
  a.send({ t: 'draft', units: army(0, ['golem'], 10), terrain: encodeGrid(emptyGrid()) });
  await a.wait((m) => m.t === 'draftReject', 'draftReject');
  ok('over-budget draft rejected');

  // Units in the wrong zone are dropped. Terrain is costed.
  const ga = emptyGrid();
  for (let r = 20; r < 50; r++) ga[r * COLS + 30] = T.WALL; // 30 tiles * 0.25 = 7.5
  const unitsA = [...army(0, ['militia', 'archer', 'spear', 'medic'], 16), [0, 1100, 300]];
  a.send({ t: 'draft', units: unitsA, terrain: encodeGrid(ga) });
  const ack = await a.wait((m) => m.t === 'draftAck', 'draftAck');
  if (ack.units !== 16) fail(`expected 16 units after zone filter, got ${ack.units}`);
  ok(`draft accepted: ${ack.units} units, cost ${ack.cost}`);
  await b.wait((m) => m.t === 'opDraft' && m.units.length === 16, 'opDraft relay with 16 units');
  ok('visible mode relays draft to opponent');

  b.send({ t: 'draft', units: army(1, ['hound', 'rider', 'bomber'], 9), terrain: encodeGrid(emptyGrid()) });
  await b.wait((m) => m.t === 'draftAck', 'draftAck');

  a.send({ t: 'ready', ready: true });
  b.send({ t: 'ready', ready: true });
  const bs = await a.wait((m) => m.t === 'battleStart', 'battleStart');
  ok(`battle starting with ${bs.drafts[0].units.length} vs ${bs.drafts[1].units.length}`);

  // Pings keep the guest alive through the battle; they get a pong back.
  const pinger = setInterval(() => b.send({ t: 'ping', id: 0 }), 3000);
  const end = await a.wait((m) => m.t === 'battleEnd', 'battleEnd', 190000);
  clearInterval(pinger);
  const r = end.result;
  ok(`battle over: winner=${r.winner} (${r.reason}) in ${r.time}s, survivors ${r.survivors}, kills ${r.kills}`);
  if (a.snapshots < 10 || b.snapshots < 10) fail('too few snapshots');
  ok(`snapshots received: A=${a.snapshots} B=${b.snapshots}`);
  if (!b.msgs.some((m) => m.t === 'pong') && !(await b.wait((m) => m.t === 'pong', 'pong', 100).catch(() => null))) {
    // pongs may already have been consumed; ping once more to be sure
    b.send({ t: 'ping', id: 1 });
    await b.wait((m) => m.t === 'pong', 'pong');
  }
  ok('guest pings answered');

  a.send({ t: 'rematch' });
  const yd = await a.wait((m) => m.t === 'yourDraft', 'rematch draft');
  if (yd.units.length !== 16) fail('army not kept for rematch');
  ok('rematch keeps the previous army');

  // Reconnect with token keeps the seat.
  b.drop();
  await a.wait((m) => m.t === 'room' && m.room.players[1] && !m.room.players[1].connected, 'Bob shown disconnected');
  const b2 = new Client('B2', 'p13');
  b2.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Bob', token: jb.token });
  const rj = await b2.wait((m) => m.t === 'joined', 'rejoin');
  if (rj.side !== 1) fail('rejoin lost seat');
  await b2.wait((m) => m.t === 'yourDraft', 'draft after rejoin');
  ok('reconnect with token restores seat and draft');

  // Back to lobby, then kick.
  // The guest can exit mid-battle; both go back to the lobby.
  b2.send({ t: 'draft', units: army(1, ['militia'], 5), terrain: encodeGrid(emptyGrid()) });
  await b2.wait((m) => m.t === 'draftAck', 'draftAck');
  a.send({ t: 'ready', ready: true });
  b2.send({ t: 'ready', ready: true });
  await a.wait((m) => m.t === 'battleStart', 'second battleStart');
  b2.send({ t: 'lobby' });
  const exitNote = await a.wait((m) => m.t === 'notice', 'exit notice');
  await a.wait((m) => m.t === 'room' && m.room.phase === 'lobby', 'lobby');
  ok(`guest exited mid-battle: "${exitNote.msg}"`);
  a.send({ t: 'kick' });
  await b2.wait((m) => m.t === 'kicked', 'kicked');
  if (!b2.closed) fail('kicked player not disconnected');
  const ar = await a.wait((m) => m.t === 'room' && !m.room.players[1], 'slot freed');
  if (!ar) fail('slot not freed');
  ok('host can kick the guest');

  // Leaving on purpose frees the seat straight away (no 2-minute hold).
  const lv = new Client('LV', 'p16');
  lv.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Leaver' });
  await lv.wait((m) => m.t === 'joined', 'joined');
  lv.send({ t: 'leave' });
  if (hub.room.players[1]) fail('seat not freed after leave');
  ok('leaving frees the seat immediately');

  // A silent guest is timed out by the watchdog.
  const d2 = new Client('D2', 'p14');
  d2.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Dave' });
  await d2.wait((m) => m.t === 'joined', 'joined');
  hub.conns.get('p14').lastSeen = Date.now() - 20000;
  hub.checkTimeouts();
  if (!d2.closed || hub.conns.has('p14')) fail('silent guest not timed out');
  ok('silent guest timed out');
  // Their seat is held for a reconnect; the host can free it by kicking.
  a.send({ t: 'kick' });
  await a.wait((m) => m.t === 'room' && !m.room.players[1], 'held seat freed');

  // Shutting the room down tells the remaining guest.
  const e = new Client('E', 'p15');
  e.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Eve' });
  await e.wait((m) => m.t === 'joined', 'joined');
  hub.shutdown('The host closed the room');
  const bye = await e.wait((m) => m.t === 'error' && m.fatal, 'room closed');
  ok(`shutdown notifies guest: "${bye.msg}"`);

  // Static dev server.
  const PORT = 3000 + Math.floor(Math.random() * 2000) + 1000;
  server = spawn(process.execPath, [fileURLToPath(new URL('../tools/serve.js', import.meta.url))], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res) => server.stdout.on('data', (x) => { if (String(x).includes('running')) res(); }));
  const base = `http://localhost:${PORT}`;
  const html = await fetch(`${base}/`).then((x) => x.text());
  const worker = await fetch(`${base}/host/worker.js`).then((x) => x.status);
  const peer = await fetch(`${base}/client/vendor/peerjs.min.js`).then((x) => x.status);
  const escape = await fetch(`${base}/shared/..%2F..%2F..%2Fsecret.txt`).then((x) => x.status);
  if (!html.includes('Scribble Siege') || !html.includes('client/main.js')) fail('index.html');
  if (worker !== 200 || peer !== 200) fail('module files not served');
  if (escape === 200) fail('path escape not blocked');
  ok('static files served, path escape blocked');

  console.log(failed ? 'FAILED' : '\nAll smoke tests passed');
  finish();
} catch (err) {
  fail(err.message);
}
