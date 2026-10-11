'use strict';
// Draws the app icon (a Volt rounded square with a dark screen and a cursor) as PNG / ICO, no assets needed.
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const s = size;
  for (let y = 0; y < s; y++) {
    raw[y * (s * 4 + 1)] = 0;
    for (let x = 0; x < s; x++) {
      const u = (x + 0.5) / s, v = (y + 0.5) / s;
      let c = [0, 0, 0, 0];
      if (inRoundRect(u, v, 0.04, 0.04, 0.96, 0.96, 0.22)) c = [0xd4, 0xff, 0x3f, 255]; // Volt
      if (inRoundRect(u, v, 0.18, 0.24, 0.82, 0.70, 0.07)) c = [0x0b, 0x0c, 0x0a, 255]; // screen
      if (inRoundRect(u, v, 0.40, 0.76, 0.60, 0.82, 0.02)) c = [0x0b, 0x0c, 0x0a, 255]; // stand
      // cursor arrow inside the screen
      const ax = (u - 0.38) / 0.22, ay = (v - 0.32) / 0.3;
      if (ax >= 0 && ay >= 0 && ay <= 1 && ax <= ay * 0.72 && ax >= 0) c = [0xd4, 0xff, 0x3f, 255];
      const o = y * (s * 4 + 1) + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = c[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO with PNG payloads (valid since Windows Vista). */
function ico(sizes = [16, 32, 48, 64, 128, 256]) {
  const pngs = sizes.map((s) => png(s));
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...pngs]);
}

module.exports = { png, ico };
