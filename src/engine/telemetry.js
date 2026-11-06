// OpenTelemetry log export (OTLP/HTTP JSON) plus leveled console logging.
// Privacy: only allow-listed attributes with primitive values are ever exported:
// counts, booleans, statuses and short ids. Never URLs, titles, cookies, storage or note text.
import { LOG_LEVELS } from '../shared/config.js';

const SEVERITY = { debug: 5, info: 9, warn: 13, error: 17 };

// event attribute allow-list; anything else is dropped before export
const ALLOWED_ATTRS = new Set([
  'peer.id', 'peer.role', 'peer.status', 'reason', 'status', 'kind',
  'tabs', 'with_cookies', 'with_storage', 'sensitive', 'auto_opened',
  'pairs', 'webrtc', 'duration_ms', 'policy', 'setting', 'error.type', 'error.message', 'relays.connected', 'relays.total',
]);

const scrub = (s) => String(s)
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]') // drop anything URL-shaped
  .slice(0, 160);

function attr(key, value) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: scrub(value) } };
}

export function cleanAttributes(attrs = {}) {
  return Object.entries(attrs)
    .filter(([k, v]) => ALLOWED_ATTRS.has(k) && v !== undefined && v !== null && ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => attr(k, v));
}

/** Build an OTLP/HTTP JSON ExportLogsServiceRequest. */
export function buildOtlpPayload(records, resource, scopeVersion) {
  return {
    resourceLogs: [{
      resource: { attributes: Object.entries(resource).map(([k, v]) => attr(k, v)) },
      scopeLogs: [{
        scope: { name: 'narada', version: scopeVersion },
        logRecords: records.map((r) => ({
          timeUnixNano: String(BigInt(r.time) * 1_000_000n),
          observedTimeUnixNano: String(BigInt(r.time) * 1_000_000n),
          severityNumber: SEVERITY[r.level],
          severityText: r.level.toUpperCase(),
          body: { stringValue: r.event },
          attributes: [attr('event.name', r.event), ...cleanAttributes(r.attrs)],
        })),
      }],
    }],
  };
}

export class Telemetry {
  constructor({ version = '0.0.0', browser = 'unknown', fetchImpl = globalThis.fetch?.bind(globalThis), flushMs = 5000 } = {}) {
    Object.assign(this, { version, browser, fetchImpl, flushMs });
    this.queue = [];
    this.timer = null;
    this.failures = 0;
    this.configure({ enabled: false, logLevel: 'info' });
  }

  configure(cfg, { deviceId } = {}) {
    this.cfg = cfg;
    if (deviceId) this.deviceId = deviceId;
    this.resource = {
      'service.name': 'narada-extension',
      'service.version': this.version,
      'browser.name': this.browser,
      ...(this.deviceId ? { 'service.instance.id': this.deviceId.slice(0, 12) } : {}),
      ...(cfg.resourceAttributes ?? {}),
    };
    if (!cfg.enabled) this.queue = [];
  }

  #levelOn(level) {
    const min = LOG_LEVELS.indexOf(this.cfg.logLevel ?? 'info');
    return min > 0 && LOG_LEVELS.indexOf(level) <= min;
  }

  log(level, event, attrs = {}) {
    if (!this.#levelOn(level)) return;
    const line = `[narada] ${event}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line, attrs);
    if (!this.cfg.enabled || !this.cfg.endpoint) return;
    this.queue.push({ time: Date.now(), level, event, attrs });
    if (this.queue.length > 500) this.queue.splice(0, this.queue.length - 500); // bounded memory
    if (this.queue.length >= 50) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  debug(e, a) { this.log('debug', e, a); }
  info(e, a) { this.log('info', e, a); }
  warn(e, a) { this.log('warn', e, a); }
  error(e, a) { this.log('error', e, a); }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.queue.length || !this.cfg.enabled || !this.cfg.endpoint || !this.fetchImpl) return false;
    const batch = this.queue.splice(0, 100);
    try {
      const res = await this.fetchImpl(this.cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.cfg.headers ?? {}) },
        body: JSON.stringify(buildOtlpPayload(batch, this.resource, this.version)),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.failures = 0;
      if (this.queue.length) this.timer = setTimeout(() => this.flush(), 200);
      return true;
    } catch (e) {
      // Retry a few times with back-off, then drop: logging must never break sync.
      this.failures += 1;
      if (this.failures <= 3) {
        this.queue.unshift(...batch);
        this.timer = setTimeout(() => this.flush(), this.flushMs * 2 ** this.failures);
      }
      console.warn('[narada] telemetry export failed', e.message);
      return false;
    }
  }
}
