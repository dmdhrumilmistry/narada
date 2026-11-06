// Strict validation for everything that arrives from a peer, relay, or UI.
import { LIMITS } from './constants.js';

const isStr = (v, max) => typeof v === 'string' && v.length <= max;

export function safeHttpUrl(value) {
  if (!isStr(value, LIMITS.urlLength)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u;
}

export function safeRelayUrl(value) {
  if (!isStr(value, 512)) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'wss:' && !u.username && !u.password ? u.href.replace(/\/$/, '') : null;
  } catch { return null; }
}

export function cleanName(value) {
  if (typeof value !== 'string') return 'Unnamed device';
  // Strip control chars; UI only ever renders via textContent.
  const s = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.deviceName);
  return s || 'Unnamed device';
}

export function domainMatches(host, cookieDomain) {
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  return d.length > 0 && (h === d || h.endsWith('.' + d));
}

const SAME_SITE = new Set(['no_restriction', 'lax', 'strict', 'unspecified']);

export function validateCookie(c, host) {
  if (!c || typeof c !== 'object') return null;
  if (!isStr(c.name, 4096) || !isStr(c.value, LIMITS.cookieValueLength)) return null;
  if (!isStr(c.domain, 255) || !domainMatches(host, c.domain)) return null;
  if (!isStr(c.path ?? '/', 1024)) return null;
  const path = (c.path || '/').startsWith('/') ? (c.path || '/') : '/';
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path,
    hostOnly: !!c.hostOnly,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: SAME_SITE.has(c.sameSite) ? c.sameSite : 'unspecified',
    session: !!c.session,
  };
  if (!out.session) {
    if (typeof c.expirationDate !== 'number' || !Number.isFinite(c.expirationDate)) return null;
    if (c.expirationDate * 1000 < Date.now()) return null; // expired
    out.expirationDate = c.expirationDate;
  }
  // Cookie prefix rules (RFC 6265bis).
  if (out.name.startsWith('__Secure-') && !out.secure) return null;
  if (out.name.startsWith('__Host-') && (!out.secure || !out.hostOnly || out.path !== '/')) return null;
  return out;
}

function validateStorageArea(area) {
  if (area == null) return {};
  if (typeof area !== 'object' || Array.isArray(area)) return null;
  const keys = Object.keys(area);
  if (keys.length > LIMITS.storageItemsPerArea) return null;
  const out = {};
  for (const k of keys) {
    if (!isStr(k, 4096) || !isStr(area[k], LIMITS.storageValueLength)) return null;
    out[k] = area[k];
  }
  return out;
}

export function validateTab(t) {
  if (!t || typeof t !== 'object') return null;
  const u = safeHttpUrl(t.url);
  if (!u) return null;
  const tab = {
    url: u.href,
    title: isStr(t.title, LIMITS.titleLength) ? t.title : u.href.slice(0, LIMITS.titleLength),
    pinned: !!t.pinned,
  };
  if (t.cookies != null) {
    if (!Array.isArray(t.cookies) || t.cookies.length > LIMITS.cookiesPerTab) return null;
    tab.cookies = t.cookies.map((c) => validateCookie(c, u.hostname)).filter(Boolean);
  }
  if (t.storage != null) {
    const s = t.storage;
    if (typeof s !== 'object' || s.origin !== u.origin) return null;
    const local = validateStorageArea(s.local);
    const session = validateStorageArea(s.session);
    if (!local || !session) return null;
    tab.storage = { origin: u.origin, local, session };
  }
  return tab;
}

export function validateTransfer(msg) {
  if (!msg || !isStr(msg.id, 64) || !Array.isArray(msg.tabs)) return null;
  if (msg.tabs.length === 0 || msg.tabs.length > LIMITS.tabsPerTransfer) return null;
  const tabs = msg.tabs.map(validateTab);
  if (tabs.some((t) => !t)) return null;
  return { id: msg.id, tabs };
}

export function validateTabList(list) {
  if (!Array.isArray(list) || list.length > 500) return null;
  return list
    .map((t) => {
      const u = safeHttpUrl(t?.url);
      if (!u) return null;
      return { url: u.href, title: isStr(t.title, LIMITS.titleLength) ? t.title : u.href };
    })
    .filter(Boolean);
}

// Text notes: plain strings only, control characters removed except newline and tab.
export function cleanNoteText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n');
  if (!text.trim() || text.length > LIMITS.noteLength) return null;
  return text;
}

export function validateNote(msg) {
  if (!msg || !isStr(msg.id, 64)) return null;
  const text = cleanNoteText(msg.text);
  return text ? { id: msg.id, text } : null;
}
