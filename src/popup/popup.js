// Popup UI. All untrusted strings are rendered with textContent only.
import { api } from '../shared/api.js';
import { safeHttpUrl } from '../shared/validate.js';

const SENSITIVE_PERMS = { permissions: ['cookies'], origins: ['<all_urls>'] };
const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

let state = null;
let view = 'send';
let target = null; // selected deviceId for sending
const selected = new Set(); // selected tab ids
let tabs = [];
let settingsLoaded = false;
const signatures = {};

// ---------- helpers ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k.startsWith('aria-') || k === 'role' || k === 'tabindex') el.setAttribute(k, v);
    else if (v !== undefined && v !== false) el[k] = v;
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

function changed(key, data) {
  const sig = JSON.stringify(data);
  if (signatures[key] === sig) return false;
  signatures[key] = sig;
  return true;
}

async function call(cmd, args = {}) {
  const res = await api.runtime.sendMessage({ target: 'bg', cmd, args });
  if (!res?.ok) throw new Error(res?.error || 'No response');
  return res.result;
}

let toastTimer;
function toast(message, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = error ? 'toast bubble error' : 'toast bubble';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6000 : 3500);
}

const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message || String(e), true); } };
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const host = (url) => { try { return new URL(url).host; } catch { return ''; } };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Comic sound-effect burst (small and quick).
const SFX_COLORS = { red: 'var(--vermilion)', blue: 'var(--peacock)', saffron: 'var(--saffron)', sky: 'var(--sky)' };
function boom(text, color = 'red') {
  const el = h('div', { class: 'boom' }, text);
  el.style.setProperty('--boom', SFX_COLORS[color]);
  $('sfx').replaceChildren(el);
  setTimeout(() => el.remove(), 800);
}

const QUIPS = [
  'Narayan Narayan! Your tabs travel across every loka.',
  'No middlemen. Just you, your devices and a little divine WebRTC.',
  'End-to-end encrypted. Not even Indra can read along.',
  'Cookies travel only when you say so. Narada never gossips… mostly.',
];
let quipIndex = 0;
setInterval(() => { quipIndex = (quipIndex + 1) % QUIPS.length; }, 8000);
function updateQuip(s) {
  let text;
  if (s.incoming.length) text = `Narayan Narayan! A sandesh has arrived from ${s.incoming[0].fromName}!`;
  else if (s.pairing?.state === 'verify') text = 'Check that the numbers match on both devices.';
  else if (!s.devices.length) text = 'Pair a second device to begin the yatra!';
  else text = QUIPS[quipIndex];
  if ($('quip').textContent !== text) $('quip').textContent = text;
}
const prevStatus = new Map();

// Must start synchronously inside the click handler (Firefox requires a user gesture).
const requestSensitive = () => api.permissions.request(SENSITIVE_PERMS);

// A device "string": taut when online, slack when offline.
function wire(status) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'wire');
  svg.setAttribute('viewBox', '0 0 100 14');
  svg.setAttribute('preserveAspectRatio', 'none');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  path.setAttribute('d', status === 'offline' ? 'M0 3 Q50 15 100 3' : 'M0 8 L100 8');
  svg.append(path);
  return svg;
}

function lockIcon() {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of [['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]]) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

const STATUS_TEXT = { connected: 'Online', connecting: 'Connecting…', offline: 'Offline' };

// ---------- navigation ----------
function show(next) {
  view = next;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === next));
  document.querySelectorAll('main section').forEach((s) => { s.hidden = s.id !== 'view-' + next; });
  $('actionBar').hidden = next !== 'send';
  document.body.dataset.view = next;
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

// ---------- send: targets ----------
function renderTargets(s) {
  const devices = s.devices.map((d) => ({ id: d.deviceId, name: d.name, status: d.status }));
  for (const d of devices) {
    if (prevStatus.has(d.id) && prevStatus.get(d.id) !== 'connected' && d.status === 'connected') boom('ZAP!', 'blue');
    prevStatus.set(d.id, d.status);
  }
  if (!changed('targets', [devices, target])) return;
  const list = $('targets');
  if (!devices.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'No devices yet.',
      h('button', { class: 'text-btn', type: 'button', onclick: () => show('devices') }, 'Add one →')));
    return;
  }
  list.replaceChildren(...devices.map((d) => {
    const online = d.status === 'connected';
    const pick = () => { if (online) { target = d.id; signatures.targets = null; refreshUi(); } };
    return h('li', {
      class: `string ${online ? 'online' : d.status}`, role: 'radio', tabindex: online ? '0' : '-1',
      'aria-checked': String(target === d.id), 'aria-disabled': String(!online), 'data-id': d.id,
      onclick: pick, onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(); } },
    },
    wire(d.status),
    h('span', { class: 'name' }, d.name),
    online
      ? h('span', { class: 'state ok' }, target === d.id ? 'Selected' : 'Online')
      : d.status === 'connecting'
        ? h('span', { class: 'state' }, 'Connecting…')
        : h('button', { class: 'btn small', type: 'button', onclick: guard(async (e) => { e.stopPropagation(); await call('connect', { deviceId: d.id }); await refresh(); }) }, 'Connect'));
  }));
}

function pluck(deviceId) {
  const el = document.querySelector(`#targets .string[data-id="${CSS.escape(deviceId)}"]`);
  if (!el) return;
  el.classList.remove('pluck');
  void el.offsetWidth; // restart animation
  el.classList.add('pluck');
}

// ---------- send: tabs ----------
async function loadTabs() {
  tabs = (await api.tabs.query({ currentWindow: true })).filter((t) => safeHttpUrl(t.url));
  if (!selected.size) tabs.filter((t) => t.active).forEach((t) => selected.add(t.id));
  for (const id of [...selected]) if (!tabs.some((t) => t.id === id)) selected.delete(id);
  const list = $('tabList');
  if (!tabs.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'No web pages open in this window.'));
  } else {
    list.replaceChildren(...tabs.map((t) => h('li', {},
      h('label', { class: 'leaf', title: t.url },
        h('input', {
          type: 'checkbox', checked: selected.has(t.id),
          onchange: (e) => { e.target.checked ? selected.add(t.id) : selected.delete(t.id); updateAction(); },
        }),
        h('span', { class: 'hole', 'aria-hidden': 'true' }),
        h('span', { class: 'leaf-text' },
          h('span', { class: 'leaf-title' }, t.title || t.url),
          h('span', { class: 'leaf-host' }, host(t.url)))))));
  }
  updateAction();
}

$('selectAll').addEventListener('click', () => {
  const all = tabs.length && tabs.every((t) => selected.has(t.id));
  tabs.forEach((t) => (all ? selected.delete(t.id) : selected.add(t.id)));
  $('tabList').querySelectorAll('input').forEach((c) => { c.checked = !all; });
  updateAction();
});

function carryOn() { return $('optCookies').checked || $('optStorage').checked; }

for (const id of ['optCookies', 'optStorage']) {
  $(id).addEventListener('change', (e) => {
    if (e.target.checked) {
      requestSensitive().then((granted) => {
        if (!granted) { e.target.checked = false; toast('Permission is needed to read cookies and site data.', true); }
        updateAction();
      });
    }
    updateAction();
  });
}

$('sendNote').addEventListener('click', guard(async () => {
  const dev = state?.devices.find((d) => d.deviceId === target);
  if (!dev) throw new Error('Choose an online device first.');
  const text = $('noteText').value;
  if (!text.trim()) throw new Error('Write a note first.');
  $('sendNote').disabled = true;
  try {
    await call('sendNote', { deviceId: dev.deviceId, text });
    $('noteText').value = '';
    boom('WHOOSH!', 'blue');
    toast(`Note sent to ${dev.name}.`);
  } finally {
    $('sendNote').disabled = false;
  }
}));

function updateAction() {
  const btn = $('sendBtn');
  const n = selected.size;
  const dev = state?.devices.find((d) => d.deviceId === target);
  const noteDev = state?.devices.find((d) => d.deviceId === target);
  $('sendNote').textContent = noteDev ? `Send note to ${noteDev.name}` : 'Send note';
  $('sendNote').disabled = !noteDev;
  $('selectAll').textContent = tabs.length && tabs.every((t) => selected.has(t.id)) ? 'Clear' : 'Select all';
  $('sensitiveWarn').hidden = !carryOn();
  $('carryState').textContent = carryOn() ? 'On' : 'Off';
  $('carryState').classList.toggle('on', carryOn());
  btn.classList.add('primary');
  if (!state?.devices.length) { btn.textContent = 'Add a device to start'; btn.disabled = false; btn.dataset.mode = 'pair'; return; }
  btn.dataset.mode = 'send';
  if (!dev) { btn.textContent = 'Choose an online device'; btn.disabled = true; return; }
  if (!n) { btn.textContent = 'Choose tabs to send'; btn.disabled = true; return; }
  btn.disabled = false;
  btn.textContent = `Send ${plural(n, 'tab')}${carryOn() ? ' + sign-in' : ''} to ${dev.name}`;
}

$('sendBtn').addEventListener('click', guard(async () => {
  if ($('sendBtn').dataset.mode === 'pair') return show('devices');
  const cookies = $('optCookies').checked;
  const storage = $('optStorage').checked;
  const deviceId = target;
  const name = state.devices.find((d) => d.deviceId === deviceId)?.name;
  $('sendBtn').disabled = true;
  try {
    const r = await call('sendTabs', { deviceId, tabIds: [...selected], cookies, storage });
    pluck(deviceId);
    boom('WHOOSH!', 'blue');
    toast(`Sent ${plural(r.count, 'tab')} to ${name}. Waiting for them to accept.${r.warnings?.length ? ' ' + r.warnings.join('; ') : ''}`);
  } finally {
    updateAction();
  }
}));

// ---------- devices ----------
function renderDevices(s) {
  if ($('devices').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  if (!changed('devices', [s.devices, s.remoteTabs])) return;
  const list = $('devices');
  if (!s.devices.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'No devices yet. Add one below.'));
    return;
  }
  list.replaceChildren(...s.devices.map((d) => {
    const online = d.status === 'connected';
    const remote = s.remoteTabs[d.deviceId];
    const li = h('li', { class: `string ${online ? 'online' : d.status}` },
      wire(d.status),
      h('span', { class: 'name' }, d.name),
      h('span', { class: 'actions' },
        online
          ? h('button', { class: 'btn small', type: 'button', onclick: guard(async () => { await call('requestTabs', { deviceId: d.deviceId }); setTimeout(refresh, 600); }) }, 'Show tabs')
          : h('button', { class: 'btn small', type: 'button', disabled: d.status === 'connecting', onclick: guard(async () => { await call('connect', { deviceId: d.deviceId }); await refresh(); }) }, d.status === 'connecting' ? 'Connecting…' : 'Connect'),
        h('button', {
          class: 'btn small ghost', type: 'button', title: `Remove ${d.name}`, 'aria-label': `Remove ${d.name}`,
          onclick: guard(async () => {
            if (!confirm(`Remove "${d.name}"? Its keys are deleted, and you'll need to pair again.`)) return;
            await call('unpair', { deviceId: d.deviceId });
            if (target === d.deviceId) target = null;
            await refresh();
          }),
        }, 'Remove')),
      h('span', { class: `state ${online ? 'ok' : ''}` }, STATUS_TEXT[d.status] ?? d.status),
      d.issue && !online ? h('span', { class: 'issue' }, `Last try: ${d.issue}. Make sure Narada is open on that device. Very strict networks can block direct connections.`) : null,
      deviceOptions(d));
    if (remote) {
      li.append(remote.disabled
        ? h('span', { class: 'issue' }, 'This device keeps its tab list private.')
        : h('ul', { class: 'remote' }, remote.tabs.length ? remote.tabs.map((t) => h('li', {},
          h('span', { class: 'leaf-text', style: 'flex:1' }, h('span', { class: 'leaf-title' }, t.title), h('span', { class: 'leaf-host' }, host(t.url))),
          h('button', { class: 'btn small', type: 'button', onclick: guard(() => { if (safeHttpUrl(t.url)) return api.tabs.create({ url: t.url, active: false }); }) }, 'Open'))) : h('li', {}, 'No open web pages.')));
    }
    return li;
  }));
}

// Per-device options: local name and auto-open for plain tabs.
function deviceOptions(d) {
  const name = h('input', { value: d.name, maxLength: 64, 'aria-label': `Name for ${d.name}` });
  return h('details', { class: 'dev-opts' },
    h('summary', {}, 'Options'),
    h('form', {
      class: 'row', onsubmit: guard(async (e) => {
        e.preventDefault();
        await call('setDeviceOptions', { deviceId: d.deviceId, name: name.value });
        name.blur();
        toast('Device renamed.');
        await refresh();
      }),
    }, name, h('button', { class: 'btn small', type: 'submit' }, 'Rename')),
    h('label', { class: 'switch' },
      h('input', {
        type: 'checkbox', checked: d.autoOpen,
        onchange: guard(async (e) => {
          await call('setDeviceOptions', { deviceId: d.deviceId, autoOpen: e.target.checked });
          toast(e.target.checked ? `Tabs from ${d.name} will open automatically.` : `Tabs from ${d.name} will wait for your OK.`);
          await refresh();
        }),
      }),
      h('span'),
      ' Open its tabs automatically'),
    h('small', { class: 'muted' }, 'Sign-in data (cookies, site storage) always waits for your approval.'));
}

// ---------- pairing ----------
$('pairStart').addEventListener('click', guard(async () => { await call('pairStart'); await refresh(); }));
$('pairJoinForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const code = $('pairCode').value.trim();
  if (!code) throw new Error('Paste the code shown on your other device.');
  await call('pairJoin', { code });
  $('pairCode').value = '';
  await refresh();
}));

function renderPairing(p) {
  const minutesLeft = p?.expiresAt ? Math.ceil((p.expiresAt - Date.now()) / 60000) : 0;
  if (!changed('pairing', [p, minutesLeft])) return;
  const box = $('pairing');
  $('pairControls').hidden = !!p && p.state !== 'done';
  if (!p || p.state === 'done') return box.replaceChildren();
  const cancel = h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await call('pairCancel'); await refresh(); }) }, 'Cancel');
  let content;
  if (p.state === 'waiting' && p.role === 'initiator') {
    const pct = Math.max(0, Math.min(100, ((p.expiresAt - Date.now()) / 600000) * 100));
    content = [
      h('p', {}, h('strong', {}, 'Step 1 of 2: '), 'On your other device, open Narada → Devices → ', h('em', {}, 'Enter a code'), ', and paste:'),
      h('div', { class: 'code' }, p.code),
      h('div', { class: 'meter', title: `Expires in about ${minutesLeft} min` }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await navigator.clipboard.writeText(p.code); toast('Code copied. Keep it private.'); }) }, 'Copy code'),
        cancel),
    ];
  } else if (p.state === 'waiting') {
    content = [h('p', {}, 'Reaching the other device… Keep Narada open there with the code showing.'), cancel];
  } else if (p.state === 'verify') {
    const digits = p.sas.replace(/\D/g, '').split('');
    content = [
      h('p', {}, h('strong', {}, 'Step 2 of 2: '), `Does "${p.peerName}" show exactly these numbers?`),
      h('div', { class: 'sas', 'aria-label': p.sas }, digits.slice(0, 3).map((d) => h('b', {}, d)), h('i'), digits.slice(3).map((d) => h('b', {}, d))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await call('pairConfirm'); boom('BANDHAN!', 'saffron'); toast(`Paired with ${p.peerName}.`); await refresh(); }) }, 'Yes, they match'),
        h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await call('pairCancel'); toast('Pairing cancelled. Nothing was saved.'); await refresh(); }) }, 'No')),
    ];
  } else {
    content = [
      h('p', {}, `Pairing didn't work: ${p.error}.`),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await call('pairCancel'); await refresh(); }) }, 'Start over')),
    ];
  }
  box.replaceChildren(h('div', { class: 'pair-box' }, content));
}

// ---------- inbox ----------
function renderIncoming(s) {
  const n = s.incoming.length;
  $('incomingCount').hidden = !n;
  $('incomingCount').textContent = String(n);
  if (!changed('incoming', [s.incoming.map((t) => [t.id, t.tabs, t.text]), Math.floor(Date.now() / 60000)])) return;
  if (!n) {
    $('incoming').replaceChildren(h('li', { class: 'empty' }, 'Nothing waiting. Tabs and notes your devices send show up here.'));
    return;
  }
  $('incoming').replaceChildren(...s.incoming.map((t) => {
    if (t.kind === 'note') return noteCard(t);
    const domains = [...new Set(t.tabs.flatMap((x) => x.cookieDomains))];
    const storageSites = t.tabs.filter((x) => x.storageKeys).map((x) => host(x.url));
    const sensitive = domains.length || storageSites.length;
    return h('li', { class: 'card' },
      h('div', { class: 'card-head' }, h('strong', {}, `${plural(t.tabs.length, 'tab')} from ${t.fromName}`), h('span', {}, ago(t.at))),
      h('ul', { class: 'leaves' }, t.tabs.map((x) => h('li', {}, h('div', { class: 'leaf' },
        h('span', { class: 'hole', 'aria-hidden': 'true' }),
        h('span', { class: 'leaf-text' }, h('span', { class: 'leaf-title' }, x.title), h('span', { class: 'leaf-host' }, host(x.url))))))),
      sensitive ? h('div', { class: 'signin' },
        lockIcon(),
        h('span', {},
          'Accepting signs this browser in to ',
          h('strong', {}, [...new Set([...domains, ...storageSites])].join(', ')),
          '. Only accept if you sent this yourself.')) : null,
      h('div', { class: 'row' },
        h('button', {
          class: 'btn primary', type: 'button',
          onclick: (e) => {
            const perm = sensitive ? requestSensitive() : Promise.resolve(true); // in-gesture
            guard(async () => {
              if (!(await perm)) throw new Error('Permission denied, so cookies and site data could not be imported.');
              e.target.disabled = true;
              const r = await call('acceptTransfer', { id: t.id });
              boom('SHABASH!', 'saffron');
              toast(`Opened ${plural(r.opened, 'tab')}${r.cookiesSet ? `, signed in with ${plural(r.cookiesSet, 'cookie')}` : ''}.` +
                (r.cookiesFailed ? ` ${r.cookiesFailed} couldn't be set.` : ''), !!r.cookiesFailed);
              await refresh();
            })();
          },
        }, sensitive ? 'Accept & sign in' : 'Open tabs'),
        h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await call('rejectTransfer', { id: t.id }); await refresh(); }) }, 'Decline')));
  }));
}

// A received note: shown as plain text (textContent), copied only on click.
function noteCard(t) {
  const link = safeHttpUrl(t.text.trim());
  const dismiss = guard(async () => { await call('dismissNote', { id: t.id }); await refresh(); });
  return h('li', { class: 'card' },
    h('div', { class: 'card-head' }, h('strong', {}, `📝 Note from ${t.fromName}`), h('span', {}, ago(t.at))),
    h('pre', { class: 'note-text' }, t.text),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary', type: 'button',
        onclick: guard(async () => {
          await navigator.clipboard.writeText(t.text);
          boom('COPIED!', 'sky');
          toast('Copied to your clipboard.');
          await call('dismissNote', { id: t.id });
          await refresh();
        }),
      }, 'Copy'),
      link ? h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await api.tabs.create({ url: link.href }); await call('dismissNote', { id: t.id }); }) }, 'Open link') : null,
      h('button', { class: 'btn', type: 'button', onclick: dismiss }, 'Dismiss')),
    h('small', { class: 'muted' }, 'Notes are never saved to disk and vanish after 15 minutes.'));
}

function renderHistory(s) {
  if (!changed('history', [s.history, s.settings.keepHistory, Math.floor(Date.now() / 60000)])) return;
  $('historyBlock').hidden = !s.settings.keepHistory;
  const rows = s.history.flatMap((e) => e.tabs.map((t) => ({ ...t, at: e.at, fromName: e.fromName })));
  $('history').replaceChildren(...(rows.length ? rows.slice(0, 50).map((t) => h('li', {},
    h('span', { class: 'leaf-text grow' }, h('span', { class: 'leaf-title' }, t.title), h('span', { class: 'leaf-host' }, `${host(t.url)} · from ${t.fromName} · ${ago(t.at)}`)),
    h('button', { class: 'btn small', type: 'button', onclick: guard(() => { if (safeHttpUrl(t.url)) return api.tabs.create({ url: t.url, active: false }); }) }, 'Open')))
    : [h('li', { class: 'empty' }, 'Tabs you receive will be listed here.')]));
}

$('clearHistory').addEventListener('click', guard(async () => {
  await call('clearHistory');
  toast('History cleared.');
  await refresh();
}));

function renderOutgoing(s) {
  if (!changed('outgoing', [s.outgoing, Math.floor(Date.now() / 60000)])) return;
  const label = { sent: 'waiting', accepted: 'opened', rejected: 'declined', expired: 'expired', invalid: 'rejected', delivered: 'delivered', read: 'read' };
  $('outgoing').replaceChildren(...(s.outgoing.length ? s.outgoing.map((o) => h('li', {},
    h('span', {}, o.kind === 'note' ? `📝 note → ${o.toName}` : `${plural(o.count, 'tab')} → ${o.toName}`),
    h('span', { class: o.status }, `${label[o.status] ?? o.status} · ${ago(o.at)}`))) : [h('li', { class: 'empty' }, 'Nothing sent yet.')]));
}

// ---------- settings ----------
function loadSettings(s) {
  if (settingsLoaded) return;
  settingsLoaded = true;
  $('setName').value = s.device.name;
  $('setShare').checked = s.settings.shareTabList;
  $('setHistory').checked = s.settings.keepHistory;
  $('setRelays').value = s.settings.relays.join('\n');
}

$('settingsForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  await call('setSettings', {
    name: $('setName').value,
    shareTabList: $('setShare').checked,
    keepHistory: $('setHistory').checked,
    relays: $('setRelays').value.split('\n').map((x) => x.trim()).filter(Boolean),
  });
  settingsLoaded = false;
  toast('Settings saved.');
  await refresh();
}));

// ---------- main loop ----------
function refreshUi() {
  const s = state;
  const online = s.devices.filter((d) => d.status === 'connected');
  if (!online.some((d) => d.deviceId === target)) {
    target = online.find((d) => d.deviceId === s.settings.lastTarget)?.deviceId ?? online[0]?.deviceId ?? null;
  }
  $('deviceName').textContent = `This device: ${s.device.name}`;
  $('deviceId').textContent = s.device.id;
  $('webrtcWarn').hidden = s.webrtc !== false;
  updateQuip(s);
  const net = $('netStatus');
  if (online.length) { net.textContent = `${online.length} linked · direct`; net.className = 'chip p2p'; net.title = 'Connected peer-to-peer. No server in between.'; }
  else if (s.relays.total) { net.textContent = `Signaling ${s.relays.connected}/${s.relays.total}`; net.className = 'chip live'; net.title = 'Looking for your devices via public relays (encrypted).'; }
  else { net.textContent = 'Resting'; net.className = 'chip'; net.title = ''; }
  renderTargets(s);
  renderDevices(s);
  renderPairing(s.pairing);
  renderIncoming(s);
  renderOutgoing(s);
  renderHistory(s);
  loadSettings(s);
  updateAction();
}

async function refresh() {
  state = await call('getState');
  refreshUi();
}

guard(async () => {
  await refresh();
  await loadTabs();
  if (state.incoming.length) show('incoming');
  else if (!state.devices.length) show('devices');
})();
setInterval(() => refresh().catch(() => {}), 1000);
