// E2E: Chromium (Playwright) <-> Firefox (Selenium/geckodriver), cross-browser.
// Run `npm run e2e:prepare` first.
// Env: PLAYWRIGHT (module path, optional), FIREFOX_BIN, GECKODRIVER,
//      HTTP_PROXY_HOSTPORT (host:port, only for sandboxes that require an egress proxy).
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { tmpDir, startSite, launchChromium, pairConnectTransfer, featureChecks, telemetryChecks, startCollector, check, sleep } = require('./lib.cjs');

const UUID = '11111111-2222-4333-8444-555555555555';

async function launchFirefox() {
  const opts = new firefox.Options().addArguments('-headless')
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'narada@dmdhrumilmistry': UUID }))
    .setPreference('xpinstall.signatures.required', false);
  if (process.env.FIREFOX_BIN) opts.setBinary(process.env.FIREFOX_BIN);
  if (process.env.HTTP_PROXY_HOSTPORT) {
    const [host, port] = process.env.HTTP_PROXY_HOSTPORT.split(':');
    opts.setPreference('network.proxy.type', 1)
      .setPreference('network.proxy.http', host).setPreference('network.proxy.http_port', Number(port))
      .setPreference('network.proxy.ssl', host).setPreference('network.proxy.ssl_port', Number(port))
      .setPreference('network.proxy.no_proxies_on', 'localhost, 127.0.0.1');
  }
  const builder = new Builder().forBrowser('firefox').setFirefoxOptions(opts);
  if (process.env.GECKODRIVER) builder.setFirefoxService(new firefox.ServiceBuilder(process.env.GECKODRIVER));
  const driver = await builder.build();
  // FIREFOX_XPI=…android-sim.xpi runs the suite against the Firefox-for-Android API surface.
  await driver.installAddon(path.resolve(process.env.FIREFOX_XPI || 'test/e2e/.build/narada-firefox-test.xpi'), true);
  // The test build opens its popup in a tab (WebDriver may not navigate to moz-extension://).
  for (let i = 0; i < 20; i++) {
    for (const hnd of await driver.getAllWindowHandles()) {
      await driver.switchTo().window(hnd);
      if ((await driver.getCurrentUrl()).startsWith('moz-extension://')) i = 99;
      if (i === 99) break;
    }
    if (i !== 99) await sleep(500);
  }
  const exec = (script, ...args) => driver.executeAsyncScript(
    `const cb = arguments[arguments.length - 1]; (async () => { ${script} })().then(cb, (e) => cb({ __error: String(e) }));`, ...args);
  const call = async (cmd, args = {}) => {
    const res = await exec('return browser.runtime.sendMessage({ target: "bg", cmd: arguments[0], args: arguments[1] });', cmd, args);
    if (!res?.ok) throw new Error(`firefox ${cmd} failed: ${res?.error ?? res?.__error}`);
    return res.result;
  };
  return { driver, exec, call };
}

(async () => {
  const site = await startSite();
  const ext = path.resolve('test/e2e/.build/chromium');
  const C = await launchChromium(chromium, ext, `${tmpDir()}/C`);
  const F = await launchFirefox();
  try {
    check((await F.call('getState')).webrtc === true, 'Firefox engine has WebRTC');
    if (process.env.FIREFOX_XPI?.includes('android')) {
      check((await F.call('getState')).platform === 'android', 'running against the Firefox-for-Android API surface');
    }
    await pairConnectTransfer({
      sender: C,
      receiver: F,
      openSenderTab: async () => {
        const pg = await C.ctx.newPage();
        await pg.goto('http://localhost:8765/');
        await C.ctx.addCookies([{ name: 'sid', value: 'secret123', domain: 'localhost', path: '/', httpOnly: true, expires: Date.now() / 1000 + 3600 }]);
        await pg.evaluate(() => localStorage.setItem('k', 'v1'));
        const tabs = await C.page.evaluate(() => chrome.tabs.query({ url: 'http://localhost/*' }));
        return tabs.map((t) => t.id);
      },
      cookiesOf: () => F.exec('return browser.cookies.getAll({ url: "http://localhost:8765/" });'),
    });
    await sleep(2000);
    const titles = await F.exec('return (await browser.tabs.query({})).map((t) => t.title);');
    check(titles.includes('ls=v1'), 'localStorage restored in Firefox', titles);
    await featureChecks({
      sender: C,
      receiver: F,
      receiverTabUrls: () => F.exec('return (await browser.tabs.query({})).map((t) => t.url);'),
      senderTabIds: async () => (await C.page.evaluate(() => chrome.tabs.query({ url: 'http://localhost/*' }))).map((t) => t.id).slice(0, 1),
    });
    const collector = await startCollector();
    await telemetryChecks({ sender: C, receiver: F, collector, senderTabIds: async () => (await C.page.evaluate(() => chrome.tabs.query({ url: 'http://localhost/*' }))).map((t) => t.id).slice(0, 1) });
    collector.server.close();
    console.log('PASS chromium-to-firefox');
  } finally {
    await F.driver.quit();
    await C.ctx.close();
    site.close();
  }
})().then(() => process.exit(0), (e) => { console.error(e.message || e); process.exit(1); });
