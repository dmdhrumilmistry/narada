// Generates the Narada mascot SVG and renders PNG toolbar icons from it.
// Usage: node scripts/make-icons.mjs   (PNG rendering needs Playwright + Chromium)
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// Mark: a minimal veena, two gourds joined by the neck, which also reads as two
// linked devices. Brass on indigo, with a saffron tilak dot.
export const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Narada">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2e2a6b"/><stop offset="1" stop-color="#14122b"/></linearGradient>
    <linearGradient id="brass" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#b8862b"/><stop offset="1" stop-color="#f0c766"/></linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#bg)"/>
  <g stroke="#f0c766" stroke-opacity=".35" stroke-width="1.6">
    <line x1="40" y1="96" x2="92" y2="36"/><line x1="34" y1="90" x2="86" y2="30"/>
  </g>
  <line x1="40" y1="88" x2="94" y2="34" stroke="url(#brass)" stroke-width="9" stroke-linecap="round"/>
  <circle cx="38" cy="90" r="20" fill="url(#brass)"/>
  <circle cx="38" cy="90" r="8" fill="#14122b" opacity=".35"/>
  <circle cx="96" cy="32" r="11" fill="url(#brass)"/>
  <circle cx="96" cy="32" r="4" fill="#e8772e"/>
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
