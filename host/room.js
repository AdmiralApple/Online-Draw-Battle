// A game room, run inside the host player's browser (in a Web Worker).
// Up to three player seats, lobby settings, and the phase state machine
//   lobby -> draw -> battle -> results -> (draw | lobby)

import {
  defaultSettings, sanitizeSettings, VISIBILITY, TICK_RATE, SNAPSHOT_EVERY, MAX_PLAYERS, layoutFor,
} from '../shared/config.js';
import {
  validateDraft, trimToBudget, encodeGrid, emptyGrid, draftCost, clipDraftToZone,
} from '../shared/draft.js';
import { encodeSnapshot } from '../shared/protocol.js';
import { Battle } from './sim.js';

const RECONNECT_GRACE_MS = 2 * 60 * 1000;
const COUNTDOWN_MS = 3000;
const RELAY_THROTTLE_MS = 200;

function newToken() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty;
    // Index = side (seat). Seats are kept contiguous: 2 players use 0-1, 3 players 0-2.
    this.players = Array(MAX_PLAYERS).fill(null);
    this.layout = 2; // map layout of the current match (2 or 3 zones)
    this.hostToken = null;
    this.settings = defaultSettings();
    this.phase = 'lobby';
    this.drawDeadline = 0;
    this.battleStartsAt = 0;
    this.battle = null;
    this.result = null;
    this.timers = new Set();
    this.loop = null;
  }

  // --- Membership --------------------------------------------------------------
  /**
   * conn: { send(stringOrBytes), close(reason) }.
   * Returns the player record, or an error string.
   */
  join(conn, name, token) {
    // Rejoin an existing slot by token.
    if (token) {
      const p = this.players.find((q) => q && q.token === token);
      if (p) {
        if (p.conn && p.conn !== conn) { try { p.conn.close('replaced'); } catch { /* ignore */ } }
        p.conn = conn;
        p.connected = true;
        if (name) p.name = name;
        clearTimeout(p.dropTimer);
        return p;
      }
    }
    const side = this.players.findIndex((q) => q === null);
    if (side < 0) return 'Room is full';
    const p = {
      token: newToken(),
      name: (name || `Player ${side + 1}`).slice(0, 20),
      side,
      conn,
      connected: true,
      ready: false,
      draft: { units: [], grid: emptyGrid(), cost: 0 },
      lastRelay: 0,
      relayTimer: null,
      dropTimer: null,
    };
    this.players[side] = p;
    if (!this.hostToken) this.hostToken = p.token;
    return p;
  }

  disconnect(p) {
    if (this.players[p.side] !== p) return; // already removed
    p.connected = false;
    p.conn = null;
    p.dropTimer = setTimeout(() => this.remove(p), RECONNECT_GRACE_MS);
    this.broadcastRoom();
    if (this.players.every((q) => !q || !q.connected)) {
      // Everyone gone: stop simulating, keep the room around for the grace period.
      this.stopLoop();
    }
  }

  remove(p) {
    if (this.players[p.side] !== p) return; // already removed
    clearTimeout(p.dropTimer);
    clearTimeout(p.relayTimer);
    this.players[p.side] = null;
    // Close the gap so seats stay contiguous (seat numbers pick the map zones).
    const left = this.players.filter(Boolean);
    this.players = Array(MAX_PLAYERS).fill(null);
    left.forEach((q, i) => { q.side = i; this.players[i] = q; });
    if (this.hostToken === p.token) this.hostToken = left.length ? left[0].token : null;
    if (!left.length) {
      this.destroy();
      return;
    }
    // Losing a player mid-game sends everyone back to the lobby.
    if (this.phase !== 'lobby') this.toLobby(`${p.name} left the game`);
    else this.broadcastRoom();
  }

  activePlayers() {
    return this.players.filter(Boolean);
  }

  destroy() {
    this.stopLoop();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.onEmpty(this);
  }

  isHost(p) { return p && p.token === this.hostToken; }

  /** Bring a newly (re)connected player up to date with whatever phase we're in. */
  welcome(p) {
    this.send(p, { t: 'joined', token: p.token, side: p.side, room: { ...this.publicState(), you: p.side } });
    this.broadcastRoom();
    if (this.phase === 'draw') {
      this.send(p, { t: 'yourDraft', units: p.draft.units, terrain: encodeGrid(p.draft.grid), cost: p.draft.cost });
      if (this.settings.visibility === VISIBILITY.VISIBLE) {
        for (const q of this.activePlayers()) if (q !== p) this.sendDraftTo(q, p);
      }
    } else if (this.phase === 'battle' && this.battle) {
      this.send(p, {
        t: 'battleStart', startsAt: this.battleStartsAt, serverNow: Date.now(), drafts: this.battleDrafts,
        layout: this.layout, broken: this.battle.broken,
      });
      if (!this.loop && Date.now() >= this.battleStartsAt) this.startLoop();
    }
  }

  // --- Messaging ------------------------------------------------------------------
  send(p, msg) {
    if (p && p.conn) p.conn.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  sendBinary(p, data) {
    if (p && p.conn) p.conn.send(data);
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of this.players) this.send(p, s);
  }

  publicState() {
    return {
      code: this.code,
      phase: this.phase,
      // In the lobby this previews the map the current players would get.
      layout: this.phase === 'lobby' ? layoutFor(this.activePlayers().length) : this.layout,
      settings: this.settings,
      drawDeadline: this.drawDeadline,
      battleStartsAt: this.battleStartsAt,
      serverNow: Date.now(),
      result: this.phase === 'results' ? this.result : null,
      players: this.players.map((p) => p && {
        name: p.name,
        side: p.side,
        ready: p.ready,
        connected: p.connected,
        host: this.isHost(p),
        cost: p.draft.cost,
        units: p.draft.units.length,
      }),
    };
  }

  broadcastRoom() {
    // Each player is told their own seat, since seats can shift when someone leaves.
    const room = this.publicState();
    for (const p of this.players) if (p) this.send(p, { t: 'room', room: { ...room, you: p.side } });
  }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // --- Incoming messages ------------------------------------------------------------
  handle(p, msg) {
    switch (msg.t) {
      case 'settings':
        if (!this.isHost(p) || this.phase !== 'lobby') return;
        this.settings = sanitizeSettings(msg.settings, this.settings);
        // Re-cost drafts kept from a previous round under the new prices.
        for (const q of this.players) {
          if (q) q.draft.cost = draftCost(q.draft.units, q.draft.grid, this.settings);
        }
        this.broadcastRoom();
        return;
      case 'start':
        if (!this.isHost(p) || this.phase !== 'lobby') return;
        if (this.activePlayers().length < 2) {
          this.send(p, { t: 'error', msg: 'Waiting for a second player' });
          return;
        }
        if (this.activePlayers().some((q) => !q.connected)) {
          this.send(p, { t: 'error', msg: 'Waiting for everyone to reconnect (or kick them)' });
          return;
        }
        this.startDraw();
        return;
      case 'draft':
        this.onDraft(p, msg);
        return;
      case 'ready':
        if (this.phase !== 'draw') return;
        p.ready = !!msg.ready;
        this.broadcastRoom();
        if (this.activePlayers().every((q) => q.ready)) this.startBattle();
        return;
      case 'rematch':
        if (!this.isHost(p) || this.phase !== 'results') return;
        this.startDraw();
        return;
      case 'lobby':
        // Either player can leave the battlefield; it sends both back to the lobby.
        if (this.phase === 'lobby') return;
        this.toLobby(this.phase === 'results' ? null : `${p.name} exited to the lobby`);
        return;
      case 'kick':
        if (!this.isHost(p) || this.phase !== 'lobby') return;
        {
          const other = Number.isInteger(msg.side)
            ? this.players[msg.side]
            : this.players.find((q) => q && q !== p);
          if (other && other !== p) {
            this.send(other, { t: 'kicked' });
            if (other.conn) try { other.conn.close('kicked'); } catch { /* ignore */ }
            this.remove(other);
          }
        }
        return;
      case 'leave':
        // Leaving on purpose frees the seat at once (a dropped connection holds it for a while).
        this.remove(p);
        if (p.conn) try { p.conn.close('left'); } catch { /* ignore */ }
        return;
      case 'ping':
        this.send(p, { t: 'pong', id: msg.id, serverNow: Date.now() });
        return;
      default:
    }
  }

  // --- Phases -------------------------------------------------------------------------
  toLobby(notice) {
    this.clearTimers();
    this.stopLoop();
    this.battle = null;
    this.phase = 'lobby';
    this.drawDeadline = 0;
    this.battleStartsAt = 0;
    for (const p of this.players) if (p) p.ready = false;
    if (notice) this.broadcast({ t: 'notice', msg: notice });
    this.broadcastRoom();
  }

  startDraw() {
    this.clearTimers();
    this.stopLoop();
    this.battle = null;
    this.result = null;
    this.phase = 'draw';
    this.battleStartsAt = 0;
    this.layout = layoutFor(this.activePlayers().length);
    for (const p of this.players) {
      if (!p) continue;
      p.ready = false;
      // Keep the last army so players can tweak it: clipped to this round's zone
      // (seats and map can change between rounds) and trimmed to the budget.
      const c = clipDraftToZone(p.draft.units, p.draft.grid, p.side, this.layout);
      p.draft = trimToBudget(c.units, c.grid, this.settings);
    }
    this.drawDeadline = this.settings.drawTime > 0 ? Date.now() + this.settings.drawTime * 1000 : 0;
    if (this.drawDeadline) this.later(() => this.startBattle(), this.settings.drawTime * 1000);
    this.broadcastRoom();
    for (const p of this.players) {
      if (!p) continue;
      this.send(p, { t: 'yourDraft', units: p.draft.units, terrain: encodeGrid(p.draft.grid), cost: p.draft.cost });
    }
    if (this.settings.visibility === VISIBILITY.VISIBLE) {
      for (const p of this.players) if (p) this.relayDraft(p, true);
    }
  }

  sendDraftTo(src, dst) {
    this.send(dst, {
      t: 'opDraft', side: src.side, units: src.draft.units, terrain: encodeGrid(src.draft.grid),
    });
  }

  onDraft(p, msg) {
    if (this.phase !== 'draw' || p.ready) return;
    const v = validateDraft(msg, p.side, this.settings, this.layout);
    if (!v.ok) {
      this.send(p, { t: 'draftReject', reason: v.error });
      return;
    }
    p.draft = { units: v.units, grid: v.grid, cost: v.cost };
    this.send(p, { t: 'draftAck', cost: v.cost, units: v.units.length, seq: msg.seq });
    if (this.settings.visibility === VISIBILITY.VISIBLE) this.relayDraft(p);
    this.scheduleRoomBroadcast();
  }

  scheduleRoomBroadcast() {
    if (this.roomBroadcastPending) return;
    this.roomBroadcastPending = true;
    this.later(() => { this.roomBroadcastPending = false; this.broadcastRoom(); }, 300);
  }

  /** Send a player's draft to every other player, throttled. */
  relayDraft(p, immediate = false) {
    if (this.activePlayers().length < 2) return;
    const now = Date.now();
    const sendIt = () => {
      p.lastRelay = Date.now();
      p.relayTimer = null;
      for (const q of this.activePlayers()) if (q !== p) this.sendDraftTo(p, q);
    };
    if (immediate || now - p.lastRelay >= RELAY_THROTTLE_MS) { clearTimeout(p.relayTimer); sendIt(); return; }
    if (!p.relayTimer) p.relayTimer = setTimeout(sendIt, RELAY_THROTTLE_MS - (now - p.lastRelay));
  }

  startBattle() {
    if (this.phase !== 'draw') return;
    this.clearTimers();
    for (const p of this.players) if (p) clearTimeout(p.relayTimer);
    const drafts = this.players.slice(0, this.layout).map((p) => (p ? p.draft : { units: [], grid: emptyGrid() }));
    const seed = (Math.random() * 2 ** 31) | 0;
    this.battle = new Battle({ drafts, settings: this.settings, seed });
    this.phase = 'battle';
    this.drawDeadline = 0;
    this.battleStartsAt = Date.now() + COUNTDOWN_MS;
    this.battleDrafts = drafts.map((d) => ({ units: d.units, terrain: encodeGrid(d.grid) }));
    this.broadcast({
      t: 'battleStart',
      startsAt: this.battleStartsAt,
      serverNow: Date.now(),
      drafts: this.battleDrafts,
      layout: this.layout,
      broken: [],
    });
    this.broadcastRoom();
    // Send one snapshot so clients can render the armies during the countdown.
    this.sendSnapshot();
    this.later(() => this.startLoop(), COUNTDOWN_MS);
  }

  startLoop() {
    this.stopLoop();
    const stepMs = 1000 / TICK_RATE;
    let next = performance.now();
    const run = () => {
      if (!this.battle) return;
      const now = performance.now();
      // Catch up if the timer fired late, but never run more than 4 ticks at once.
      let n = 0;
      while (now >= next && n < 4) {
        this.battle.step();
        if (this.battle.tick % SNAPSHOT_EVERY === 0 || this.battle.over) this.sendSnapshot();
        next += stepMs;
        n++;
        if (this.battle.over) break;
      }
      if (now - next > 250) next = now; // fell far behind, drop time
      if (this.battle.over) {
        this.finishBattle();
        return;
      }
      this.loop = setTimeout(run, Math.max(0, next - performance.now()));
    };
    this.loop = setTimeout(run, 0);
  }

  stopLoop() {
    if (this.loop) clearTimeout(this.loop);
    this.loop = null;
  }

  sendSnapshot() {
    const b = this.battle;
    const data = encodeSnapshot(b.tick, b.units, b.projectiles);
    for (const p of this.players) this.sendBinary(p, data);
    const events = b.takeEvents();
    if (events.length) this.broadcast({ t: 'ev', tick: b.tick, events });
  }

  finishBattle() {
    this.stopLoop();
    this.result = this.battle.summary();
    this.phase = 'results';
    for (const p of this.players) if (p) p.ready = false;
    this.broadcast({ t: 'battleEnd', result: this.result });
    this.broadcastRoom();
    this.battle = null;
  }
}
