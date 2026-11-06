// Generates the Narada mascot SVG and renders PNG toolbar icons from it.
// Usage: node scripts/make-icons.mjs   (PNG rendering needs Playwright + Chromium)
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const INK = '#1b1b1b';
const burst = (cx, cy, rOut, rIn, n) => Array.from({ length: n * 2 }, (_, i) => {
  const r = i % 2 ? rIn : rOut;
  const a = (Math.PI * i) / n - Math.PI / 2;
  return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
}).join(' ');

export const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Narada Muni">
  <polygon points="${burst(64, 64, 62, 50, 14)}" fill="#ffd23f" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
  <!-- veena -->
  <line x1="24" y1="108" x2="102" y2="22" stroke="${INK}" stroke-width="11" stroke-linecap="round"/>
  <line x1="24" y1="108" x2="102" y2="22" stroke="#a0522d" stroke-width="5" stroke-linecap="round"/>
  <circle cx="26" cy="104" r="15" fill="#e63b2e" stroke="${INK}" stroke-width="4"/>
  <circle cx="21" cy="99" r="4" fill="#fff" opacity=".7"/>
  <circle cx="99" cy="26" r="9" fill="#e63b2e" stroke="${INK}" stroke-width="4"/>
  <!-- robe -->
  <path d="M30 124 Q64 80 98 124 Z" fill="#ff9933" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M50 106 L64 124 L78 106" fill="none" stroke="#e63b2e" stroke-width="3"/>
  <!-- head -->
  <circle cx="64" cy="35" r="10" fill="${INK}"/>
  <circle cx="64" cy="66" r="25" fill="#f6c48e" stroke="${INK}" stroke-width="4"/>
  <path d="M40 62 Q64 30 88 62 Q64 47 40 62 Z" fill="${INK}"/>
  <!-- tilak -->
  <path d="M57 50 v7 q7 7 14 0 v-7" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>
  <line x1="64" y1="51" x2="64" y2="60" stroke="#e63b2e" stroke-width="3" stroke-linecap="round"/>
  <!-- happy closed eyes, smile, cheeks -->
  <path d="M50 70 q5 -5 10 0" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M68 70 q5 -5 10 0" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M55 79 q9 9 18 0" fill="#c0392b" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="48" cy="77" r="4" fill="#ff7f7f" opacity=".7"/>
  <circle cx="80" cy="77" r="4" fill="#ff7f7f" opacity=".7"/>
</svg>
`;

mkdirSync('src/assets', { recursive: true });
writeFileSync('src/assets/narada.svg', svg);

let chromium;
// createRequire honours NODE_PATH, so a globally installed Playwright works too.
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { console.log('playwright not found: SVG written, PNG icons unchanged'); process.exit(0); }
const browser = await chromium.launch();
const page = await browser.newPage();
mkdirSync('src/icons', { recursive: true });
for (const s of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${s}" height="${s}">`);
  await page.screenshot({ path: `src/icons/icon${s}.png`, omitBackground: true });
}
await browser.close();
console.log('icons written');
