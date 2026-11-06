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
console.log('prepared', out);
