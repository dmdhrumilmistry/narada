// Generates simple PNG icons (no external deps): two linked nodes on a blue tile.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}

function icon(size) {
  const px = (x, y) => {
    const u = x / size, v = y / size;
    const r = 0.2; // rounded tile
    const cx = Math.min(Math.max(u, r), 1 - r), cy = Math.min(Math.max(v, r), 1 - r);
    if (Math.hypot(u - cx, v - cy) > r) return [0, 0, 0, 0];
    const d1 = Math.hypot(u - 0.32, v - 0.68), d2 = Math.hypot(u - 0.68, v - 0.32);
    const t = Math.max(0, Math.min(1, ((u - 0.32) * 0.36 + (v - 0.68) * -0.36) / (0.36 * 0.36 * 2)));
    const dl = Math.hypot(u - (0.32 + 0.36 * t), v - (0.68 - 0.36 * t));
    if (d1 < 0.14 || d2 < 0.14 || dl < 0.05) return [255, 255, 255, 255];
    return [26, 115, 232, 255];
  };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) Buffer.from(px(x + 0.5, y + 0.5)).copy(raw, y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = process.argv[2] || 'src/icons';
mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`${out}/icon${s}.png`, icon(s));
