// The "server" for one room. It runs in the host player's browser, normally inside
// a Web Worker (host/worker.js) so background-tab throttling doesn't slow the battle.
//
// Connections are identified by string ids. The host's own player uses LOCAL_ID;
// each friend who connects over WebRTC gets their own id. The transport moves the
// bytes: transport.send(id, stringOrBytes) and transport.close(id, reason).

import { Room } from './room.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';

export const LOCAL_ID = 'local';
const TIMEOUT_MS = 15000; // clients ping every 3 s

export class Hub {
  constructor(code, transport) {
    this.transport = transport;
    this.conns = new Map(); // id -> { id, player, lastSeen, handle }
    this.room = new Room(code, () => {});
    this.watchdog = setInterval(() => this.checkTimeouts(), 3000);
  }

  open(id) {
    if (this.conns.has(id)) return;
    const c = { id, player: null, lastSeen: Date.now(), closed: false };
    c.handle = {
      send: (data) => { if (!c.closed) this.transport.send(id, data); },
      close: (reason) => {
        if (c.closed) return;
        this.transport.close(id, reason);
        this.closed(id);
      },
    };
    this.conns.set(id, c);
  }

  message(id, text) {
    const c = this.conns.get(id);
    if (!c || typeof text !== 'string' || text.length > 4 * 1024 * 1024) return;
    c.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (!c.player) {
      if (msg.t !== 'join') return;
      if (msg.v !== PROTOCOL_VERSION) {
        c.handle.send(JSON.stringify({ t: 'error', msg: 'This room runs a different version of the game. Both players need to refresh the page (Ctrl+Shift+R).', fatal: true }));
        setTimeout(() => c.handle.close('version'), 500);
        return;
      }
      const name = String(msg.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20);
      const res = this.room.join(c.handle, name, typeof msg.token === 'string' ? msg.token : null);
      if (typeof res === 'string') {
        c.handle.send(JSON.stringify({ t: 'error', msg: res, fatal: true }));
        setTimeout(() => c.handle.close('full'), 500);
        return;
      }
      c.player = res;
      this.room.welcome(res);
      return;
    }
    try {
      this.room.handle(c.player, msg);
    } catch (err) {
      console.error('message handler error', err);
    }
  }

  closed(id) {
    const c = this.conns.get(id);
    if (!c) return;
    c.closed = true;
    this.conns.delete(id);
    if (c.player && c.player.conn === c.handle) this.room.disconnect(c.player);
  }

  checkTimeouts() {
    const now = Date.now();
    for (const c of [...this.conns.values()]) {
      if (c.id !== LOCAL_ID && now - c.lastSeen > TIMEOUT_MS) c.handle.close('timeout');
    }
  }

  /** Tell every remote player the room is closing, then stop everything. */
  shutdown(msg = 'The host closed the room') {
    clearInterval(this.watchdog);
    const s = JSON.stringify({ t: 'error', msg, fatal: true });
    for (const c of this.conns.values()) if (c.id !== LOCAL_ID) c.handle.send(s);
    this.room.destroy();
  }
}
