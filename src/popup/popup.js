// Popup UI. All untrusted strings are rendered with textContent only.
import { api } from '../shared/api.js';
import { safeHttpUrl } from '../shared/validate.js';

const SENSITIVE_PERMS = { permissions: ['cookies'], origins: ['<all_urls>'] };
const $ = (id) => document.getElementById(id);
let state = null;
let settingsLoaded = false;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== undefined && v !== false) el[k] = v;
  }
  for (const c of children.flat()) if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

async function call(cmd, args = {}) {
  const res = await api.runtime.sendMessage({ target: 'bg', cmd, args });
  if (!res?.ok) throw new Error(res?.error || 'No response');
  return res.result;
}

function showError(e) {
  const el = $('error');
  el.textContent = e ? (e.message || String(e)) : '';
  el.hidden = !e;
}

const guard = (fn) => async (...a) => { try { showError(null); await fn(...a); } catch (e) { showError(e); } };
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };

// Must run synchronously inside the click handler (Firefox requires a user gesture).
function requestSensitive() { return api.permissions.request(SENSITIVE_PERMS); }

// ---------- navigation ----------
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('main section').forEach((s) => { s.hidden = s.id !== 'view-' + b.dataset.view; });
}));

// ---------- send ----------
async function loadTabs() {
  const tabs = await api.tabs.query({ currentWindow: true });
  const list = $('tabList');
  list.replaceChildren(...tabs.filter((t) => safeHttpUrl(t.url)).map((t) => h('li', {},
    h('input', { type: 'checkbox', value: String(t.id), checked: t.active }),
    h('span', { class: 'grow ellipsis', title: t.url }, t.title || t.url))));
}

$('reloadTabs').addEventListener('click', guard(loadTabs));
$('selectAll').addEventListener('change', (e) => {
  $('tabList').querySelectorAll('input').forEach((c) => { c.checked = e.target.checked; });
});

for (const id of ['optCookies', 'optStorage']) {
  $(id).addEventListener('change', (e) => {
    $('sensitiveWarn').hidden = !($('optCookies').checked || $('optStorage').checked);
    if (!e.target.checked) return;
    requestSensitive().then((granted) => {
      if (!granted) { e.target.checked = false; showError(new Error('Permission is needed to read cookies/site data.')); }
      $('sensitiveWarn').hidden = !($('optCookies').checked || $('optStorage').checked);
    });
  });
}

$('sendBtn').addEventListener('click', guard(async () => {
  const deviceId = $('target').value;
  const tabIds = [...$('tabList').querySelectorAll('input:checked')].map((c) => Number(c.value));
  if (!deviceId) throw new Error('No connected device selected');
  if (!tabIds.length) throw new Error('Select at least one tab');
  const cookies = $('optCookies').checked;
  const storage = $('optStorage').checked;
  if ((cookies || storage) && !confirm('Send login cookies/site data for the selected tabs to this device?')) return;
  $('sendBtn').disabled = true;
  try {
    const r = await call('sendTabs', { deviceId, tabIds, cookies, storage });
    $('sendResult').textContent = `Sent ${r.count} tab(s). Waiting for the other device to accept.` + (r.warnings?.length ? ' ' + r.warnings.join('; ') : '');
  } finally {
    $('sendBtn').disabled = false;
  }
}));

// ---------- pairing ----------
$('pairStart').addEventListener('click', guard(async () => { await call('pairStart'); await refresh(); }));
$('pairJoin').addEventListener('click', guard(async () => {
  await call('pairJoin', { code: $('pairCode').value.trim() });
  $('pairCode').value = '';
  await refresh();
}));

function renderPairing(p) {
  const box = $('pairing');
  $('pairControls').hidden = !!p && !['failed', 'done'].includes(p.state);
  if (!p) return box.replaceChildren();
  const cancel = h('button', { onclick: guard(async () => { await call('pairCancel'); await refresh(); }) }, 'Cancel');
  if (p.state === 'waiting' && p.role === 'initiator') {
    const mins = Math.max(0, Math.round((p.expiresAt - Date.now()) / 60000));
    box.replaceChildren(
      h('p', { class: 'small' }, `Enter this one-time code on your other device (expires in ~${mins} min). Keep it private.`),
      h('div', { class: 'code' }, p.code),
      h('div', { class: 'row' }, h('button', { onclick: () => navigator.clipboard.writeText(p.code) }, 'Copy'), cancel),
    );
  } else if (p.state === 'waiting') {
    box.replaceChildren(h('p', { class: 'small' }, 'Contacting the other device…'), cancel);
  } else if (p.state === 'verify') {
    box.replaceChildren(
      h('p', { class: 'small' }, `Check that "${p.peerName}" shows the same number:`),
      h('div', { class: 'sas' }, p.sas),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: guard(async () => { await call('pairConfirm'); await refresh(); }) }, 'Numbers match: pair'),
        cancel),
    );
  } else if (p.state === 'failed') {
    box.replaceChildren(h('p', { class: 'error' }, `Pairing failed: ${p.error}`));
  } else {
    box.replaceChildren();
  }
}

// ---------- devices ----------
function renderDevices(s) {
  $('devices').replaceChildren(...s.devices.map((d) => {
    const remote = s.remoteTabs[d.deviceId];
    const li = h('li', { class: 'card' },
      h('div', { class: 'row' },
        h('span', { class: `dot ${d.status}`, title: d.status }),
        h('span', { class: 'grow ellipsis' }, d.name),
        h('span', { class: 'muted small' }, d.status),
        d.status === 'connected'
          ? h('button', { onclick: guard(() => call('requestTabs', { deviceId: d.deviceId })) }, 'Tabs')
          : h('button', { disabled: d.status === 'connecting', onclick: guard(() => call('connect', { deviceId: d.deviceId })) }, 'Connect'),
        h('button', {
          title: 'Unpair',
          onclick: guard(async () => { if (confirm(`Unpair "${d.name}"? Its keys will be deleted.`)) { await call('unpair', { deviceId: d.deviceId }); await refresh(); } }),
        }, '✕')));
    if (remote) {
      li.append(remote.disabled
        ? h('p', { class: 'small muted' }, 'This device does not share its tab list.')
        : h('ul', { class: 'list small' }, remote.tabs.map((t) => h('li', {},
          h('span', { class: 'grow ellipsis', title: t.url }, t.title),
          h('button', { class: 'link', onclick: guard(() => { if (safeHttpUrl(t.url)) return api.tabs.create({ url: t.url, active: false }); }) }, 'Open')))));
    }
    return li;
  }));

  const sel = $('target');
  const current = sel.value;
  sel.replaceChildren(...s.devices.map((d) => h('option', { value: d.deviceId, disabled: d.status !== 'connected' },
    `${d.name}${d.status === 'connected' ? '' : ` (${d.status})`}`)));
  const firstOk = s.devices.find((d) => d.status === 'connected');
  sel.value = s.devices.some((d) => d.deviceId === current && d.status === 'connected') ? current : (firstOk?.deviceId ?? '');
}

// ---------- incoming ----------
function renderIncoming(s) {
  const n = s.incoming.length;
  $('incomingCount').hidden = !n;
  $('incomingCount').textContent = String(n);
  $('incoming').replaceChildren(...s.incoming.map((t) => {
    const sensitive = t.tabs.some((x) => x.cookieCount || x.storageKeys);
    return h('li', { class: 'card' },
      h('div', {}, h('strong', {}, t.fromName), ` sent ${t.tabs.length} tab(s) · ${ago(t.at)}`),
      h('ul', { class: 'list small' }, t.tabs.map((x) => h('li', { class: 'card' },
        h('span', { class: 'ellipsis', title: x.url }, x.title),
        h('span', { class: 'muted ellipsis' }, new URL(x.url).host),
        x.cookieCount ? h('span', { class: 'warn' }, `${x.cookieCount} cookie(s) for ${x.cookieDomains.join(', ')}`) : null,
        x.storageKeys ? h('span', { class: 'warn' }, `${x.storageKeys} site storage item(s)`) : null))),
      sensitive ? h('p', { class: 'warn' }, 'Accepting signs this browser in to these sites. Only accept if you sent this yourself.') : null,
      h('div', { class: 'row' },
        h('button', {
          class: 'primary',
          onclick: (e) => {
            // Permission prompt must start synchronously in the gesture.
            const perm = sensitive ? requestSensitive() : Promise.resolve(true);
            guard(async () => {
              if (!(await perm)) throw new Error('Permission denied: cannot import cookies/site data.');
              e.target.disabled = true;
              const r = await call('acceptTransfer', { id: t.id });
              showError(r.cookiesFailed ? new Error(`${r.cookiesFailed} cookie(s) could not be set.`) : null);
              await refresh();
            })();
          },
        }, 'Accept'),
        h('button', { onclick: guard(async () => { await call('rejectTransfer', { id: t.id }); await refresh(); }) }, 'Reject')));
  }));
}

function renderOutgoing(s) {
  $('outgoing').replaceChildren(...s.outgoing.map((o) => h('li', {},
    h('span', { class: 'grow' }, `${o.count} tab(s) → ${o.toName}`), h('span', { class: 'muted' }, `${o.status} · ${ago(o.at)}`))));
}

// ---------- settings ----------
function loadSettings(s) {
  if (settingsLoaded) return;
  settingsLoaded = true;
  $('setName').value = s.device.name;
  $('setShare').checked = s.settings.shareTabList;
  $('setRelays').value = s.settings.relays.join('\n');
}

$('saveSettings').addEventListener('click', guard(async () => {
  await call('setSettings', {
    name: $('setName').value,
    shareTabList: $('setShare').checked,
    relays: $('setRelays').value.split('\n').map((x) => x.trim()).filter(Boolean),
  });
  settingsLoaded = false;
  $('settingsResult').textContent = 'Saved.';
  await refresh();
}));

// ---------- main loop ----------
async function refresh() {
  state = await call('getState');
  $('deviceName').textContent = '· ' + state.device.name;
  $('deviceId').textContent = state.device.id;
  $('relayStatus').textContent = state.relays.total ? `relays ${state.relays.connected}/${state.relays.total}` : 'relays idle';
  renderPairing(state.pairing);
  renderDevices(state);
  renderIncoming(state);
  renderOutgoing(state);
  loadSettings(state);
}

guard(async () => { await Promise.all([refresh(), loadTabs()]); })();
setInterval(() => refresh().catch(showError), 1000);
