// Env: PLAYWRIGHT (module path, optional)
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const os = require('os');
const tmp = require('fs').mkdtempSync(require('path').join(os.tmpdir(), 'narada-'));
const path = require('path').resolve('test/e2e/.build/chromium');
const http=require('http');http.createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<title>Test page</title><script>document.title="ls="+localStorage.getItem("k")+" ck="+document.cookie</script>')}).listen(8765);
async function launch(dir) {
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, channel: 'chromium', args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const page = await ctx.newPage();
  page.on('console', (m) => console.log(dir.slice(-1), 'popup console:', m.text()));
  await page.goto(`chrome-extension://${id}/popup.html`);
  return { ctx, page, id };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const A = await launch(tmp + '/A');
  const B = await launch(tmp + '/B');
  const call = (p, cmd, args) => p.page.evaluate(([cmd, args]) => chrome.runtime.sendMessage({ target: 'bg', cmd, args }), [cmd, args]);
  console.log('A state', JSON.stringify((await call(A, 'getState')).result.device));
  const start = await call(A, 'pairStart');
  console.log('pairStart', start.ok, start.result?.state);
  await call(B, 'pairJoin', { code: start.result.code });
  for (let i = 0; i < 40; i++) {
    const a = (await call(A, 'getState')).result, b = (await call(B, 'getState')).result;
    console.log(i, 'relays', JSON.stringify(a.relays), a.pairing?.state, b.pairing?.state, a.pairing?.sas, b.pairing?.sas);
    if (a.pairing?.state === 'verify' && b.pairing?.state === 'verify') break;
    await sleep(1000);
  }
  console.log(await call(A, 'pairConfirm'), await call(B, 'pairConfirm'));
  for (let i = 0; i < 40; i++) {
    const a = (await call(A, 'getState')).result, b = (await call(B, 'getState')).result;
    console.log('conn', a.devices[0]?.status, b.devices[0]?.status, JSON.stringify(a.relays));
    if (a.devices[0]?.status === 'connected' && b.devices[0]?.status === 'connected') break;
    await sleep(1000);
  }
  const bId = (await call(B, 'getState')).result.device.id;
  console.log('requestTabs', await call(A, 'requestTabs', { deviceId: bId }));
  await sleep(1000);
  console.log('remote tabs', JSON.stringify((await call(A, 'getState')).result.remoteTabs).slice(0, 300));
  const pg = await A.ctx.newPage(); await pg.goto('http://localhost:8765/');
  await A.ctx.addCookies([{name:'sid',value:'secret123',domain:'localhost',path:'/',httpOnly:true,expires:Date.now()/1000+3600}]);
  await pg.evaluate(()=>{localStorage.setItem('k','v1');});
  const tabs = (await A.page.evaluate(() => chrome.tabs.query({}))).filter(t=>t.url.startsWith('http'));
  console.log('send', JSON.stringify(await call(A, 'sendTabs', { deviceId: bId, tabIds: tabs.map(t=>t.id), cookies: true, storage: true })));
  await sleep(1500);
  const inc = (await call(B, 'getState')).result.incoming;
  console.log('incoming at B', JSON.stringify(inc));
  if (inc[0]) console.log('accept', JSON.stringify(await call(B, 'acceptTransfer', { id: inc[0].id })));
  await sleep(3000);
  for (const p of B.ctx.pages()) console.log('B page', p.url(), await p.title());
  console.log('B cookies', JSON.stringify(await B.ctx.cookies('http://localhost:8765')));
  console.log('A outgoing', JSON.stringify((await call(A, 'getState')).result.outgoing), 'relays after connect', JSON.stringify((await call(A, 'getState')).result.relays));
  for (const X of [A, B]) console.log('engine host pages', X.ctx.pages().filter(p => p.url().endsWith('offscreen.html')).length);
  await A.ctx.close(); await B.ctx.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
