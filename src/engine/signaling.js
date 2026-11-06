// Encrypted, authenticated, replay-protected signaling envelopes over Nostr.
// Relays only see: an ephemeral pubkey, a random-looking topic tag and ciphertext.
import { NOSTR_KIND, SIGNAL_MAX_AGE_S } from '../shared/constants.js';
import { aesOpen, aesSeal, b64u, dec, enc, rand, unb64u } from './crypto.js';
import { signEvent } from './nostr.js';

export class SignalTopic {
  /**
   * @param {object} o
   * @param {RelayPool} o.pool
   * @param {object} o.nostrKey ephemeral Nostr key (per engine run)
   * @param {string} o.topic hex topic used as #p tag
   * @param {CryptoKey} o.key AES-GCM key
   * @param {string} o.sid random id of this endpoint (drops own echoes)
   */
  constructor({ pool, nostrKey, topic, key, sid }) {
    Object.assign(this, { pool, nostrKey, topic, key, sid });
    this.aad = enc(`narada-signal|${NOSTR_KIND}|${topic}`);
    this.nonces = new Map();
  }

  get subId() { return 'ws-' + this.topic.slice(0, 16); }

  subscribe() {
    this.pool.subscribe(this.subId, [{ kinds: [NOSTR_KIND], '#p': [this.topic], since: Math.floor(Date.now() / 1000) - SIGNAL_MAX_AGE_S }]);
  }

  unsubscribe() { this.pool.unsubscribe(this.subId); }

  matches(ev) {
    return ev.kind === NOSTR_KIND && ev.tags.some((t) => t[0] === 'p' && t[1] === this.topic);
  }

  async send(type, body) {
    const env = { v: 1, type, sid: this.sid, ts: Math.floor(Date.now() / 1000), n: b64u(rand(16)), body };
    const sealed = await aesSeal(this.key, enc(JSON.stringify(env)), this.aad);
    const ev = await signEvent({ kind: NOSTR_KIND, tags: [['p', this.topic]], content: b64u(sealed) }, this.nostrKey);
    this.pool.publish(ev);
  }

  /** Returns the decoded envelope, or null if it is invalid, stale, replayed, or our own. */
  async open(ev) {
    let env;
    try {
      env = JSON.parse(dec(await aesOpen(this.key, unb64u(ev.content), this.aad)));
    } catch {
      return null; // not for us / tampered
    }
    if (!env || env.v !== 1 || typeof env.type !== 'string' || typeof env.n !== 'string') return null;
    if (env.sid === this.sid) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof env.ts !== 'number' || Math.abs(now - env.ts) > SIGNAL_MAX_AGE_S) return null;
    if (this.nonces.has(env.n)) return null;
    this.nonces.set(env.n, env.ts);
    for (const [n, ts] of this.nonces) if (now - ts > SIGNAL_MAX_AGE_S * 2) this.nonces.delete(n);
    return env;
  }
}
