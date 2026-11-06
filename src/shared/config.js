// Single source of truth for every configurable setting.
//  - Users change these in the popup (Yantra).
//  - Organizations can set any of them centrally (Chrome/Edge policy, Firefox
//    policies.json, MDM). A managed value always wins and locks the control.
//  - build.mjs generates managed_schema.json for Chromium from SCHEMA.
import { DEFAULT_RELAYS, LIMITS } from './constants.js';
import { safeRelayUrl } from './validate.js';

export const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
];

export const LOG_LEVELS = ['off', 'error', 'warn', 'info', 'debug'];

export const DEFAULTS = Object.freeze({
  relays: DEFAULT_RELAYS,
  stunServers: DEFAULT_STUN,
  allowPairing: true,
  allowCookieTransfer: true,
  allowStorageTransfer: true,
  allowNotes: true,
  allowAutoOpen: true,
  shareTabList: true,
  keepHistory: true,
  telemetry: Object.freeze({
    enabled: false,
    endpoint: '',
    headers: Object.freeze({}),
    logLevel: 'info',
    resourceAttributes: Object.freeze({}),
  }),
});

// JSON Schema (Chrome managed-storage dialect). Descriptions show up in admin consoles.
export const SCHEMA = {
  type: 'object',
  properties: {
    relays: { type: 'array', items: { type: 'string' }, title: 'Signaling relays', description: 'Nostr relay URLs (wss:// only) used for the encrypted handshake.' },
    stunServers: { type: 'array', items: { type: 'string' }, title: 'STUN servers', description: 'stun: or stuns: URLs used for NAT traversal. TURN is not supported by design.' },
    allowPairing: { type: 'boolean', title: 'Allow pairing new devices' },
    allowCookieTransfer: { type: 'boolean', title: 'Allow sending/receiving cookies' },
    allowStorageTransfer: { type: 'boolean', title: 'Allow sending/receiving site storage' },
    allowNotes: { type: 'boolean', title: 'Allow text notes' },
    allowAutoOpen: { type: 'boolean', title: 'Allow trusted devices to auto-open tabs' },
    shareTabList: { type: 'boolean', title: 'Let paired devices list open tabs' },
    keepHistory: { type: 'boolean', title: 'Keep received-tab history' },
    telemetry: {
      type: 'object',
      title: 'OpenTelemetry log export',
      properties: {
        enabled: { type: 'boolean', title: 'Export logs' },
        endpoint: { type: 'string', title: 'OTLP/HTTP endpoint', description: 'Collector base URL (https://…, or http://localhost for testing). /v1/logs is appended.' },
        headers: { type: 'object', title: 'Extra request headers', description: 'For example an Authorization header.', additionalProperties: { type: 'string' } },
        logLevel: { type: 'string', enum: LOG_LEVELS, title: 'Minimum level' },
        resourceAttributes: { type: 'object', title: 'Resource attributes', description: 'Added to every log, e.g. {"deployment.environment": "prod"}.', additionalProperties: { type: 'string' } },
      },
    },
  },
};

const BOOL_KEYS = ['allowPairing', 'allowCookieTransfer', 'allowStorageTransfer', 'allowNotes', 'allowAutoOpen', 'shareTabList', 'keepHistory'];
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'cookie', 'origin', 'referer']);

export function safeStunUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const v = value.trim();
  return /^stuns?:[A-Za-z0-9.-]+(:\d{1,5})?$/.test(v) ? v : null;
}

export function safeOtlpEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let u;
  try { u = new URL(value.trim()); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  const base = u.href.replace(/\/+$/, '');
  return base.endsWith('/v1/logs') ? base : `${base}/v1/logs`;
}

function stringMap(obj, keyOk, max = 20) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, max)) {
    if (typeof v !== 'string' || v.length > 1024 || !keyOk(k)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Validate a partial config (from the user or from policy). Invalid keys are
 * dropped (reported in `errors`), never partially applied.
 */
export function sanitize(raw) {
  const out = {};
  const errors = [];
  if (!raw || typeof raw !== 'object') return { values: out, errors };
  for (const k of BOOL_KEYS) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
    else errors.push(k);
  }
  if (raw.relays !== undefined) {
    const list = Array.isArray(raw.relays) ? [...new Set(raw.relays.map(safeRelayUrl).filter(Boolean))].slice(0, LIMITS.relays) : [];
    if (list.length) out.relays = list; else errors.push('relays');
  }
  if (raw.stunServers !== undefined) {
    const list = Array.isArray(raw.stunServers) ? [...new Set(raw.stunServers.map(safeStunUrl).filter(Boolean))].slice(0, 10) : [];
    if (list.length) out.stunServers = list; else errors.push('stunServers');
  }
  if (raw.telemetry !== undefined) {
    const t = raw.telemetry;
    if (!t || typeof t !== 'object') errors.push('telemetry');
    else {
      const tel = {};
      if (t.enabled !== undefined) { if (typeof t.enabled === 'boolean') tel.enabled = t.enabled; else errors.push('telemetry.enabled'); }
      if (t.endpoint !== undefined) { const e = safeOtlpEndpoint(t.endpoint); if (e === null) errors.push('telemetry.endpoint'); else tel.endpoint = e; }
      if (t.logLevel !== undefined) { if (LOG_LEVELS.includes(t.logLevel)) tel.logLevel = t.logLevel; else errors.push('telemetry.logLevel'); }
      if (t.headers !== undefined) {
        const h = stringMap(t.headers, (k) => HEADER_NAME.test(k) && !FORBIDDEN_HEADERS.has(k.toLowerCase()));
        if (h) tel.headers = h; else errors.push('telemetry.headers');
      }
      if (t.resourceAttributes !== undefined) {
        const r = stringMap(t.resourceAttributes, (k) => /^[A-Za-z0-9._-]{1,128}$/.test(k));
        if (r) tel.resourceAttributes = r; else errors.push('telemetry.resourceAttributes');
      }
      out.telemetry = tel;
    }
  }
  return { values: out, errors };
}

/**
 * Effective config = defaults ← user ← managed. Returns the merged values and the
 * set of locked (policy-controlled) keys. Telemetry is merged field by field
 * (lock names look like "telemetry.endpoint").
 */
export function effective(user = {}, managed = {}) {
  const u = sanitize(user).values;
  const m = sanitize(managed).values;
  const values = { ...DEFAULTS, ...u, ...m };
  values.telemetry = { ...DEFAULTS.telemetry, ...(u.telemetry ?? {}), ...(m.telemetry ?? {}) };
  const locked = new Set(Object.keys(m).filter((k) => k !== 'telemetry'));
  for (const k of Object.keys(m.telemetry ?? {})) locked.add(`telemetry.${k}`);
  // Telemetry with no usable endpoint is effectively off.
  if (!values.telemetry.endpoint) values.telemetry.enabled = false;
  return { values, locked };
}

export const iceServersFrom = (stunServers) => [{ urls: stunServers }];
