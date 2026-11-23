// Binary battle snapshot encoding. JSON is used for everything else.
//
// Layout (little endian):
//   u8  msgType (=1)
//   u32 tick
//   u16 unitCount
//   u16 projectileCount
//   unitCount x 10 bytes:
//     u16 id, u8 (type | side<<7), u16 x*32, u16 y*32, u8 hp(0-255), u8 heading(0-255), u8 flags
//   projectileCount x 9 bytes:
//     u16 id, u8 kind, u16 x*32, u16 y*32, u8 z, u8 angle(0-255)

export const MSG_SNAPSHOT = 1;
const UNIT_BYTES = 10;
const PROJ_BYTES = 9;
const TAU = Math.PI * 2;

export const FLAG_ATTACK_MASK = 0x0f; // attack animation 0..15
export const FLAG_WATER = 0x10;
export const FLAG_STUN = 0x20;
export const FLAG_HURT = 0x40;

const angleToByte = (a) => Math.round((((a % TAU) + TAU) % TAU) / TAU * 255) & 255;
const byteToAngle = (b) => (b / 255) * TAU;
const pos = (v) => Math.max(0, Math.min(65535, Math.round(v * 32)));

export function encodeSnapshot(tick, units, projectiles) {
  const buf = new ArrayBuffer(9 + units.length * UNIT_BYTES + projectiles.length * PROJ_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG_SNAPSHOT);
  v.setUint32(1, tick, true);
  v.setUint16(5, units.length, true);
  v.setUint16(7, projectiles.length, true);
  let o = 9;
  for (const u of units) {
    v.setUint16(o, u.id & 0xffff, true);
    v.setUint8(o + 2, (u.type & 0x7f) | (u.side << 7));
    v.setUint16(o + 3, pos(u.x), true);
    v.setUint16(o + 5, pos(u.y), true);
    v.setUint8(o + 7, Math.max(0, Math.min(255, Math.round((u.hp / u.maxHp) * 255))));
    v.setUint8(o + 8, angleToByte(u.heading));
    let flags = Math.min(15, Math.round(u.attackAnim * 15)) & FLAG_ATTACK_MASK;
    if (u.inWater) flags |= FLAG_WATER;
    if (u.stun > 0) flags |= FLAG_STUN;
    if (u.hurt > 0) flags |= FLAG_HURT;
    v.setUint8(o + 9, flags);
    o += UNIT_BYTES;
  }
  for (const p of projectiles) {
    v.setUint16(o, p.id & 0xffff, true);
    v.setUint8(o + 2, p.kind);
    v.setUint16(o + 3, pos(p.x), true);
    v.setUint16(o + 5, pos(p.y), true);
    v.setUint8(o + 7, Math.max(0, Math.min(255, Math.round(p.z))));
    v.setUint8(o + 8, angleToByte(p.angle));
    o += PROJ_BYTES;
  }
  return new Uint8Array(buf);
}

export function decodeSnapshot(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (v.getUint8(0) !== MSG_SNAPSHOT) return null;
  const tick = v.getUint32(1, true);
  const nu = v.getUint16(5, true);
  const np = v.getUint16(7, true);
  const units = new Map();
  let o = 9;
  for (let i = 0; i < nu; i++) {
    const ts = v.getUint8(o + 2);
    const flags = v.getUint8(o + 9);
    units.set(v.getUint16(o, true), {
      type: ts & 0x7f,
      side: ts >> 7,
      x: v.getUint16(o + 3, true) / 32,
      y: v.getUint16(o + 5, true) / 32,
      hp: v.getUint8(o + 7) / 255,
      heading: byteToAngle(v.getUint8(o + 8)),
      attack: (flags & FLAG_ATTACK_MASK) / 15,
      water: (flags & FLAG_WATER) !== 0,
      stun: (flags & FLAG_STUN) !== 0,
      hurt: (flags & FLAG_HURT) !== 0,
    });
    o += UNIT_BYTES;
  }
  const projectiles = new Map();
  for (let i = 0; i < np; i++) {
    projectiles.set(v.getUint16(o, true), {
      kind: v.getUint8(o + 2),
      x: v.getUint16(o + 3, true) / 32,
      y: v.getUint16(o + 5, true) / 32,
      z: v.getUint8(o + 7),
      angle: byteToAngle(v.getUint8(o + 8)),
    });
    o += PROJ_BYTES;
  }
  return { tick, units, projectiles };
}
