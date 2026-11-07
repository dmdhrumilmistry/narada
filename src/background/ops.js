// Privileged browser operations (tabs, cookies, page storage, notifications).
// Runs in the Chromium service worker / Firefox background page.
import { actionApi, api } from '../shared/api.js';
import { safeHttpUrl, validateTab } from '../shared/validate.js';
import { updateMenus } from './quick.js';
import { isAndroid } from '../shared/platform.js';

const SENSITIVE_PERMS = { permissions: ['cookies'], origins: ['<all_urls>'] };

async function requireSensitivePerms() {
  if (!(await api.permissions.contains(SENSITIVE_PERMS))) {
    throw new Error('Cookie/site-data access has not been granted. Allow it in the Narada popup first.');
  }
}

// Injected into the page: must be self-contained.
function readPageStorage() {
  const dump = (s) => {
    const o = {};
    for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); }
    return o;
  };
  try { return { origin: location.origin, local: dump(localStorage), session: dump(sessionStorage) }; } catch { return null; }
}

// Injected into the page: re-checks the origin before writing anything.
function writePageStorage(origin, local, session) {
  if (location.origin !== origin) return false;
  try {
    for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(session)) sessionStorage.setItem(k, v);
    return true;
  } catch { return false; }
}

// Wait until the tab has finished loading *the expected origin*. A new tab can briefly
// report "complete" while still on about:blank (seen in Firefox), and injecting
// there would be refused by the origin check in writePageStorage.
function waitLoaded(tabId, origin, timeout = 20000) {
  const ready = (tab) => tab?.status === 'complete' && typeof tab.url === 'string' && tab.url.startsWith(origin);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); api.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, _info, tab) => { if (id === tabId && ready(tab)) done(); };
    const t = setTimeout(done, timeout);
    api.tabs.onUpdated.addListener(listener);
    api.tabs.get(tabId).then((tab) => ready(tab) && done()).catch(done);
  });
}

async function setCookie(c) {
  const host = c.domain.replace(/^\./, '');
  const details = {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path}`,
    name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
  };
  if (!c.hostOnly) details.domain = c.domain;
  if (c.sameSite !== 'unspecified') details.sameSite = c.sameSite;
  if (!c.session) details.expirationDate = c.expirationDate;
  return !!(await api.cookies.set(details).catch(() => null));
}

export const ops = {
  async listTabs() {
    const tabs = await api.tabs.query({});
    return tabs
      .filter((t) => !t.incognito && safeHttpUrl(t.url))
      .slice(0, 500)
      .map((t) => ({ url: t.url, title: t.title || t.url }));
  },

  async collectTabs({ tabIds, cookies = false, storage = false }) {
    if (!Array.isArray(tabIds) || !tabIds.length) throw new Error('No tabs selected');
    if (cookies || storage) await requireSensitivePerms();
    const out = [];
    const warnings = [];
    for (const tabId of tabIds.slice(0, 50)) {
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (!tab || tab.incognito || !safeHttpUrl(tab.url)) { warnings.push(`Skipped unsupported tab ${tab?.title ?? tabId}`); continue; }
      const entry = { url: tab.url, title: tab.title || tab.url, pinned: !!tab.pinned };
      if (cookies) {
        const list = await api.cookies.getAll({ url: tab.url });
        entry.cookies = list.map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path, hostOnly: c.hostOnly, secure: c.secure,
          httpOnly: c.httpOnly, sameSite: c.sameSite, session: c.session, expirationDate: c.expirationDate,
        }));
      }
      if (storage) {
        try {
          const [res] = await api.scripting.executeScript({ target: { tabId }, func: readPageStorage });
          if (res?.result) entry.storage = res.result;
        } catch {
          warnings.push(`Could not read site data for ${entry.title}`);
        }
      }
      let valid = validateTab(entry);
      if (!valid && entry.storage) {
        delete entry.storage;
        valid = validateTab(entry);
        warnings.push(`Site data for ${entry.title} is too large; sent without it`);
      }
      if (valid) out.push(valid);
      else warnings.push(`Skipped ${entry.title}`);
    }
    return { tabs: out, warnings };
  },

  async applyTransfer({ tabs }) {
    const needsPerms = tabs.some((t) => t.cookies?.length || t.storage);
    if (needsPerms) await requireSensitivePerms();
    const r = { opened: 0, cookiesSet: 0, cookiesFailed: 0, storageApplied: 0 };
    for (const t of tabs) {
      for (const c of t.cookies ?? []) (await setCookie(c)) ? r.cookiesSet++ : r.cookiesFailed++;
      // Pinned tabs don't exist on Firefox for Android.
      const tab = await api.tabs.create({ url: t.url, active: false, ...(t.pinned && !(await isAndroid()) ? { pinned: true } : {}) });
      r.opened++;
      if (t.storage && (Object.keys(t.storage.local).length || Object.keys(t.storage.session).length)) {
        await waitLoaded(tab.id, t.storage.origin);
        try {
          const [res] = await api.scripting.executeScript({
            target: { tabId: tab.id }, func: writePageStorage, args: [t.storage.origin, t.storage.local, t.storage.session],
          });
          if (res?.result) { r.storageApplied++; await api.tabs.reload(tab.id); }
        } catch { /* page navigated elsewhere or is restricted */ }
      }
    }
    return r;
  },

  async notify({ title, message }) {
    if (!api.notifications?.create) return; // not available on every platform
    await api.notifications.create({
      type: 'basic', iconUrl: api.runtime.getURL('icons/icon128.png'), title: String(title).slice(0, 100), message: String(message).slice(0, 200),
    });
  },

  async platform() {
    return (await isAndroid()) ? 'android' : 'desktop';
  },

  // Organization policy (Chrome/Edge enterprise policy, Firefox policies.json, MDM).
  async getManaged() {
    try { return (await api.storage?.managed?.get(null)) ?? {}; } catch { return {}; } // no policy set
  },

  async devices(info) {
    await updateMenus(info);
  },

  async badge({ text }) {
    const a = actionApi();
    if (!a?.setBadgeText) return; // no badge on Firefox for Android
    await a.setBadgeBackgroundColor?.({ color: '#d93025' });
    await a.setBadgeText({ text: String(text).slice(0, 4) });
  },
};

export async function callOps(method, args) {
  if (!Object.hasOwn(ops, method)) throw new Error('Unknown op');
  return ops[method](args);
}

// Popup command handler shared by both browsers. `engineCall` reaches the engine.
export async function handlePopupCommand(cmd, args, engineCall) {
  if (cmd === 'sendTabs') {
    // Fail fast before reading cookies/storage if policy forbids sending them.
    const { settings } = await engineCall('getState');
    if (args.cookies && !settings.allowCookieTransfer) throw new Error('Sending cookies is turned off for this device.');
    if (args.storage && !settings.allowStorageTransfer) throw new Error('Sending site storage is turned off for this device.');
    const { tabs, warnings } = await ops.collectTabs(args);
    if (!tabs.length) throw new Error(warnings.join('; ') || 'Nothing to send');
    const res = await engineCall('sendTransfer', { deviceId: args.deviceId, tabs });
    return { ...res, warnings };
  }
  return engineCall(cmd, args);
}

// Wrap async handlers for runtime.onMessage in a way that works in both browsers.
export function respond(promise, sendResponse) {
  promise.then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
}
