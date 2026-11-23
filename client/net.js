// Peer-to-peer networking. There is no game server: the host's browser runs the room
// (host/hub.js, in a Web Worker) and friends connect to it directly over WebRTC.
// PeerJS's free public broker is only used to introduce the two browsers; game data
// goes straight between them (or through PeerJS's TURN relay when NATs are strict).
//
// Both transports expose the same interface to main.js:
//   connect(), close(), send(msg), connected
//   handlers: onOpen(), onClose(), onMessage(msg), onSnapshot(snap), onFatal(text)

import { decodeSnapshot } from '../shared/protocol.js';

const PEER_PREFIX = 'scribble-siege-room-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const LOCAL_ID = 'local';
const PING_MS = 3000;
const SILENCE_MS = 15000; // no message from the host for this long = connection lost
const DIAL_TIMEOUT_MS = 15000;
const BROKER_TIMEOUT_MS = 12000;
const GIVE_UP_MS = 60000;
const MAX_BUFFERED = 1 << 20; // skip snapshots to a peer whose send buffer is this full
const NO_BROKER = "Couldn't reach the matchmaking server. Check your internet connection.";
const NO_WEBRTC = "This browser doesn't support WebRTC, which the game needs.";

export function newRoomCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return c;
}

function peerLib() {
  if (typeof window.Peer !== 'function') throw new Error('PeerJS failed to load');
  return window.Peer;
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
}

const BROKER_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable']);

class BaseNet {
  constructor(handlers) {
    this.handlers = handlers;
    this.connected = false;
    this.closed = false;
  }

  deliver(data) {
    if (this.closed) return;
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this.handlers.onMessage?.(msg);
      return;
    }
    const ab = toArrayBuffer(data);
    const snap = ab && decodeSnapshot(ab);
    if (snap) this.handlers.onSnapshot?.(snap);
  }

  fatal(text) {
    if (this.closed) return;
    this.closed = true;
    this.cleanup?.();
    this.handlers.onFatal?.(text);
  }
}

// ---------------------------------------------------------------------------
// Host: registers the room code with the broker and runs the room locally.
// ---------------------------------------------------------------------------
export class HostNet extends BaseNet {
  /** code: reuse this room code (after a reload); otherwise a new one is picked. */
  constructor(handlers, code = null) {
    super(handlers);
    this.code = code || newRoomCode();
    this.keepCode = !!code;
    this.attempts = 0;
    this.peer = null;
    this.hub = null;
    this.conns = new Map(); // id -> PeerJS DataConnection
    this.nextId = 1;
  }

  connect() {
    let Peer;
    try { Peer = peerLib(); } catch (e) { this.fatal(e.message); return; }
    const peer = new Peer(PEER_PREFIX + this.code, { debug: 0 });
    this.peer = peer;
    let opened = false;
    const brokerTimer = setTimeout(() => {
      if (!opened && this.peer === peer) this.fatal(NO_BROKER);
    }, BROKER_TIMEOUT_MS);

    peer.on('open', () => {
      opened = true;
      clearTimeout(brokerTimer);
      if (this.closed) return;
      if (!this.hub) this.startHub();
      this.connected = true;
      this.hub.post({ k: 'open', id: LOCAL_ID });
      this.handlers.onOpen?.();
    });
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => {
      // Lost the broker. Players already in the room stay connected; new ones can't join until this recovers.
      setTimeout(() => { if (!this.closed && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
    });
    peer.on('error', (err) => {
      if (this.closed || this.peer !== peer) return;
      if (err.type === 'unavailable-id' && !opened) {
        clearTimeout(brokerTimer);
        peer.destroy();
        this.attempts++;
        // After a reload the broker may hold our old id for a few seconds.
        if (this.keepCode && this.attempts < 6) {
          setTimeout(() => { if (!this.closed) this.connect(); }, 2000);
        } else {
          this.keepCode = false;
          this.code = newRoomCode();
          this.connect();
        }
        return;
      }
      if (err.type === 'browser-incompatible') this.fatal(NO_WEBRTC);
      else if (!opened && BROKER_ERRORS.has(err.type)) this.fatal(NO_BROKER);
    });
  }

  startHub() {
    const onHubMessage = (m) => {
      if (m.k === 'send') this.toPlayer(m.id, m.data);
      else if (m.k === 'close') this.dropConn(m.id);
    };
    try {
      const worker = new Worker(new URL('../host/worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => onHubMessage(e.data);
      worker.onerror = (e) => console.error('host worker error', e.message);
      this.hub = { post: (m) => worker.postMessage(m), stop: () => worker.terminate() };
    } catch {
      // No module-worker support: run the room on the main thread instead.
      const pending = [];
      let hub = null;
      const dispatch = (h, m) => {
        if (m.k === 'open') h.open(m.id);
        else if (m.k === 'msg') h.message(m.id, m.data);
        else if (m.k === 'close') h.closed(m.id);
        else if (m.k === 'shutdown') h.shutdown(m.msg);
      };
      this.hub = {
        post: (m) => { if (m.k === 'init') return; if (hub) dispatch(hub, m); else pending.push(m); },
        stop: () => { hub = null; },
      };
      import('../host/hub.js').then(({ Hub }) => {
        hub = new Hub(this.code, {
          send: (id, data) => queueMicrotask(() => onHubMessage({ k: 'send', id, data })),
          close: (id, reason) => queueMicrotask(() => onHubMessage({ k: 'close', id, reason })),
        });
        for (const m of pending) dispatch(hub, m);
        pending.length = 0;
      });
    }
    this.hub.post({ k: 'init', code: this.code });
  }

  accept(conn) {
    if (this.closed || !this.hub) { conn.close(); return; }
    const id = `p${this.nextId++}`;
    conn.on('open', () => {
      this.conns.set(id, conn);
      this.hub.post({ k: 'open', id });
    });
    conn.on('data', (data) => {
      if (typeof data === 'string') this.hub.post({ k: 'msg', id, data });
    });
    const gone = () => {
      if (this.conns.get(id) !== conn) return;
      this.conns.delete(id);
      this.hub?.post({ k: 'close', id });
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  toPlayer(id, data) {
    // Remote sends still go out while closing, so guests hear "the host closed the room".
    if (id === LOCAL_ID) { this.deliver(data); return; }
    const conn = this.conns.get(id);
    if (!conn || !conn.open) return;
    // Snapshots are disposable: drop them rather than let them pile up on a slow link.
    if (typeof data !== 'string' && (conn.dataChannel?.bufferedAmount || 0) > MAX_BUFFERED) return;
    try { conn.send(data); } catch (e) { console.warn('send failed', e); }
  }

  dropConn(id) {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    // Give a final message (e.g. "kicked") a moment to arrive before closing.
    setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 400);
  }

  send(msg) {
    if (this.hub && this.connected) this.hub.post({ k: 'msg', id: LOCAL_ID, data: JSON.stringify(msg) });
  }

  cleanup() {
    this.connected = false;
    const hub = this.hub;
    const peer = this.peer;
    if (hub) hub.post({ k: 'shutdown', msg: 'The host closed the room' });
    // Let the "room closed" message reach the guest, then tear down.
    setTimeout(() => {
      hub?.stop();
      for (const c of this.conns.values()) { try { c.close(); } catch { /* ignore */ } }
      this.conns.clear();
      peer?.destroy();
    }, 500);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Guest: dials the host's room code and reconnects if the link drops.
// ---------------------------------------------------------------------------
export class GuestNet extends BaseNet {
  constructor(handlers, code) {
    super(handlers);
    this.code = code;
    this.peer = null;
    this.conn = null;
    this.queue = [];
    this.everConnected = false;
    this.dialFails = 0;
    this.retry = 0;
    this.dropSince = 0;
    this.lastRx = 0;
    this.pingTimer = null;
    this.retryTimer = null;
  }

  connect() {
    if (this.closed) return;
    let Peer;
    try { Peer = peerLib(); } catch (e) { this.fatal(e.message); return; }
    if (this.peer && !this.peer.destroyed && this.peer.open) { this.dial(); return; }
    if (this.peer) this.peer.destroy();
    const peer = new Peer({ debug: 0 });
    this.peer = peer;
    let opened = false;
    const brokerTimer = setTimeout(() => {
      if (opened || this.peer !== peer) return;
      if (this.everConnected) { peer.destroy(); this.peer = null; this.scheduleRetry(); } else this.fatal(NO_BROKER);
    }, BROKER_TIMEOUT_MS);
    peer.on('open', () => {
      opened = true;
      clearTimeout(brokerTimer);
      if (!this.closed && this.peer === peer) this.dial();
    });
    peer.on('disconnected', () => {
      setTimeout(() => { if (!this.closed && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
    });
    peer.on('error', (err) => {
      if (this.closed || this.peer !== peer) return;
      if (err.type === 'peer-unavailable') {
        // Nobody is hosting that code (yet). During a reconnect the host may be reloading.
        if (!this.everConnected) this.fatal('No room with that code. Check it, or ask your friend to create the room again.');
        else this.scheduleRetry();
        return;
      }
      if (err.type === 'browser-incompatible') { this.fatal(NO_WEBRTC); return; }
      if (!opened && BROKER_ERRORS.has(err.type)) {
        clearTimeout(brokerTimer);
        peer.destroy();
        this.peer = null;
        if (this.everConnected) this.scheduleRetry(); else this.fatal(NO_BROKER);
      }
    });
  }

  dial() {
    if (this.closed) return;
    if (this.conn) { const old = this.conn; this.conn = null; try { old.close(); } catch { /* ignore */ } }
    const conn = this.peer.connect(PEER_PREFIX + this.code, { serialization: 'raw', reliable: true });
    this.conn = conn;
    const dialTimer = setTimeout(() => {
      if (this.conn === conn && !this.connected) this.onDrop(conn, true);
    }, DIAL_TIMEOUT_MS);
    conn.on('open', () => {
      clearTimeout(dialTimer);
      if (this.closed || this.conn !== conn) return;
      this.connected = true;
      this.everConnected = true;
      this.retry = 0;
      this.dialFails = 0;
      this.dropSince = 0;
      this.lastRx = Date.now();
      this.handlers.onOpen?.();
      for (const m of this.queue) conn.send(m);
      this.queue.length = 0;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.heartbeat(conn), PING_MS);
    });
    conn.on('data', (data) => {
      if (this.conn !== conn) return;
      this.lastRx = Date.now();
      this.deliver(data);
    });
    conn.on('close', () => { clearTimeout(dialTimer); this.onDrop(conn); });
    conn.on('error', () => { clearTimeout(dialTimer); this.onDrop(conn); });
  }

  heartbeat(conn) {
    if (this.conn !== conn || !this.connected) return;
    if (Date.now() - this.lastRx > SILENCE_MS) { this.onDrop(conn); return; }
    try { conn.send(JSON.stringify({ t: 'ping', id: 0 })); } catch { /* ignore */ }
  }

  onDrop(conn, dialFailed = false) {
    if (this.closed || this.conn !== conn) return;
    this.conn = null;
    try { conn.close(); } catch { /* ignore */ }
    clearInterval(this.pingTimer);
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.handlers.onClose?.();
    if (dialFailed && !this.everConnected && ++this.dialFails >= 2) {
      this.fatal("Couldn't connect to the host. One of your networks may be blocking peer-to-peer connections.");
      return;
    }
    this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.closed) return;
    if (!this.dropSince) this.dropSince = Date.now();
    if (this.everConnected && Date.now() - this.dropSince > GIVE_UP_MS) {
      this.fatal('Lost the connection to the host');
      return;
    }
    clearTimeout(this.retryTimer);
    const delay = Math.min(5000, 600 * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  cleanup() {
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.connected = false;
    const conn = this.conn;
    this.conn = null;
    if (conn) { try { conn.close(); } catch { /* ignore */ } }
    if (this.peer) { this.peer.destroy(); this.peer = null; }
  }

  send(msg) {
    const s = JSON.stringify(msg);
    if (this.conn && this.connected) {
      try { this.conn.send(s); } catch { this.queue.push(s); }
    } else if (!this.closed) {
      this.queue.push(s);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.cleanup();
  }
}

/** Buffers battle snapshots and interpolates between them for smooth rendering. */
export class SnapshotBuffer {
  constructor(tickMs, delayMs) {
    this.tickMs = tickMs;
    this.delayMs = delayMs;
    this.reset();
  }

  reset() {
    this.buf = [];
    this.offset = null;
    this.events = [];
  }

  push(snap) {
    const now = performance.now();
    const est = now - snap.tick * this.tickMs;
    // Track the lowest-latency arrival; hard-resync after a long stall (e.g. the pre-battle countdown).
    if (this.offset === null || est < this.offset || est - this.offset > 300) this.offset = est;
    else this.offset += (est - this.offset) * 0.02;
    const last = this.buf[this.buf.length - 1];
    if (last && snap.tick <= last.tick) return;
    this.buf.push(snap);
    if (this.buf.length > 40) this.buf.shift();
  }

  pushEvents(tick, events) {
    for (const e of events) this.events.push({ tick, e });
  }

  renderTick(now = performance.now()) {
    if (this.offset === null) return 0;
    return (now - this.offset - this.delayMs) / this.tickMs;
  }

  /** Events whose tick has been reached by the render clock. */
  takeDueEvents(rt) {
    if (!this.events.length) return [];
    const due = [];
    let i = 0;
    while (i < this.events.length && this.events[i].tick <= rt) due.push(this.events[i++].e);
    if (i) this.events.splice(0, i);
    // Never let events lag far behind (e.g. after a tab was hidden).
    if (this.events.length > 600) { due.push(...this.events.map((x) => x.e)); this.events.length = 0; }
    return due;
  }

  latest() {
    return this.buf[this.buf.length - 1] || null;
  }

  sample(now = performance.now()) {
    const n = this.buf.length;
    if (!n) return null;
    const rt = this.renderTick(now);
    let a = this.buf[0];
    let b = this.buf[0];
    if (rt >= this.buf[n - 1].tick) {
      a = b = this.buf[n - 1];
    } else if (rt > this.buf[0].tick) {
      for (let i = 0; i < n - 1; i++) {
        if (this.buf[i].tick <= rt && rt < this.buf[i + 1].tick) { a = this.buf[i]; b = this.buf[i + 1]; break; }
      }
    }
    const span = b.tick - a.tick;
    const t = span > 0 ? Math.min(1, Math.max(0, (rt - a.tick) / span)) : 1;
    const units = [];
    for (const [id, ub] of b.units) {
      const ua = a.units.get(id);
      if (!ua || t >= 1) { units.push(ub); continue; }
      let dh = ub.heading - ua.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      units.push({
        ...ub,
        x: ua.x + (ub.x - ua.x) * t,
        y: ua.y + (ub.y - ua.y) * t,
        heading: ua.heading + dh * t,
        attack: ua.attack + (ub.attack - ua.attack) * t,
      });
    }
    const projectiles = [];
    for (const [id, pb] of b.projectiles) {
      const pa = a.projectiles.get(id);
      if (!pa || t >= 1) { projectiles.push(pb); continue; }
      projectiles.push({
        ...pb,
        x: pa.x + (pb.x - pa.x) * t,
        y: pa.y + (pb.y - pa.y) * t,
        z: pa.z + (pb.z - pa.z) * t,
      });
    }
    return { tick: rt, units, projectiles };
  }
}
