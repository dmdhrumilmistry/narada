// NIP-01 events and a small relay pool. Relays are used for signaling only.
import { schnorr } from '@noble/curves/secp256k1.js';
import { enc, hex, unhex, sha256 } from './crypto.js';
import { LIMITS } from '../shared/constants.js';

export function newNostrKey() {
  const sk = schnorr.utils.randomSecretKey();
  return { sk, pk: hex(schnorr.getPublicKey(sk)) };
}

const serialize = (e) => JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);

export async function signEvent({ kind, tags, content }, key) {
  const ev = { pubkey: key.pk, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  ev.id = hex(await sha256(enc(serialize(ev))));
  ev.sig = hex(schnorr.sign(unhex(ev.id), key.sk));
  return ev;
}

const HEX64 = /^[0-9a-f]{64}$/;
export async function verifyEvent(ev) {
  try {
    if (!ev || !HEX64.test(ev.id) || !HEX64.test(ev.pubkey) || !/^[0-9a-f]{128}$/.test(ev.sig)) return false;
    if (!Number.isInteger(ev.kind) || !Number.isInteger(ev.created_at) || typeof ev.content !== 'string' || !Array.isArray(ev.tags)) return false;
    const id = hex(await sha256(enc(serialize(ev))));
    if (id !== ev.id) return false;
    return schnorr.verify(unhex(ev.sig), unhex(ev.id), unhex(ev.pubkey));
  } catch {
    return false;
  }
}

class Relay {
  constructor(url, pool) {
    this.url = url;
    this.pool = pool;
    this.ws = null;
    this.backoff = 1000;
    this.closed = false;
    this.connect();
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      for (const [id, filters] of this.pool.subs) this.send(['REQ', id, ...filters]);
      this.pool.onChange();
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== 'string' || m.data.length > LIMITS.relayMessageBytes) return;
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (Array.isArray(msg) && msg[0] === 'EVENT' && this.pool.subs.has(msg[1])) this.pool.handleEvent(msg[2]);
    };
    ws.onclose = () => { this.pool.onChange(); this.retry(); };
    ws.onerror = () => {};
  }

  retry() {
    if (this.closed) return;
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  send(msg) { if (this.open) this.ws.send(JSON.stringify(msg)); }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }
}

export class RelayPool {
  constructor(urls, onEvent, onChange = () => {}) {
    this.urls = urls;
    this.onEvent = onEvent;
    this.onChange = onChange;
    this.relays = new Map();
    this.subs = new Map();
    this.seen = new Set();
  }

  status() {
    return { total: this.relays.size, connected: [...this.relays.values()].filter((r) => r.open).length };
  }

  ensureOpen() {
    for (const url of this.urls) if (!this.relays.has(url)) this.relays.set(url, new Relay(url, this));
  }

  // Close all sockets once no subscription needs them: after the handshake no
  // server is involved at all.
  maybeClose() {
    if (this.subs.size) return;
    for (const r of this.relays.values()) r.close();
    this.relays.clear();
    this.onChange();
  }

  subscribe(id, filters) {
    this.subs.set(id, filters);
    this.ensureOpen();
    for (const r of this.relays.values()) r.send(['REQ', id, ...filters]);
  }

  unsubscribe(id) {
    if (!this.subs.delete(id)) return;
    for (const r of this.relays.values()) r.send(['CLOSE', id]);
    this.maybeClose();
  }

  publish(ev) {
    this.ensureOpen();
    let sent = 0;
    for (const r of this.relays.values()) if (r.open) { r.send(['EVENT', ev]); sent++; }
    // Relays still connecting: retry shortly.
    if (sent < this.relays.size) {
      setTimeout(() => { for (const r of this.relays.values()) r.send(['EVENT', ev]); }, 1500);
    }
  }

  async handleEvent(ev) {
    if (!ev || typeof ev.id !== 'string' || this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    if (!(await verifyEvent(ev))) return;
    this.onEvent(ev);
  }

  close() {
    this.subs.clear();
    this.maybeClose();
  }
}
