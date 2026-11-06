// Builds dist/chrome (MV3, service worker + offscreen) and dist/firefox (MV2, persistent background).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const watch = process.argv.includes('--watch');

const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self'";
const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const common = {
  name: 'WebSync — P2P Tab Sync',
  short_name: 'WebSync',
  version: pkg.version,
  description: 'Sync selected tabs (optionally with cookies & site data) between your browsers over end-to-end encrypted WebRTC. No central server.',
  icons,
  incognito: 'not_allowed',
};

const manifests = {
  chrome: {
    manifest_version: 3,
    ...common,
    minimum_chrome_version: '116',
    background: { service_worker: 'background.js' },
    action: { default_popup: 'popup.html', default_icon: icons, default_title: 'WebSync' },
    permissions: ['tabs', 'storage', 'notifications', 'scripting', 'offscreen'],
    optional_permissions: ['cookies'],
    optional_host_permissions: ['<all_urls>'],
    content_security_policy: { extension_pages: CSP },
  },
  firefox: {
    manifest_version: 2,
    ...common,
    background: { scripts: ['background.js'], persistent: true },
    browser_action: { default_popup: 'popup.html', default_icon: icons, default_title: 'WebSync' },
    permissions: ['tabs', 'storage', 'notifications', 'scripting'],
    optional_permissions: ['cookies', '<all_urls>'],
    content_security_policy: CSP,
    browser_specific_settings: { gecko: { id: 'websync@dmdhrumilmistry', strict_min_version: '115.0' } },
  },
};

for (const target of ['chrome', 'firefox']) {
  const out = `dist/${target}`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const entryPoints = {
    background: target === 'chrome' ? 'src/background/chrome-bg.js' : 'src/background/firefox-bg.js',
    popup: 'src/popup/popup.js',
  };
  if (target === 'chrome') entryPoints.offscreen = 'src/offscreen/offscreen.js';
  const opts = {
    entryPoints, outdir: out, bundle: true, format: 'iife', target: ['chrome116', 'firefox115'],
    minify: false, sourcemap: false, legalComments: 'inline', logLevel: 'info',
  };
  await build(opts);
  cpSync('src/popup/popup.html', `${out}/popup.html`);
  cpSync('src/popup/popup.css', `${out}/popup.css`);
  cpSync('src/icons', `${out}/icons`, { recursive: true });
  if (target === 'chrome') {
    writeFileSync(`${out}/offscreen.html`, readFileSync('src/offscreen/offscreen.html', 'utf8').replace('type="module" ', ''));
  }
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifests[target], null, 2));
}
if (watch) console.log('watch mode not implemented; re-run npm run build');
