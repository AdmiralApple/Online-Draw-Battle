// Unit artwork, drawn with canvas paths and cached as sprites.
// Every unit is drawn facing +x (right) centred on the origin.

import { UNITS } from '../shared/config.js';

export const INK = '#2b2622';
export const TEAM = [
  { main: '#2a9d8f', dark: '#1d6f66', light: '#9fd8cf', name: 'Teal' },
  { main: '#e76f51', dark: '#a9472f', light: '#f6bba8', name: 'Coral' },
];

const SPR = 4; // sprite pixels per world pixel

function circle(ctx, x, y, r, fill, stroke, lw) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

function line(ctx, x0, y0, x1, y1, color, lw) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function body(ctx, r, c, lw) {
  circle(ctx, 0, 0, r, c.main, INK, lw);
  // Facing marker: a darker crescent on the front of the body.
  ctx.beginPath();
  ctx.arc(0, 0, r - lw * 0.5, -0.9, 0.9);
  ctx.arc(r * 0.25, 0, r * 0.62, 0.95, -0.95, true);
  ctx.closePath();
  ctx.fillStyle = c.dark;
  ctx.fill();
}

const DRAW = {
  militia(ctx, r, c, lw) {
    line(ctx, r * 0.3, r * 0.7, r * 1.45, r * 0.95, '#7a5230', lw * 1.3); // club
    circle(ctx, r * 1.45, r * 0.95, r * 0.28, '#7a5230', INK, lw * 0.6);
    body(ctx, r, c, lw);
  },
  spear(ctx, r, c, lw) {
    line(ctx, -r * 0.9, r * 0.55, r * 2.5, r * 0.55, '#8a6a44', lw * 0.9); // shaft
    ctx.beginPath(); // tip
    ctx.moveTo(r * 2.95, r * 0.55);
    ctx.lineTo(r * 2.35, r * 0.25);
    ctx.lineTo(r * 2.35, r * 0.85);
    ctx.closePath();
    ctx.fillStyle = '#c9ced6';
    ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.5; ctx.stroke();
    body(ctx, r, c, lw);
    // Helmet crest
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, 0, r * 0.75, r * 0.22, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#c9ced6'; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = lw * 0.5; ctx.stroke();
  },
  archer(ctx, r, c, lw) {
    body(ctx, r, c, lw);
    ctx.beginPath(); // bow
    ctx.arc(r * 0.35, 0, r * 1.15, -1.15, 1.15);
    ctx.strokeStyle = '#7a5230'; ctx.lineWidth = lw * 1.2; ctx.lineCap = 'round'; ctx.stroke();
    const bx = r * 0.35 + Math.cos(1.15) * r * 1.15;
    const by = Math.sin(1.15) * r * 1.15;
    line(ctx, bx, -by, bx, by, '#efe6d2', lw * 0.45); // string
    // Quiver
    ctx.fillStyle = '#7a5230';
    ctx.fillRect(-r * 1.05, -r * 0.65, r * 0.45, r * 1.3);
  },
  hound(ctx, r, c, lw) {
    line(ctx, -r * 1.2, 0, -r * 2.0, -r * 0.35, INK, lw * 0.9); // tail
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, 0, r * 1.15, r * 0.72, 0, 0, Math.PI * 2);
    ctx.fillStyle = c.main; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = lw; ctx.stroke();
    circle(ctx, r * 0.95, 0, r * 0.6, c.dark, INK, lw); // head
    ctx.fillStyle = INK; // ears
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(r * 0.7, s * r * 0.35);
      ctx.lineTo(r * 0.55, s * r * 0.95);
      ctx.lineTo(r * 1.05, s * r * 0.5);
      ctx.closePath(); ctx.fill();
    }
    circle(ctx, r * 1.55, 0, r * 0.18, INK); // nose
  },
  rider(ctx, r, c, lw) {
    // Horse
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.25, r * 0.62, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#b08155'; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = lw; ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(r * 1.3, 0, r * 0.45, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#9a6d45'; ctx.fill(); ctx.stroke();
    line(ctx, -r * 1.2, 0, -r * 1.75, 0, INK, lw * 1.3); // tail
    // Lance
    line(ctx, -r * 0.3, r * 0.42, r * 2.6, r * 0.42, '#d8d2c4', lw * 0.9);
    // Rider
    circle(ctx, -r * 0.1, 0, r * 0.52, c.main, INK, lw);
    ctx.beginPath();
    ctx.arc(-r * 0.1, 0, r * 0.38, -0.9, 0.9);
    ctx.strokeStyle = c.dark; ctx.lineWidth = lw; ctx.stroke();
  },
  medic(ctx, r, c, lw) {
    circle(ctx, 0, 0, r, '#fbf7ee', INK, lw);
    ctx.beginPath();
    ctx.arc(0, 0, r - lw * 1.2, 0, Math.PI * 2);
    ctx.strokeStyle = c.main; ctx.lineWidth = lw * 1.4; ctx.stroke();
    ctx.fillStyle = c.main;
    ctx.fillRect(-r * 0.18, -r * 0.55, r * 0.36, r * 1.1);
    ctx.fillRect(-r * 0.55, -r * 0.18, r * 1.1, r * 0.36);
    // Bag in front
    ctx.fillStyle = '#7a5230';
    ctx.fillRect(r * 0.75, -r * 0.35, r * 0.5, r * 0.7);
  },
  bomber(ctx, r, c, lw) {
    body(ctx, r, c, lw);
    circle(ctx, r * 1.15, r * 0.25, r * 0.55, '#33302c', INK, lw * 0.6); // bomb
    line(ctx, r * 1.3, -r * 0.2, r * 1.6, -r * 0.6, '#c9a26b', lw * 0.6); // fuse
    circle(ctx, r * 1.62, -r * 0.65, r * 0.18, '#ffb703');
    // Goggles
    circle(ctx, r * 0.35, -r * 0.35, r * 0.2, '#ffe9a8', INK, lw * 0.4);
    circle(ctx, r * 0.35, r * 0.35, r * 0.2, '#ffe9a8', INK, lw * 0.4);
  },
  golem(ctx, r, c, lw) {
    // Fists
    circle(ctx, r * 0.75, -r * 0.85, r * 0.38, '#8d8a83', INK, lw);
    circle(ctx, r * 0.75, r * 0.85, r * 0.38, '#8d8a83', INK, lw);
    // Boulder body
    ctx.beginPath();
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (0.88 + 0.12 * Math.sin(i * 2.7 + 1));
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = '#a7a39a'; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke();
    // Team band and glowing eyes
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, -1.2, 1.2);
    ctx.strokeStyle = c.main; ctx.lineWidth = lw * 2.2; ctx.stroke();
    circle(ctx, r * 0.55, -r * 0.22, r * 0.12, c.light);
    circle(ctx, r * 0.55, r * 0.22, r * 0.12, c.light);
    line(ctx, -r * 0.4, -r * 0.3, -r * 0.1, r * 0.1, '#6e6b65', lw * 0.6); // crack
  },
};

const cache = new Map();

/**
 * Get a cached sprite for a unit type/side. `variant` is 'normal' or 'hurt'.
 * Returns { img, ox, oy, w, h } in world units (draw at -ox,-oy with size w,h).
 */
export function sprite(type, side, variant = 'normal') {
  const key = `${type}:${side}:${variant}`;
  let s = cache.get(key);
  if (s) return s;
  const def = UNITS[type];
  const r = def.radius;
  const extentX = r * 3.4;
  const extentY = r * 1.8;
  const w = extentX * 2;
  const h = extentY * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * SPR);
  canvas.height = Math.ceil(h * SPR);
  const ctx = canvas.getContext('2d');
  ctx.scale(SPR, SPR);
  ctx.translate(extentX, extentY);
  const lw = Math.max(1, r * 0.16);
  DRAW[def.key](ctx, r, TEAM[side], lw);
  if (variant === 'hurt') {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  s = { img: canvas, ox: extentX, oy: extentY, w, h };
  cache.set(key, s);
  return s;
}

/** A small square icon of a unit, for the palette. */
export function unitIcon(type, side, size = 44) {
  const def = UNITS[type];
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const r = def.radius;
  const scale = (size * 0.8) / (r * 4.6);
  ctx.translate(size / 2 - r * 0.6 * scale, size / 2);
  ctx.scale(scale, scale);
  ctx.rotate(-0.35);
  DRAW[def.key](ctx, r, TEAM[side], Math.max(1, r * 0.16));
  return canvas;
}
