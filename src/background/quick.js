// Right-click "Send to device" menu and keyboard shortcut. Shared by both browsers.
// These quick sends carry plain tabs only; sign-in data always goes through the popup.
import { api, IS_FIREFOX } from '../shared/api.js';
import { safeHttpUrl } from '../shared/validate.js';

const menus = () => api.menus ?? api.contextMenus;
const ROOT = 'narada-send';
let lastSignature = '';
let rebuilding = Promise.resolve();

function notify(title, message) {
  return api.notifications.create({
    type: 'basic', iconUrl: api.runtime.getURL('icons/icon128.png'), title: String(title).slice(0, 100), message: String(message).slice(0, 200),
  }).catch(() => {});
}

// Called whenever the engine reports a change in the paired-device list.
export function updateMenus({ devices = [] } = {}) {
  const items = devices.map((d) => [d.deviceId, d.name, d.status]);
  const sig = JSON.stringify(items);
  if (sig === lastSignature) return rebuilding;
  lastSignature = sig;
  rebuilding = rebuilding.then(async () => {
    const m = menus();
    if (!m) return;
    await m.removeAll();
    const contexts = ['page', 'link', ...(IS_FIREFOX ? ['tab'] : [])];
    m.create({ id: ROOT, title: 'Send to device with Narada', contexts });
    if (!devices.length) {
      m.create({ id: 'narada-none', parentId: ROOT, title: 'No paired devices yet: open Narada to pair', enabled: false, contexts });
      return;
    }
    for (const d of devices) {
      const suffix = d.status === 'connected' ? '' : d.status === 'connecting' ? ' (connecting…)' : ' (offline, will try)';
      m.create({ id: `send:${d.deviceId}`, parentId: ROOT, title: `${d.name}${suffix}`, contexts });
    }
  }).catch(() => {});
  return rebuilding;
}

async function quickSend(engineCall, deviceId, url, title) {
  const u = safeHttpUrl(url);
  if (!u) return notify('Narada can only send web pages', 'Only http(s) pages and links can be sent.');
  try {
    const r = await engineCall('quickSend', { deviceId, tabs: [{ url: u.href, title: title || u.href }] });
    await notify(`Sent to ${r.name}`, title || u.href);
  } catch (e) {
    await notify('Narada could not send', e.message || String(e));
  }
}

export function setupQuickSend(engineCall) {
  menus()?.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId);
    if (!id.startsWith('send:')) return;
    if (tab?.incognito) return notify('Narada', 'Private windows are never synced.');
    const deviceId = id.slice('send:'.length);
    if (info.linkUrl) return quickSend(engineCall, deviceId, info.linkUrl, info.linkText || info.selectionText || info.linkUrl);
    return quickSend(engineCall, deviceId, tab?.url ?? info.pageUrl, tab?.title);
  });

  api.commands?.onCommand.addListener(async (command) => {
    if (command !== 'send-current-tab') return;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.incognito) return;
    await quickSend(engineCall, undefined, tab.url, tab.title);
  });

  // Build the menu from the current device list once the engine is up.
  engineCall('getState').then((s) => updateMenus(s)).catch(() => {});
}
