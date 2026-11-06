// Shared helpers for real-browser E2E tests.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'narada-e2e-'));

function check(cond, msg, detail) {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  console.log(`  ✓ ${msg}`);
}

async function waitFor(label, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// Test site: shows localStorage value in the title so we can verify storage transfer.
function startSite(port = 8765) {
  const server = http.createServer((q, r) => {
    r.setHeader('content-type', 'text/html; charset=utf-8');
    r.end('<title>Narada test</title><script>document.title = "ls=" + localStorage.getItem("k")</script>');
  });
  return new Promise((res) => server.listen(port, () => res(server)));
}

async function launchChromium(chromium, extPath, profileDir) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${sw.url().split('/')[2]}/popup.html`);
  const call = async (cmd, args = {}) => {
    const res = await page.evaluate(([c, a]) => chrome.runtime.sendMessage({ target: 'bg', cmd: c, args: a }), [cmd, args]);
    if (!res?.ok) throw new Error(`${cmd} failed: ${res?.error}`);
    return res.result;
  };
  return { ctx, page, call };
}

// Pair two endpoints, connect them, then send a tab with cookie + storage from `sender` to `receiver`.
async function pairConnectTransfer({ sender, receiver, openSenderTab, cookiesOf }) {
  console.log('pairing over public Nostr relays…');
  const { code } = await receiver.call('pairStart');
  check(/^NRD1-/.test(code), 'pairing code created');
  await sender.call('pairJoin', { code });
  const [ra, sa] = await waitFor('both sides reach SAS', async () => {
    const r = (await receiver.call('getState')).pairing;
    const s = (await sender.call('getState')).pairing;
    return r?.state === 'verify' && s?.state === 'verify' && [r, s];
  });
  check(ra.sas === sa.sas, 'both devices show the same SAS', [ra.sas, sa.sas]);
  await receiver.call('pairConfirm');
  await sender.call('pairConfirm');

  console.log('connecting over WebRTC…');
  await waitFor('peer connection', async () => {
    const r = (await receiver.call('getState')).devices[0];
    const s = (await sender.call('getState')).devices[0];
    return r?.status === 'connected' && s?.status === 'connected';
  }, 90_000);
  check(true, 'devices connected peer-to-peer');
  const relays = await waitFor('relay sockets closed', async () => {
    const r = (await sender.call('getState')).relays;
    return r.total === 0 && r;
  }, 15_000);
  check(relays.total === 0, 'no relay connections remain after handshake');

  console.log('sending a tab with cookies + storage…');
  const receiverId = (await receiver.call('getState')).device.id;
  const tabIds = await openSenderTab();
  const sent = await sender.call('sendTabs', { deviceId: receiverId, tabIds, cookies: true, storage: true });
  check(sent.count === 1, 'transfer sent', sent);
  const incoming = await waitFor('transfer arrives', async () => (await receiver.call('getState')).incoming[0], 15_000);
  check(incoming.tabs[0].cookieCount === 1 && incoming.tabs[0].storageKeys === 1, 'receiver sees cookie + storage summary', incoming.tabs[0]);
  const applied = await receiver.call('acceptTransfer', { id: incoming.id });
  check(applied.opened === 1 && applied.cookiesSet === 1 && applied.storageApplied === 1, 'transfer applied', applied);
  const cookies = await cookiesOf();
  check(cookies.some((c) => c.name === 'sid' && c.value === 'secret123' && c.httpOnly), 'HttpOnly cookie imported', cookies);
  const out = await waitFor('sender gets ack', async () => {
    const o = (await sender.call('getState')).outgoing[0];
    return o?.status === 'accepted' && o;
  }, 15_000);
  check(out.status === 'accepted', 'sender received "accepted" ack');

  const senderId = (await sender.call('getState')).device.id;
  await receiver.call('requestTabs', { deviceId: senderId });
  const remote = await waitFor('remote tab list', async () => (await receiver.call('getState')).remoteTabs[senderId], 10_000);
  check(remote.tabs.some((t) => t.url.startsWith('http://localhost')), 'receiver can list sender tabs');
}

module.exports = { sleep, tmpDir, check, waitFor, startSite, launchChromium, pairConnectTransfer };
