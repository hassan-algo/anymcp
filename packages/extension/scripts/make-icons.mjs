// Draws the AnyMCP icon as PNGs in static/icons/: a hub with six connectors (a "wildcard" asterisk:
// any site) in white on a violet-to-blue rounded square. Same shape as assets/icon.svg.
// No dependencies: a tiny PNG encoder and 4x4 supersampling for smooth edges.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "static", "icons");
fs.mkdirSync(outDir, { recursive: true });

const FROM = [0x7c, 0x3a, 0xed]; // top left
const TO = [0x25, 0x63, 0xeb]; // bottom right
const ANGLES = [-90, -30, 30, 90, 150, 210].map((a) => (a * Math.PI) / 180);

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Is this point (64x64 design grid) part of the white mark? */
function inMark(x, y) {
  const d = Math.hypot(x - 32, y - 32);
  if (d <= 6.4 && d >= 2.9) return true; // hub ring
  for (const a of ANGLES) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    if (Math.hypot(x - (32 + c * 20), y - (32 + s * 20)) <= 4.9) return true; // connector
    if (segmentDistance(x, y, 32 + c * 9.5, 32 + s * 9.5, 32 + c * 16, 32 + s * 16) <= 2.7) return true; // arm
  }
  return false;
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
          if (inMark(gx, gy)) fg++;
        }
      }
      const t = Math.min(1, ((x + 0.5) * scale + (y + 0.5) * scale) / 128);
      const base = FROM.map((c, k) => c + (TO[k] - c) * t);
      const white = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) px[i + k] = Math.round(base[k] + (255 - base[k]) * white);
      px[i + 3] = Math.round((bg / (S * S)) * 255);
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
