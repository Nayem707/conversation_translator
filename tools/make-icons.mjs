// Generates extension/icons/icon{16,32,48,128}.png without dependencies.
// Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded rectangle centred at (cx, cy).
const roundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

// Shapes in a 0..1 unit square; later layers paint over earlier ones.
function shade(x, y) {
  const layers = [];
  const t = (x + y) / 2;
  const bg = [79 + (124 - 79) * t, 70 + (58 - 70) * t, 229 + (237 - 229) * t];
  layers.push([roundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22), bg]);
  // white bubble (top-left) with tail
  const bubbleA = Math.min(roundRect(x, y, 0.4, 0.38, 0.26, 0.18, 0.08), circle(x, y, 0.24, 0.6, 0.06));
  layers.push([bubbleA, [255, 255, 255]]);
  // teal bubble (bottom-right) with tail
  const bubbleB = Math.min(roundRect(x, y, 0.62, 0.66, 0.22, 0.15, 0.07), circle(x, y, 0.78, 0.84, 0.05));
  layers.push([bubbleB + 0.035, [79, 70, 229]]); // outline gap
  layers.push([bubbleB, [45, 212, 191]]);
  // text lines in the white bubble
  layers.push([roundRect(x, y, 0.38, 0.33, 0.15, 0.025, 0.025), [99, 102, 241]]);
  layers.push([roundRect(x, y, 0.33, 0.43, 0.1, 0.025, 0.025), [99, 102, 241]]);
  return layers;
}

function render(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          let col = null;
          for (const [d, c] of shade(x, y)) if (d <= 0) col = c;
          if (col) {
            r += col[0];
            g += col[1];
            b += col[2];
            a += 1;
          }
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      buf[i] = a ? r / a : 0;
      buf[i + 1] = a ? g / a : 0;
      buf[i + 2] = a ? b / a : 0;
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), png(size, render(size)));
  console.log(`icon${size}.png`);
}
