// Draws the AnyMCP icon (purple rounded square, white "A") as PNGs in static/icons/.
// No dependencies: a tiny PNG encoder and 4x4 supersampling for smooth edges.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "static", "icons");
fs.mkdirSync(outDir, { recursive: true });

const PURPLE = [0x7c, 0x3a, 0xed];

// Shape in a 64x64 design grid. The "A" is an outline plus a triangular hole (even-odd fill).
const A_OUTER = [
  [16.5, 49], [28.2, 15], [35.8, 15], [47.5, 49], [40.9, 49], [38.4, 41.6], [25.6, 41.6], [23.1, 49],
];
const A_HOLE = [
  [27.4, 35.6], [36.6, 35.6], [32, 22.4],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size) {
  const S = 4; // samples per axis
  const px = Buffer.alloc(size * size * 4);
  const scale = 64 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const gx = (x + (sx + 0.5) / S) * scale;
          const gy = (y + (sy + 0.5) / S) * scale;
          if (!inRoundedSquare(gx, gy, 64, 14)) continue;
          bg++;
          if (inPolygon(gx, gy, A_OUTER) && !inPolygon(gx, gy, A_HOLE)) fg++;
        }
      }
      const n = S * S;
      const alpha = bg / n;
      const white = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      px[i] = Math.round(PURPLE[0] + (255 - PURPLE[0]) * white);
      px[i + 1] = Math.round(PURPLE[1] + (255 - PURPLE[1]) * white);
      px[i + 2] = Math.round(PURPLE[2] + (255 - PURPLE[2]) * white);
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png(size, render(size)));
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
}
