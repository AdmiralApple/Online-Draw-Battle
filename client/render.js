// Canvas 2D renderer: paper, terrain, decals, units, projectiles and effects.

import {
  WORLD, COLS, ROWS, UNITS, T, zonePolygon, zoneCentre,
} from '../shared/config.js';
import { sprite, TEAM, INK } from './sprites.js';

const TS = 2; // offscreen layer pixels per world pixel
const TILE = WORLD.tile;

const TERRAIN_STYLE = {
  [T.WALL]: { fill: '#6b6f76', edge: '#2b2622', hi: '#8a8e95' },
  [T.WATER]: { fill: '#86bfdf', edge: '#3f7fa8', hi: '#b5daef' },
  [T.MUD]: { fill: '#a98257', edge: '#6e4f30', hi: '#8c6a45' },
  [T.BRAMBLE]: { fill: '#86a95c', edge: '#47672d', hi: '#4f7a33' },
  [T.ICE]: { fill: '#dcf0f6', edge: '#8cbfd3', hi: '#ffffff' },
};
const FLAME = ['#ffb703', '#fb8500', '#e85d04', '#ffd166'];

function hash2(a, b) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function polyPath(g, poly) {
  g.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) g.lineTo(poly[i][0], poly[i][1]);
  g.closePath();
}

const onWorldEdge = (x, y) => x <= 0.5 || y <= 0.5 || x >= WORLD.width - 0.5 || y >= WORLD.height - 0.5;

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
    this.layout = 2;
    this.paper = this.buildPaper(this.layout);
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

  /** Switch between the 1v1 (2) and free-for-all (3) map layouts. */
  setLayout(layout) {
    if (layout === this.layout) return;
    this.layout = layout;
    this.paper = this.buildPaper(layout);
  }

  // --- Static layers ------------------------------------------------------------
  buildPaper(layout) {
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
    // No man's land hatch: everywhere outside the players' zones.
    const zones = Array.from({ length: layout }, (_, side) => zonePolygon(side, layout));
    g.save();
    g.beginPath();
    g.rect(0, 0, WORLD.width, WORLD.height);
    for (const z of zones) polyPath(g, z);
    g.clip('evenodd');
    g.strokeStyle = 'rgba(43,38,34,0.07)';
    g.lineWidth = 2;
    for (let k = 0; k < WORLD.width + WORLD.height; k += 14) {
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k - WORLD.height, WORLD.height);
      g.stroke();
    }
    g.restore();
    // Dashed zone borders (skipping edges that run along the map edge).
    g.strokeStyle = 'rgba(43,38,34,0.18)';
    g.setLineDash([6, 8]);
    g.lineWidth = 1.5;
    for (const z of zones) {
      for (let i = 0; i < z.length; i++) {
        const a = z[i];
        const b = z[(i + 1) % z.length];
        if (onWorldEdge(a[0], a[1]) && onWorldEdge(b[0], b[1]) && (a[0] === b[0] || a[1] === b[1])) continue;
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
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
        } else if (t === T.ICE) {
          if (h < 0.3) {
            g.strokeStyle = st.hi; g.lineWidth = 1.1;
            g.beginPath(); g.moveTo(x + 2, y + 7 - h * 6); g.lineTo(x + 7, y + 2 + h * 4); g.stroke();
          } else if (h > 0.85) {
            g.strokeStyle = 'rgba(120,170,190,0.5)'; g.lineWidth = 0.7;
            g.beginPath(); g.moveTo(x + 1, y + 4); g.lineTo(x + 5, y + 6); g.lineTo(x + 9, y + 3); g.stroke();
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
      case 'chip':
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          this.effects.push({ k: 'dot', x: ev.x, y: ev.y, vx: Math.cos(a) * 50, vy: Math.sin(a) * 50, t0: now, life: 0.35, c: '#6b6f76' });
        }
        break;
      case 'wall':
        this.splat(ev.x, ev.y, '#6b6f76', 6, 0.35);
        for (let i = 0; i < 7; i++) {
          const a = Math.random() * Math.PI * 2;
          const v = 40 + Math.random() * 60;
          this.effects.push({ k: 'dot', x: ev.x, y: ev.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t0: now, life: 0.5, c: '#4a4e55' });
        }
        this.shake = Math.min(6, this.shake + 0.6);
        break;
      case 'lob':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: 2, r1: 9, t0: now, life: 0.3, c: 'rgba(80,80,80,0.6)', w: 1.5 });
        break;
      case 'tile':
        if (ev.b) {
          // Brambles burnt away: leave scorched ground with a few flecks of ash.
          const x = (ev.i % COLS) * TILE;
          const y = Math.floor(ev.i / COLS) * TILE;
          const g = this.decals.getContext('2d');
          g.setTransform(TS, 0, 0, TS, 0, 0);
          g.fillStyle = 'rgba(58,48,38,0.16)';
          g.fillRect(x, y, TILE, TILE);
          g.fillStyle = 'rgba(40,34,28,0.35)';
          for (let k = 0; k < 2; k++) g.fillRect(x + hash2(ev.i, k) * 8, y + hash2(k, ev.i) * 8, 1.6, 1.6);
        }
        break;
      case 'fire': {
        const x = ((ev.i % COLS) + 0.5) * TILE;
        const y = (Math.floor(ev.i / COLS) + 0.5) * TILE;
        this.effects.push({ k: 'flame', x, y, t0: now, life: ev.d, seed: Math.random() * 10 });
        break;
      }
      case 'ignite':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: 3, r1: 12, t0: now, life: 0.3, c: '#fb8500', w: 2 });
        break;
      case 'steam':
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * Math.PI * 2;
          this.effects.push({ k: 'puff', x: ev.x, y: ev.y, vx: Math.cos(a) * 12, vy: Math.sin(a) * 12 - 18, t0: now, life: 0.9 + Math.random() * 0.5, r: 3 + Math.random() * 3, c: '200,206,212' });
        }
        break;
      case 'beep':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: 4, r1: 16, t0: now, life: 0.4, c: '#e2553f', w: 2 });
        break;
      case 'land':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: ev.r * 0.6, r1: ev.r * 1.6, t0: now, life: 0.3, c: 'rgba(140,122,91,0.7)', w: 1.5 });
        break;
      case 'slip':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: 3, r1: 10, t0: now, life: 0.3, c: '#8cbfd3', w: 1.5 });
        break;
      case 'crack':
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          this.effects.push({ k: 'dot', x: ev.x, y: ev.y, vx: Math.cos(a) * 30, vy: Math.sin(a) * 30, t0: now, life: 0.35, c: '#ffffff' });
        }
        break;
      case 'block':
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          this.effects.push({ k: 'dot', x: ev.x, y: ev.y, vx: Math.cos(a) * 45, vy: Math.sin(a) * 45, t0: now, life: 0.25, c: '#ffd166' });
        }
        break;
      case 'rise':
        this.splat(ev.x, ev.y, '#6f8a58', 6, 0.3);
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: 4, r1: 18, t0: now, life: 0.6, c: '#7fb24a', w: 2.5 });
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * Math.PI * 2;
          this.effects.push({ k: 'puff', x: ev.x, y: ev.y, vx: Math.cos(a) * 14, vy: Math.sin(a) * 14 - 10, t0: now, life: 0.8, r: 3, c: '120,150,90' });
        }
        break;
      case 'split':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: ev.r * 0.5, r1: ev.r * 1.8, t0: now, life: 0.35, c: TEAM[ev.s].main, w: 2 });
        this.splat(ev.x, ev.y, TEAM[ev.s].light, ev.r * 0.6, 0.35);
        break;
      case 'splat':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: ev.r * 0.8, r1: ev.r * 2.2, t0: now, life: 0.3, c: TEAM[ev.s].light, w: 2 });
        if (Math.random() < 0.3) this.splat(ev.x, ev.y, TEAM[ev.s].light, ev.r * 0.5, 0.18);
        break;
      case 'dash':
        this.effects.push({ k: 'streak', x: ev.x, y: ev.y, x1: ev.x1, y1: ev.y1, t0: now, life: 0.3 });
        break;
      case 'smoke':
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * ev.r * 0.6;
          this.effects.push({
            k: 'cloud', x: ev.x + Math.cos(a) * d, y: ev.y + Math.sin(a) * d,
            vx: Math.cos(a) * 6, vy: Math.sin(a) * 6 - 4, t0: now, life: ev.d * (0.85 + Math.random() * 0.3), r: ev.r * (0.35 + Math.random() * 0.25),
          });
        }
        break;
      case 'zap':
        this.effects.push({ k: 'bolt', p: ev.p, t0: now, life: 0.28, seed: Math.random() * 100 });
        for (let i = 2; i < ev.p.length; i += 2) this.effects.push({ k: 'ring', x: ev.p[i], y: ev.p[i + 1], r0: 2, r1: 10, t0: now, life: 0.25, c: '#bde0fe', w: 2 });
        this.shake = Math.min(6, this.shake + 0.8);
        break;
      case 'pond':
        for (const i of ev.t) {
          const x = ((i % COLS) + 0.5) * TILE;
          const y = (Math.floor(i / COLS) + 0.5) * TILE;
          this.effects.push({ k: 'spark', x, y, t0: now + Math.random() * 0.15, life: 0.35, seed: Math.random() * 10 });
        }
        break;
      case 'cast':
        this.effects.push({ k: 'ring', x: ev.x, y: ev.y, r0: 14, r1: 4, t0: now, life: 0.45, c: '#8ecae6', w: 1.5 });
        break;
      case 'shot':
        this.effects.push({ k: 'flash', x: ev.x, y: ev.y, r: 7, t0: now, life: 0.08 });
        break;
      case 'fled':
        for (let i = 0; i < 4; i++) {
          const a = Math.random() * Math.PI * 2;
          this.effects.push({ k: 'puff', x: ev.x, y: ev.y, vx: Math.cos(a) * 20, vy: Math.sin(a) * 20, t0: now, life: 0.6, r: 3, c: '160,140,110' });
        }
        break;
      default:
    }
  }

  // --- Frame ----------------------------------------------------------------------------
  /**
   * view: {
   *   mode: 'draw' | 'battle',
   *   mySide,
   *   units: [{type, side, x, y, heading, attack, hurt, water, hp, ghost, burn, flee, armed, z}],
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
      ctx.fillStyle = TEAM[view.mySide].light;
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      polyPath(ctx, zonePolygon(view.mySide, this.layout));
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.drawImage(this.terrain, 0, 0, WORLD.width, WORLD.height);
    ctx.drawImage(this.decals, 0, 0, WORLD.width, WORLD.height);

    this.drawUnits(view.units, k, sx, sy);
    this.drawProjectiles(view.projectiles || []);
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);
    this.drawEffects(now / 1000, dt);

    if (view.fog) this.drawFog(view.mySide);
    if (view.brush) this.drawBrush(view.brush);
  }

  drawUnits(units, k, sx, sy) {
    const ctx = this.ctx;
    // Shadows in one path.
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);
    ctx.fillStyle = 'rgba(43,38,34,0.13)';
    ctx.beginPath();
    for (const u of units) {
      // Airborne units cast a smaller shadow on the ground beneath them.
      const r = UNITS[u.type].radius * (u.z ? Math.max(0.5, 1 - u.z / 120) : 1);
      ctx.moveTo(u.x + r * 1.05 + 1.5, u.y + 2);
      ctx.ellipse(u.x + 1.5, u.y + 2, r * 1.05, r * 0.85, 0, 0, Math.PI * 2);
    }
    ctx.fill();

    // Wading rings
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const u of units) {
      if (!u.water || u.z) continue;
      const r = UNITS[u.type].radius * 1.25;
      ctx.moveTo(u.x + r, u.y);
      ctx.arc(u.x, u.y, r, 0, Math.PI * 2);
    }
    ctx.stroke();

    const t = performance.now() / 1000;
    // Ground-level units first, airborne ones on top.
    const order = units.some((u) => u.z) ? [...units].sort((a, b) => (a.z || 0) - (b.z || 0)) : units;
    for (const u of order) {
      const s = sprite(u.type, u.side, u.hurt ? 'hurt' : u.flee ? 'flee' : 'normal');
      const r = UNITS[u.type].radius;
      const push = (u.attack || 0) * r * 0.45;
      const lift = u.z || 0;
      const sc = 1 + lift / 160;
      const cos = Math.cos(u.heading) * sc;
      const sin = Math.sin(u.heading) * sc;
      let x = u.x + Math.cos(u.heading) * push;
      const y = u.y + Math.sin(u.heading) * push - lift;
      if (u.stun) { x += Math.sin(performance.now() / 40 + u.x) * 0.8; }
      ctx.setTransform(k * cos, k * sin, -k * sin, k * cos, (x + sx) * k, (y + sy) * k);
      if (u.ghost) ctx.globalAlpha = u.ghost;
      ctx.drawImage(s.img, -s.ox, -s.oy, s.w, s.h);
      if (u.ghost) ctx.globalAlpha = 1;
    }

    // Flames on burning units, blinking lights on armed mines and kegs.
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);
    for (const u of units) {
      if (!u.burn && !u.armed) continue;
      const r = UNITS[u.type].radius;
      const y = u.y - (u.z || 0);
      if (u.armed && Math.floor(t * 10) % 2 === 0) {
        ctx.fillStyle = '#e2553f';
        ctx.beginPath(); ctx.arc(u.x, y, r * 0.45, 0, Math.PI * 2); ctx.fill();
      }
      if (u.burn) {
        for (let i = 0; i < 3; i++) {
          const ph = t * 9 + i * 2.1 + u.x * 0.1;
          const fx = u.x + Math.sin(ph) * r * 0.45 + (i - 1) * r * 0.35;
          const fy = y - r * 0.4 - Math.abs(Math.sin(ph * 1.3)) * r * 0.5;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = FLAME[(i + Math.floor(t * 12)) % FLAME.length];
          ctx.beginPath(); ctx.arc(fx, fy, r * (0.35 + 0.12 * Math.sin(ph * 2)), 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    // Firebrands' flame jets, Marksmen's aim lines, Stormcallers' glow, ghoul bites.
    const now = t;
    for (const u of units) {
      if (!u.spray && !u.aim && !u.cast && !u.infected) continue;
      const r = UNITS[u.type].radius;
      const c = Math.cos(u.heading);
      const s = Math.sin(u.heading);
      if (u.spray) {
        for (let i = 0; i < 2; i++) {
          const a = u.heading + (Math.random() - 0.5) * 0.8;
          const v = 170 + Math.random() * 70;
          this.effects.push({ k: 'jet', x: u.x + c * r * 1.7, y: u.y + s * r * 1.7, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t0: now, life: 0.28 + Math.random() * 0.08 });
        }
      }
      if (u.aim) {
        const g = ctx.createLinearGradient(u.x, u.y, u.x + c * 220, u.y + s * 220);
        g.addColorStop(0, 'rgba(226,85,63,0.7)');
        g.addColorStop(1, 'rgba(226,85,63,0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(u.x + c * r * 2.8, u.y + s * r * 2.8); ctx.lineTo(u.x + c * 220, u.y + s * 220); ctx.stroke();
      }
      if (u.cast) {
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now * 30);
        ctx.strokeStyle = '#8ecae6';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(u.x, u.y, r * 1.5, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (u.infected) {
        ctx.globalAlpha = 0.45 + 0.25 * Math.sin(now * 5 + u.x);
        ctx.strokeStyle = '#7fb24a';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(u.x, u.y - (u.z || 0), r * 1.15, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Health bars for big units that are hurt.
    ctx.setTransform(k, 0, 0, k, sx * k, sy * k);
    for (const u of units) {
      if (u.hp === undefined || u.hp >= 0.999) continue;
      const def = UNITS[u.type];
      if (def.hp < 150 || def.prop) continue;
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
      if (p.kind === 2) {
        // Bullet: a bright streak.
        const c = Math.cos(p.angle);
        const s = Math.sin(p.angle);
        ctx.strokeStyle = 'rgba(255,214,102,0.9)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(p.x - c * 16, p.y - s * 16);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else if (p.kind === 0) {
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
      } else if (e.k === 'flame') {
        // A burning terrain tile: a few flickering tongues of fire, dying down at the end.
        const fade = f > 0.8 ? (1 - f) / 0.2 : Math.min(1, f * 8);
        const tt = now * 8 + e.seed;
        ctx.globalAlpha = 0.85 * fade;
        for (let i = 0; i < 2; i++) {
          ctx.fillStyle = FLAME[(i + Math.floor(tt)) % FLAME.length];
          const fx = e.x + Math.sin(tt + i * 3) * 2.5;
          const fy = e.y - Math.abs(Math.sin(tt * 1.4 + i)) * 4;
          ctx.beginPath(); ctx.arc(fx, fy, 3 + Math.sin(tt * 2 + i), 0, Math.PI * 2); ctx.fill();
        }
      } else if (e.k === 'puff') {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(${e.c},${0.55 * (1 - f)})`;
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (1 + f), 0, Math.PI * 2); ctx.fill();
      } else if (e.k === 'jet') {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        e.vx *= 1 - 2.5 * dt;
        e.vy *= 1 - 2.5 * dt;
        ctx.globalAlpha = 0.8 * (1 - f);
        ctx.fillStyle = FLAME[Math.min(FLAME.length - 1, Math.floor(f * FLAME.length))];
        ctx.beginPath(); ctx.arc(e.x, e.y, 2 + f * 5, 0, Math.PI * 2); ctx.fill();
      } else if (e.k === 'cloud') {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        const fade = f > 0.75 ? (1 - f) / 0.25 : Math.min(1, f * 10);
        ctx.globalAlpha = 0.82 * fade;
        ctx.fillStyle = '#b9b6ae';
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (1 + f * 0.4), 0, Math.PI * 2); ctx.fill();
      } else if (e.k === 'streak') {
        ctx.globalAlpha = 0.6 * (1 - f);
        ctx.strokeStyle = '#2e2b33';
        ctx.lineWidth = 3 * (1 - f) + 0.5;
        ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.x1, e.y1); ctx.stroke();
      } else if (e.k === 'bolt') {
        // A jagged bolt along the chain, re-jittered every frame.
        const p = e.p;
        for (const [col, w] of [['rgba(142,202,230,0.6)', 4], ['#ffffff', 1.4]]) {
          ctx.globalAlpha = 1 - f;
          ctx.strokeStyle = col;
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(p[0], p[1]);
          for (let i = 2; i < p.length; i += 2) {
            const x0 = p[i - 2];
            const y0 = p[i - 1];
            const dx = p[i] - x0;
            const dy = p[i + 1] - y0;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len;
            const ny = dx / len;
            const segs = Math.max(2, Math.round(len / 12));
            for (let k = 1; k < segs; k++) {
              const j = (Math.random() - 0.5) * 8;
              ctx.lineTo(x0 + dx * (k / segs) + nx * j, y0 + dy * (k / segs) + ny * j);
            }
            ctx.lineTo(p[i], p[i + 1]);
          }
          ctx.stroke();
        }
      } else if (e.k === 'spark') {
        if (f < 0) continue;
        ctx.globalAlpha = 1 - f;
        ctx.strokeStyle = '#bde0fe';
        ctx.lineWidth = 1.2;
        const a = e.seed + now * 20;
        ctx.beginPath();
        ctx.moveTo(e.x - Math.cos(a) * 4, e.y - Math.sin(a) * 4);
        ctx.lineTo(e.x + Math.sin(a * 1.7) * 2, e.y - Math.cos(a * 1.3) * 2);
        ctx.lineTo(e.x + Math.cos(a) * 4, e.y + Math.sin(a) * 4);
        ctx.stroke();
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

  /** Hidden drawing: cover every other player's zone. */
  drawFog(mySide) {
    const ctx = this.ctx;
    for (let side = 0; side < this.layout; side++) {
      if (side === mySide) continue;
      const z = zonePolygon(side, this.layout);
      ctx.save();
      ctx.beginPath();
      polyPath(ctx, z);
      ctx.fillStyle = 'rgba(236,230,216,0.92)';
      ctx.fill();
      ctx.clip();
      ctx.strokeStyle = 'rgba(43,38,34,0.06)';
      ctx.lineWidth = 3;
      for (let k = -WORLD.height; k < WORLD.width; k += 22) {
        ctx.beginPath();
        ctx.moveTo(k, 0);
        ctx.lineTo(k + WORLD.height, WORLD.height);
        ctx.stroke();
      }
      ctx.restore();
      const [cx, cy] = zoneCentre(side, this.layout);
      ctx.fillStyle = TEAM[side].dark;
      ctx.globalAlpha = 0.6;
      ctx.font = `${this.layout > 2 ? 22 : 28}px "Patrick Hand", "Comic Sans MS", cursive`;
      ctx.textAlign = 'center';
      ctx.fillText('Drawing in secret…', cx, cy);
      ctx.globalAlpha = 1;
    }
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
