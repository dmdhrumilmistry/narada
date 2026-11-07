// Makes test copies of the builds with cookie/host permissions pre-granted
// (automation cannot click permission prompts), and makes the Firefox copy open
// its popup in a tab (WebDriver may not navigate to moz-extension:// URLs).
import { cpSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const out = 'test/e2e/.build';
rmSync(out, { recursive: true, force: true });
cpSync('dist/chromium', `${out}/chromium`, { recursive: true });
cpSync('dist/firefox', `${out}/firefox`, { recursive: true });
const edit = (f, fn) => writeFileSync(f, JSON.stringify(fn(JSON.parse(readFileSync(f, 'utf8')))));
edit(`${out}/chromium/manifest.json`, (m) => ({ ...m, permissions: [...m.permissions, 'cookies'], host_permissions: ['<all_urls>'] }));
edit(`${out}/firefox/manifest.json`, (m) => ({ ...m, permissions: [...m.permissions, 'cookies', '<all_urls>'] }));
appendFileSync(`${out}/firefox/background.js`, ';browser.tabs.create({url: "popup.html"});\n');
execSync(`cd ${out}/firefox && zip -qr ../narada-firefox-test.xpi .`);

// "Android simulation": the same add-on with exactly the APIs Firefox for Android lacks
// removed (menus, commands, windows, badge, notifications, managed storage), the
// platform reported as android, and pinned tabs rejected. Running the full suite
// against it proves every such call degrades gracefully.
cpSync(`${out}/firefox`, `${out}/firefox-android`, { recursive: true });
const PRELUDE = `(() => {
  const real = globalThis.browser;
  const hide = (obj, keys, overrides = {}) => new Proxy(obj, {
    get(t, k) {
      if (keys.includes(k)) return undefined;
      if (k in overrides) return overrides[k];
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
    has(t, k) { return !keys.includes(k) && k in t; },
  });
  const tabs = hide(real.tabs, [], {
    create: (props) => (props && 'pinned' in props) ? Promise.reject(new Error('pinned is not supported on Android')) : real.tabs.create(props),
  });
  const shim = hide(real, ['menus', 'contextMenus', 'commands', 'windows', 'notifications'], {
    runtime: hide(real.runtime, [], { getPlatformInfo: async () => ({ os: 'android', arch: 'arm64' }) }),
    browserAction: hide(real.browserAction, ['setBadgeText', 'setBadgeBackgroundColor']),
    storage: hide(real.storage, ['managed']),
    tabs,
  });
  Object.defineProperty(globalThis, 'browser', { value: shim, configurable: true });
})();
`;
writeFileSync(`${out}/firefox-android/background.js`, PRELUDE + readFileSync(`${out}/firefox-android/background.js`, 'utf8'));
execSync(`cd ${out}/firefox-android && zip -qr ../narada-firefox-android-sim.xpi .`);
console.log('prepared', out);
