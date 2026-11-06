// E2E: two Chromium profiles pair, connect and transfer a tab with cookies + storage.
// Run `npm run e2e:prepare` first. Env: PLAYWRIGHT (module path, optional).
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { tmpDir, startSite, launchChromium, pairConnectTransfer, featureChecks, telemetryChecks, startCollector, check, waitFor } = require('./lib.cjs');

(async () => {
  const site = await startSite();
  const ext = path.resolve('test/e2e/.build/chromium');
  const dir = tmpDir();
  const A = await launchChromium(chromium, ext, `${dir}/A`);
  const B = await launchChromium(chromium, ext, `${dir}/B`);
  try {
    await pairConnectTransfer({
      sender: A,
      receiver: B,
      openSenderTab: async () => {
        const pg = await A.ctx.newPage();
        await pg.goto('http://localhost:8765/');
        await A.ctx.addCookies([{ name: 'sid', value: 'secret123', domain: 'localhost', path: '/', httpOnly: true, expires: Date.now() / 1000 + 3600 }]);
        await pg.evaluate(() => localStorage.setItem('k', 'v1'));
        const tabs = await A.page.evaluate(() => chrome.tabs.query({ url: 'http://localhost/*' }));
        return tabs.map((t) => t.id);
      },
      cookiesOf: () => B.ctx.cookies('http://localhost:8765/'),
    });
    const page = await waitFor('storage applied in new tab', async () => {
      for (const p of B.ctx.pages()) if ((await p.title().catch(() => '')) === 'ls=v1') return p;
      return null;
    }, 15_000);
    check(!!page, 'localStorage restored on receiver');
    await featureChecks({
      sender: A,
      receiver: B,
      receiverTabUrls: async () => B.ctx.pages().map((p) => p.url()),
      senderTabIds: async () => (await A.page.evaluate(() => chrome.tabs.query({ url: 'http://localhost/*' }))).map((t) => t.id).slice(0, 1),
    });
    const collector = await startCollector();
    await telemetryChecks({ sender: A, receiver: B, collector, senderTabIds: async () => (await A.page.evaluate(() => chrome.tabs.query({ url: 'http://localhost/*' }))).map((t) => t.id).slice(0, 1) });
    collector.server.close();
    console.log('PASS chromium-to-chromium');
  } finally {
    await A.ctx.close();
    await B.ctx.close();
    site.close();
  }
})().then(() => process.exit(0), (e) => { console.error(e.message || e); process.exit(1); });
