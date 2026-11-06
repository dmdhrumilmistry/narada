// Cross-browser E2E: Chromium (Playwright) <-> Firefox (Selenium/geckodriver).
// Env: PLAYWRIGHT (module path), FIREFOX_BIN, GECKODRIVER, optional HTTP_PROXY_HOSTPORT (host:port)
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const pathMod = require('path');
const os = require('os');
const tmp = require('fs').mkdtempSync(pathMod.join(os.tmpdir(), 'narada-'));
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = '11111111-2222-4333-8444-555555555555';
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<title>Bhagavatam</title><script>document.title="ls="+localStorage.getItem("k")</script>'); }).listen(8765);

(async () => {
  // ---- Chromium side
  const path = pathMod.resolve('test/e2e/.build/chromium');
  const ctx = await chromium.launchPersistentContext(tmp + '/A', { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const cp = await ctx.newPage(); await cp.goto(`chrome-extension://${sw.url().split('/')[2]}/popup.html`);
  const C = (cmd, args) => cp.evaluate(([cmd, args]) => chrome.runtime.sendMessage({ target: 'bg', cmd, args }), [cmd, args]);

  // ---- Firefox side
  const opts = new firefox.Options().setBinary(process.env.FIREFOX_BIN || 'firefox').addArguments('-headless')
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'narada@dmdhrumilmistry': UUID }))
    .setPreference('xpinstall.signatures.required', false);
  if (process.env.HTTP_PROXY_HOSTPORT) { // only for sandboxes that require an egress proxy
    const [host, port] = process.env.HTTP_PROXY_HOSTPORT.split(':');
    opts.setPreference('network.proxy.type', 1).setPreference('network.proxy.http', host).setPreference('network.proxy.http_port', Number(port))
      .setPreference('network.proxy.ssl', host).setPreference('network.proxy.ssl_port', Number(port))
      .setPreference('network.proxy.no_proxies_on', 'localhost, 127.0.0.1');
  }
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts)
    .setFirefoxService(new firefox.ServiceBuilder(process.env.GECKODRIVER || 'geckodriver')).build();
  await driver.installAddon(pathMod.resolve('test/e2e/.build/narada-firefox-test.xpi'), true);
  await sleep(1500);
  for (const hnd of await driver.getAllWindowHandles()) {
    await driver.switchTo().window(hnd);
    if ((await driver.getCurrentUrl()).startsWith('moz-extension://')) break;
  }
  console.log('FF page', await driver.getCurrentUrl());
  const F = (cmd, args) => driver.executeAsyncScript(
    'const cb = arguments[arguments.length - 1]; browser.runtime.sendMessage({target: "bg", cmd: arguments[0], args: arguments[1]}).then(cb, (e) => cb({ok: false, error: String(e)}));', cmd, args ?? {});

  try {
    console.log('FF state', JSON.stringify((await F('getState')).result?.device), 'webrtc', (await F('getState')).result?.webrtc);
    const start = await F('pairStart');
    console.log('FF pairStart', start.ok, start.result?.state);
    console.log('Chromium join', (await C('pairJoin', { code: start.result.code })).ok);
    for (let i = 0; i < 30; i++) {
      const a = (await F('getState')).result, b = (await C('getState')).result;
      console.log('pair', a.pairing?.state, b.pairing?.state, a.pairing?.sas, b.pairing?.sas);
      if (a.pairing?.state === 'verify' && b.pairing?.state === 'verify') break;
      await sleep(1000);
    }
    console.log('confirm', JSON.stringify(await F('pairConfirm')), JSON.stringify(await C('pairConfirm')));
    for (let i = 0; i < 45; i++) {
      const a = (await F('getState')).result, b = (await C('getState')).result;
      console.log('conn FF:', a.devices[0]?.status, a.devices[0]?.issue, 'CR:', b.devices[0]?.status, b.devices[0]?.issue, 'FF relays', JSON.stringify(a.relays));
      if (a.devices[0]?.status === 'connected' && b.devices[0]?.status === 'connected') break;
      await sleep(1000);
    }
    const ffId = (await F('getState')).result.device.id;
    const pg = await ctx.newPage(); await pg.goto('http://localhost:8765/');
    await ctx.addCookies([{ name: 'sid', value: 'secret123', domain: 'localhost', path: '/', httpOnly: true, expires: Date.now() / 1000 + 3600 }]);
    await pg.evaluate(() => localStorage.setItem('k', 'v1'));
    const tabs = (await cp.evaluate(() => chrome.tabs.query({}))).filter((t) => t.url.startsWith('http'));
    console.log('CR -> FF send', JSON.stringify(await C('sendTabs', { deviceId: ffId, tabIds: tabs.map((t) => t.id), cookies: true, storage: true })));
    await sleep(2000);
    const inc = (await F('getState')).result.incoming;
    console.log('FF incoming', JSON.stringify(inc));
    if (inc[0]) console.log('FF accept', JSON.stringify(await F('acceptTransfer', { id: inc[0].id })));
    await sleep(3000);
    const ffCookies = await driver.executeAsyncScript('const cb=arguments[arguments.length-1]; browser.cookies.getAll({url:"http://localhost:8765/"}).then(cb, e=>cb(String(e)))');
    console.log('FF cookies', JSON.stringify(ffCookies));
    const ffTabs = await driver.executeAsyncScript('const cb=arguments[arguments.length-1]; browser.tabs.query({}).then(t=>cb(t.map(x=>[x.url,x.title])))');
    console.log('FF tabs', JSON.stringify(ffTabs));
    // reverse direction: Firefox lists Chromium's tabs
    const crId = (await C('getState')).result.device.id;
    await F('requestTabs', { deviceId: crId }); await sleep(1000);
    console.log('FF sees CR tabs', JSON.stringify((await F('getState')).result.remoteTabs));
    console.log('CR outgoing', JSON.stringify((await C('getState')).result.outgoing), 'relays after', JSON.stringify((await C('getState')).result.relays));
  } finally {
    await driver.quit(); await ctx.close(); process.exit(0);
  }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
