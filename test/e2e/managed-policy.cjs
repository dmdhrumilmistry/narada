// E2E: organization policy really reaches Narada through each browser's enterprise
// policy mechanism, overrides user settings, locks them, and is enforced.
//  - Chromium: /etc/chromium/policies/managed/*.json (needs root; CI uses sudo)
//  - Firefox (optional, when FIREFOX_BIN is set): <firefox>/distribution/policies.json
// Run `npm run e2e:prepare` first. Env: PLAYWRIGHT, POLICY_DIR, FIREFOX_BIN, GECKODRIVER.
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { tmpDir, launchChromium, check, waitFor, sleep } = require('./lib.cjs');

const POLICY = {
  allowNotes: false,
  allowCookieTransfer: false,
  relays: ['wss://relay.corp.example'],
  telemetry: { enabled: true, endpoint: 'https://otel.corp.example', logLevel: 'warn', headers: { Authorization: 'Bearer corp-secret' } },
};

async function verify(label, call) {
  const s = await waitFor(`${label}: policy applied`, async () => {
    const st = await call('getState');
    return st.managed && st;
  }, 20_000);
  check(s.managed === true, `${label}: Narada sees organization policy`);
  check(s.settings.allowNotes === false && s.settings.allowCookieTransfer === false, `${label}: policy values are in effect`);
  check(['allowNotes', 'allowCookieTransfer', 'relays', 'telemetry.endpoint'].every((k) => s.locked.includes(k)), `${label}: policy keys are locked`, s.locked);
  check(s.settings.relays[0] === 'wss://relay.corp.example', `${label}: managed relays used`);
  check(s.settings.telemetry.endpoint === 'https://otel.corp.example/v1/logs', `${label}: managed OTLP endpoint`);
  check(s.settings.telemetry.headers.Authorization === '••••', `${label}: managed header secret never reaches the popup`);
  check(!s.locked.includes('keepHistory'), `${label}: unmanaged settings stay user-controlled`);
  await call('setSettings', { allowNotes: true, keepHistory: false });
  const after = await call('getState');
  check(after.settings.allowNotes === false, `${label}: user cannot override a locked setting`);
  check(after.settings.keepHistory === false, `${label}: user can still change unlocked settings`);
  let err = '';
  try { await call('pairStart'); await call('pairCancel'); } catch (e) { err = e.message; }
  check(!err, `${label}: pairing still allowed (not in policy)`, err);
  try { await call('sendNote', { deviceId: 'x', text: 'hi' }); } catch (e) { err = e.message; }
  check(/organization/.test(err), `${label}: blocked actions say it is the organization's policy`, err);
}

async function chromiumCase() {
  const ext = path.resolve('test/e2e/.build/chromium');
  const profile = `${tmpDir()}/P`;
  // First launch: learn the extension id (it depends on the unpacked path).
  let b = await launchChromium(chromium, ext, profile);
  const id = new URL(b.page.url()).host;
  await b.ctx.close();
  // Linux policy directories differ per build: Chromium, Google Chrome, Chrome for Testing.
  const dirs = process.env.POLICY_DIR ? [process.env.POLICY_DIR]
    : ['/etc/chromium/policies/managed', '/etc/opt/chrome/policies/managed', '/etc/opt/chrome_for_testing/policies/managed'];
  const files = dirs.map((d) => path.join(d, 'narada-e2e.json'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ '3rdparty': { extensions: { [id]: POLICY } } }));
  }
  try {
    b = await launchChromium(chromium, ext, profile);
    await verify('Chromium', b.call);
    await b.ctx.close();
  } finally {
    for (const f of files) fs.rmSync(f, { force: true });
  }
}

async function firefoxCase() {
  if (!process.env.FIREFOX_BIN) { console.log('(skipping Firefox: FIREFOX_BIN not set)'); return; }
  const { Builder } = require('selenium-webdriver');
  const firefox = require('selenium-webdriver/firefox');
  const distDir = path.join(path.dirname(process.env.FIREFOX_BIN), 'distribution');
  const policyFile = path.join(distDir, 'policies.json');
  const backup = fs.existsSync(policyFile) ? fs.readFileSync(policyFile, 'utf8') : null;
  const existing = backup ? JSON.parse(backup) : { policies: {} };
  existing.policies['3rdparty'] = { Extensions: { 'narada@dmdhrumilmistry': POLICY } };
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(policyFile, JSON.stringify(existing));
  const opts = new firefox.Options().addArguments('-headless').setBinary(process.env.FIREFOX_BIN)
    .setPreference('xpinstall.signatures.required', false)
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'narada@dmdhrumilmistry': '11111111-2222-4333-8444-555555555555' }));
  const builder = new Builder().forBrowser('firefox').setFirefoxOptions(opts);
  if (process.env.GECKODRIVER) builder.setFirefoxService(new firefox.ServiceBuilder(process.env.GECKODRIVER));
  const driver = await builder.build();
  try {
    await driver.installAddon(path.resolve('test/e2e/.build/narada-firefox-test.xpi'), true);
    for (let i = 0; i < 20; i++) {
      let found = false;
      for (const h of await driver.getAllWindowHandles()) {
        await driver.switchTo().window(h);
        if ((await driver.getCurrentUrl()).startsWith('moz-extension://')) { found = true; break; }
      }
      if (found) break;
      await sleep(500);
    }
    const call = async (cmd, args = {}) => {
      const res = await driver.executeAsyncScript(
        'const cb = arguments[arguments.length - 1]; browser.runtime.sendMessage({ target: "bg", cmd: arguments[0], args: arguments[1] }).then(cb, (e) => cb({ ok: false, error: String(e) }));', cmd, args);
      if (!res?.ok) throw new Error(`${cmd} failed: ${res?.error}`);
      return res.result;
    };
    await verify('Firefox', call);
  } finally {
    await driver.quit();
    if (backup === null) fs.rmSync(policyFile, { force: true }); else fs.writeFileSync(policyFile, backup);
  }
}

(async () => {
  await chromiumCase();
  await firefoxCase();
  console.log('PASS managed-policy');
})().then(() => process.exit(0), (e) => { console.error(e.message || e); process.exit(1); });
