// Builds dist/chromium (MV3, service worker + offscreen) and dist/firefox (MV2, persistent background).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const watch = process.argv.includes('--watch');

const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self'";
// Bundled comic fonts (SIL Open Font License), so no remote font loading.
const FONTS = {
  bangers: ['bangers-latin-400-normal.woff2'],
  'comic-neue': ['comic-neue-latin-400-normal.woff2', 'comic-neue-latin-700-normal.woff2'],
};
const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const common = {
  name: 'Narada: P2P Tab & Session Sync',
  short_name: 'Narada',
  author: 'dmdhrumilmistry',
  version: pkg.version,
  description: 'Narayan Narayan! Send selected tabs (optionally with cookies & site data) between your browsers over end-to-end encrypted P2P WebRTC. No central server.',
  icons,
  incognito: 'not_allowed',
};

const manifests = {
  chromium: {
    manifest_version: 3,
    ...common,
    minimum_chrome_version: '116',
    background: { service_worker: 'background.js' },
    action: { default_popup: 'popup.html', default_icon: icons, default_title: 'Narada' },
    permissions: ['tabs', 'storage', 'notifications', 'scripting', 'offscreen'],
    optional_permissions: ['cookies'],
    optional_host_permissions: ['<all_urls>'],
    content_security_policy: { extension_pages: CSP },
  },
  firefox: {
    manifest_version: 2,
    ...common,
    background: { scripts: ['background.js'], persistent: true },
    browser_action: { default_popup: 'popup.html', default_icon: icons, default_title: 'Narada' },
    permissions: ['tabs', 'storage', 'notifications', 'scripting'],
    optional_permissions: ['cookies', '<all_urls>'],
    content_security_policy: CSP,
    // Nothing is collected by or sent to the developer; relays only see encrypted handshakes.
    browser_specific_settings: { gecko: { id: 'narada@dmdhrumilmistry', strict_min_version: '115.0', data_collection_permissions: { required: ['none'] } } },
  },
};

for (const target of ['chromium', 'firefox']) {
  const out = `dist/${target}`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const entryPoints = {
    background: target === 'chromium' ? 'src/background/chrome-bg.js' : 'src/background/firefox-bg.js',
    popup: 'src/popup/popup.js',
  };
  if (target === 'chromium') entryPoints.offscreen = 'src/offscreen/offscreen.js';
  const opts = {
    entryPoints, outdir: out, bundle: true, format: 'iife', target: ['chrome116', 'firefox115'],
    minify: false, sourcemap: false, legalComments: 'inline', logLevel: 'info',
  };
  await build(opts);
  cpSync('src/popup/popup.html', `${out}/popup.html`);
  cpSync('src/popup/popup.css', `${out}/popup.css`);
  cpSync('src/icons', `${out}/icons`, { recursive: true });
  cpSync('src/assets', `${out}/assets`, { recursive: true });
  mkdirSync(`${out}/fonts`, { recursive: true });
  for (const [pkgName, files] of Object.entries(FONTS)) {
    for (const f of files) cpSync(`node_modules/@fontsource/${pkgName}/files/${f}`, `${out}/fonts/${f}`);
    cpSync(`node_modules/@fontsource/${pkgName}/LICENSE`, `${out}/fonts/LICENSE-${pkgName}.txt`);
  }
  if (target === 'chromium') {
    writeFileSync(`${out}/offscreen.html`, readFileSync('src/offscreen/offscreen.html', 'utf8').replace('type="module" ', ''));
  }
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifests[target], null, 2));
}
if (watch) console.log('watch mode not implemented; re-run npm run build');
