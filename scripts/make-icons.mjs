// Génère les icônes de l'appli (SVG + PNG 192 et 512) sans dépendance externe.
// Usage : node scripts/make-icons.mjs  (les fichiers produits sont commités dans public/icons).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG = [0x0b, 0x0f, 0x14];
const CARD = [0xff, 0xb0, 0x20];
const ARROW = [0x11, 0x11, 0x11];

// Coordonnées normalisées (0 à 1). Tout le dessin tient dans la zone sûre des
// icônes « maskable » (cercle central de 80 %).
const CARD_POLY = [
  [0.33, 0.24],
  [0.57, 0.24],
  [0.67, 0.34],
  [0.67, 0.76],
  [0.33, 0.76],
];
const ARROW_POLY = [
  [0.465, 0.35],
  [0.535, 0.35],
  [0.535, 0.54],
  [0.6, 0.54],
  [0.5, 0.67],
  [0.4, 0.54],
  [0.465, 0.54],
];

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function colorAt(x, y) {
  if (inside(ARROW_POLY, x, y)) return ARROW;
  if (inside(CARD_POLY, x, y)) return CARD;
  return BG;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const SS = 4; // suréchantillonnage pour lisser les bords
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let py = 0; py < size; py++) {
    const row = py * (size * 3 + 1);
    raw[row] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb] = colorAt((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const n = SS * SS;
      const o = row + 1 + px * 3;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 2; // RVB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const points = (poly) => poly.map(([x, y]) => `${x * 512},${y * 512}`).join(' ');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${hex(BG)}"/>
  <polygon points="${points(CARD_POLY)}" fill="${hex(CARD)}"/>
  <polygon points="${points(ARROW_POLY)}" fill="${hex(ARROW)}"/>
</svg>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'icon.svg'), svg);
writeFileSync(join(OUT, 'icon-192.png'), png(192));
writeFileSync(join(OUT, 'icon-512.png'), png(512));
console.log(`Icônes écrites dans ${OUT}`);
