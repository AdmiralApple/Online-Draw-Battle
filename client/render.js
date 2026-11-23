// Canvas 2D renderer: paper, terrain, decals, units, projectiles and effects.

import {
  WORLD, COLS, ROWS, UNITS, T, NO_MANS_LAND, zoneOf,
} from '../shared/config.js';
import { sprite, TEAM, INK } from './sprites.js';

const TS = 2; // offscreen layer pixels per world pixel
const TILE = WORLD.tile;

const TERRAIN_STYLE = {
  [T.WALL]: { fill: '#6b6f76', edge: '#2b2622', hi: '#8a8e95' },
  [T.WATER]: { fill: '#86bfdf', edge: '#3f7fa8', hi: '#b5daef' },
  [T.MUD]: { fill: '#a98257', edge: '#6e4f30', hi: '#8c6a45' },
  [T.BRAMBLE]: { fill: '#86a95c', edge: '#47672d', hi: '#4f7a33' },
};

function hash2(a, b) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1; // css px per world px
    this.dpr = 1;
    this.paper = this.buildPaper();
    this.terrain = makeCanvas(WORLD.width * TS, WORLD.height * TS);
    this.decals = makeCanvas(WORLD.width * TS, WORLD.height * TS);
    this.effects = [];
    this.shake = 0;
    this.lastFrame = performance.now();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    if (!availW || !availH) return;
    this.scale = Math.min(availW / WORLD.width, availH / WORLD.height);
    this.dpr = window.devicePixelRatio || 1;
    const cssW = Math.floor(WORLD.width * this.scale);
    const cssH = Math.floor(WORLD.height * this.scale);
    const pw = Math.floor(cssW * this.dpr);
    const ph = Math.floor(cssH * this.dpr);
    // Assigning canvas.width clears the canvas, even to the same value. Doing that between
    // animation frames shows a blank board for a frame (flicker), so only touch it on change.
    if (this.canvas.width === pw && this.canvas.height === ph && this.cssW === cssW && this.cssH === cssH) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = pw;
    this.canvas.height = ph;
    if (this.lastView) this.frame(this.lastView); // repaint now instead of waiting a frame
  }

  toWorld(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * WORLD.width,
      y: ((clientY - r.top) / r.height) * WORLD.height,
    };
  }

  // --- Static layers ------------------------------------------------------------
  buildPaper() {
    const c = makeCanvas(WORLD.width * TS, WORLD.height * TS);
    const g = c.getContext('2d');
    g.scale(TS, TS);
    g.fillStyle = '#f4efe3';
    g.fillRect(0, 0, WORLD.width, WORLD.height);
    // Paper grain
    for (let i = 0; i < 2200; i++) {
      const x = hash2(i, 1) * WORLD.width;
      const y = hash2(i, 2) * WORLD.height;
      g.fillStyle = `rgba(120,100,70,${0.03 + hash2(i, 3) * 0.05})`;
      g.fillRect(x, y, 1.2, 1.2);
    }
    // Graph lines
    g.strokeStyle = 'rgba(120,150,170,0.16)';
    g.lineWidth = 1;
    for (let x = 0; x <= WORLD.width; x += 40) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, WORLD.height); g.stroke(); }
    for (let y = 0; y <= WORLD.height; y += 40) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(WORLD.width, y + 0.5); g.stroke(); }
    // No man's land hatch
    const x0 = WORLD.width / 2 - NO_MANS_LAND / 2;
    g.save();
    g.beginPath();
    g.rect(x0, 0, NO_MANS_LAND, WORLD.height);
    g.clip();
    g.strokeStyle = 'rgba(43,38,34,0.07)';
    g.lineWidth = 2;
    for (let k = -WORLD.height; k < NO_MANS_LAND + WORLD.height; k += 14) {
      g.beginPath();
      g.moveTo(x0 + k, 0);
      g.lineTo(x0 + k - WORLD.height, WORLD.height);
      g.stroke();
    }
    g.restore();
    g.strokeStyle = 'rgba(43,38,34,0.18)';
    g.setLineDash([6, 8]);
    g.lineWidth = 1.5;
    for (const x of [x0, x0 + NO_MANS_LAND]) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, WORLD.height); g.stroke();
    }
    return c;
  }

  /** Redraw the terrain layer from a COLS*ROWS grid. */
  setTerrain(grid) {
    const g = this.terrain.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.terrain.width, this.terrain.height);
    g.scale(TS, TS);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t = grid[r * COLS + c];
        if (!t) continue;
        const st = TERRAIN_STYLE[t];
        const x = c * TILE;
        const y = r * TILE;
        g.fillStyle = st.fill;
        g.fillRect(x - 0.25, y - 0.25, TILE + 0.5, TILE + 0.5);
        const h = hash2(c, r);
        if (t === T.WALL) {
          g.fillStyle = st.hi;
          if (h < 0.5) g.fillRect(x + 1.5, y + 1.5, 4 + h * 6, 2.5);
          else g.fillRect(x + 3, y + 5, 5, 2.5);
        } else if (t === T.WATER) {
          if (h < 0.18) {
            g.strokeStyle = st.hi; g.lineWidth = 1.2;
            g.beginPath(); g.arc(x + 5, y + 7, 3.5, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
          }
        } else if (t === T.MUD) {
          g.fillStyle = st.hi;
          g.fillRect(x + h * 7, y + hash2(r, c) * 7, 2, 2);
        } else if (t === T.BRAMBLE) {
          g.fillStyle = st.hi;
          g.beginPath(); g.arc(x + 2 + h * 6, y + 2 + hash2(r, c) * 6, 1.8, 0, Math.PI * 2); g.fill();
          if (h > 0.6) {
            g.strokeStyle = '#3a2a1c'; g.lineWidth = 0.8;
            g.beginPath(); g.moveTo(x + 3, y + 8); g.lineTo(x + 6, y + 4); g.lineTo(x + 8, y + 7); g.stroke();
          }
        }
      }
    }
    // Ink outlines where terrain changes.
    g.lineCap = 'round';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t = grid[r * COLS + c];
        if (!t) continue;
        const st = TERRAIN_STYLE[t];
        g.strokeStyle = st.edge;
        g.lineWidth = t === T.WALL ? 1.8 : 1.3;
        const x = c * TILE;
        const y = r * TILE;
        g.beginPath();
        if (r === 0 || grid[(r - 1) * COLS + c] !== t) { g.moveTo(x, y); g.lineTo(x + TILE, y); }
        if (r === ROWS - 1 || grid[(r + 1) * COLS + c] !== t) { g.moveTo(x, y + TILE); g.lineTo(x + TILE, y + TILE); }
        if (c === 0 || grid[r * COLS + c - 1] !== t) { g.moveTo(x, y); g.lineTo(x, y + TILE); }
        if (c === COLS - 1 || grid[r * COLS + c + 1] !== t) { g.moveTo(x + TILE, y); g.lineTo(x + TILE, y + TILE); }
        g.stroke();
      }
    }
  }

  clearDecals() {
    const g = this.decals.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.decals.width, this.decals.height);
    this.effects.length = 0;
  }

  splat(x, y, color, size, alpha) {
    const g = this.decals.getContext('2d');
    g.setTransform(TS, 0, 0, TS, 0, 0);
    g.globalAlpha = alpha;
    g.fillStyle = color;
    const n = 5 + ((Math.random() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * size * 0.9;
      g.beginPath();
      g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, size * (0.25 + Math.random() * 0.4), 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // --- Events -> effects -------------------------------------------------------------
  addEvent(ev) {
    const now = performance.now() / 1000;
    switch (ev.k) {
      case 'hit':
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          this.effects.push({ k: 'dot', x: ev.x, y: ev.y, vx: Math.cos(a) * 40, vy: Math.sin(a) * 40, t0: now, life: 0.3, c: TEAM[ev.s].dark });
        }
        break;
      case 'die': {
        const r = UNITS[ev.ty]?.radius ?? 6;
        this.splat(ev.x, ev.y, TEAM[ev.s].dark, r * 1.1, 0.28);
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: r * 0.5, r1: r * 2, t0: now, life: 0.35, c: INK, w: 1.2 });
        break;
      }
      case 'boom':
        this.splat(ev.x, ev.y, '#3b3530', ev.r * 0.45, 0.22);
        this.effects.push({ k: 'flash', x: ev.x, y: ev.y, r: ev.r, t0: now, life: 0.25 });
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: ev.r * 0.3, r1: ev.r * 1.2, t0: now, life: 0.45, c: '#d9822b', w: 3 });
        this.shake = Math.min(6, this.shake + 2.5);
        break;
      case 'smash':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: ev.r * 0.4, r1: ev.r * 1.3, t0: now, life: 0.35, c: '#8c7a5b', w: 2.5 });
        this.shake = Math.min(6, this.shake + 1.2);
        break;
      case 'heal':
        this.effects.push({ k: 'plus', x: ev.x, y: ev.y - 6, t0: now, life: 0.7 });
        break;
      case 'lob':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: 2, r1: 9, t0: now, life: 0.3, c: 'rgba(80,80,80,0.6)', w: 1.5 });
        break;
      default:
    }
  }

  // --- Frame ----------------------------------------------------------------------------
  /**
   * view: {
   *   mode: 'draw' | 'battle',
   *   mySide,
   *   units: [{type, side, x, y, heading, attack, hurt, water, hp, ghost}],
   *   projectiles: [{kind, x, y, z, angle}],
   *   fog: side index to cover, or -1,
   *   brush: {x, y, r, erase, ok} | null,
   *   showZones: bool,
   * }
   */
  frame(view) {
    this.lastView = view;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const ctx = this.ctx;
    const k = this.scale * this.dpr;

    let sx = 0;
    let sy = 0;
    if (this.shake > 0) {
      sx = (Math.random() - 0.5) * this.shake;
      sy = (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 18);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#f4efe3';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.paper, 0, 0, WORLD.width, WORLD.height);

    if (view.showZones) {
      const z = zoneOf(view.mySide);
      ctx.fillStyle = TEAM[view.mySide].light;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
      ctx.globalAlpha = 1;
    }

    ctx.drawImage(this.terrain, 0, 0, WORLD.width, WORLD.height);
    ctx.drawImage(this.decals, 0, 0, WORLD.width, WORLD.height);

    this.drawUnits(view.units, k, sx, sy);
    this.drawProjectiles(view.projectiles || []);
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);
    this.drawEffects(now / 1000, dt);

    if (view.fog >= 0) this.drawFog(view.fog);
    if (view.brush) this.drawBrush(view.brush);
  }

  drawUnits(units, k, sx, sy) {
    const ctx = this.ctx;
    // Shadows in one path.
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);
    ctx.fillStyle = 'rgba(43,38,34,0.13)';
    ctx.beginPath();
    for (const u of units) {
      const r = UNITS[u.type].radius;
      ctx.moveTo(u.x + r * 1.05 + 1.5, u.y + 2);
      ctx.ellipse(u.x + 1.5, u.y + 2, r * 1.05, r * 0.85, 0, 0, Math.PI * 2);
    }
    ctx.fill();

    // Wading rings
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const u of units) {
      if (!u.water) continue;
      const r = UNITS[u.type].radius * 1.25;
      ctx.moveTo(u.x + r, u.y);
      ctx.arc(u.x, u.y, r, 0, Math.PI * 2);
    }
    ctx.stroke();

    for (const u of units) {
      const s = sprite(u.type, u.side, u.hurt ? 'hurt' : 'normal');
      const r = UNITS[u.type].radius;
      const push = (u.attack || 0) * r * 0.45;
      const cos = Math.cos(u.heading);
      const sin = Math.sin(u.heading);
      let x = u.x + cos * push;
      let y = u.y + sin * push;
      if (u.stun) { x += Math.sin(performance.now() / 40 + u.x) * 0.8; }
      ctx.setTransform(k * cos, k * sin, -k * sin, k * cos, (x + sx) * k, (y + sy) * k);
      if (u.ghost) ctx.globalAlpha = u.ghost;
      ctx.drawImage(s.img, -s.ox, -s.oy, s.w, s.h);
      if (u.ghost) ctx.globalAlpha = 1;
    }

    // Health bars for big units that are hurt.
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);
    for (const u of units) {
      if (u.hp === undefined || u.hp >= 0.999) continue;
      const def = UNITS[u.type];
      if (def.hp < 150) continue;
      const w = def.radius * 2;
      const x = u.x - w / 2;
      const y = u.y - def.radius - 6;
      ctx.fillStyle = 'rgba(43,38,34,0.55)';
      ctx.fillRect(x - 0.5, y - 0.5, w + 1, 3.5);
      ctx.fillStyle = u.hp > 0.5 ? '#7cc36a' : u.hp > 0.25 ? '#f2b84b' : '#e2553f';
      ctx.fillRect(x, y, w * u.hp, 2.5);
    }
  }

  drawProjectiles(list) {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    for (const p of list) {
      if (p.kind === 0) {
        const c = Math.cos(p.angle);
        const s = Math.sin(p.angle);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x - c * 8, p.y - s * 8);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - c * 8 - s * 2, p.y - s * 8 + c * 2);
        ctx.lineTo(p.x - c * 6, p.y - s * 6);
        ctx.lineTo(p.x - c * 8 + s * 2, p.y - s * 8 - c * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(43,38,34,0.2)';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, 4, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
        const by = p.y - p.z;
        ctx.fillStyle = '#33302c';
        ctx.beginPath();
        ctx.arc(p.x, by, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = Math.random() < 0.5 ? '#ffb703' : '#fb8500';
        ctx.beginPath();
        ctx.arc(p.x + 2.5, by - 3, 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawEffects(now, dt) {
    const ctx = this.ctx;
    const keep = [];
    for (const e of this.effects) {
      const f = (now - e.t0) / e.life;
      if (f >= 1) continue;
      keep.push(e);
      if (e.k === 'dot') {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        ctx.fillStyle = e.c;
        ctx.globalAlpha = 1 - f;
        ctx.fillRect(e.x - 1, e.y - 1, 2, 2);
      } else if (e.k === 'ring') {
        ctx.globalAlpha = 1 - f;
        ctx.strokeStyle = e.c;
        ctx.lineWidth = e.w * (1 - f * 0.5);
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r0 + (e.r1 - e.r0) * Math.sqrt(f), 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.k === 'flash') {
        ctx.globalAlpha = (1 - f) * 0.85;
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r);
        g.addColorStop(0, '#fff3c4');
        g.addColorStop(0.5, '#ffb347');
        g.addColorStop(1, 'rgba(255,140,40,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (e.k === 'plus') {
        ctx.globalAlpha = 1 - f;
        ctx.fillStyle = '#3fae5a';
        const y = e.y - f * 14;
        ctx.fillRect(e.x - 1, y - 3.5, 2, 7);
        ctx.fillRect(e.x - 3.5, y - 1, 7, 2);
      }
    }
    ctx.globalAlpha = 1;
    this.effects = keep;
  }

  drawFog(side) {
    const ctx = this.ctx;
    const z = zoneOf(side);
    ctx.fillStyle = 'rgba(236,230,216,0.92)';
    ctx.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
    ctx.clip();
    ctx.strokeStyle = 'rgba(43,38,34,0.06)';
    ctx.lineWidth = 3;
    for (let k = -WORLD.height; k < z.x1 - z.x0 + WORLD.height; k += 22) {
      ctx.beginPath();
      ctx.moveTo(z.x0 + k, 0);
      ctx.lineTo(z.x0 + k + WORLD.height, WORLD.height);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(43,38,34,0.45)';
    ctx.font = '28px "Patrick Hand", "Comic Sans MS", cursive';
    ctx.textAlign = 'center';
    ctx.fillText('Opponent is drawing in secret…', (z.x0 + z.x1) / 2, WORLD.height / 2);
  }

  drawBrush(b) {
    const ctx = this.ctx;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(b.ok ? [] : [5, 5]);
    ctx.strokeStyle = b.erase ? '#c0392b' : b.ok ? 'rgba(43,38,34,0.7)' : 'rgba(192,57,43,0.8)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, Math.max(3, b.r), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
