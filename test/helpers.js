import { generateIdentity } from '../src/engine/crypto.js';

// In-memory stand-in for RelayPool: every published event reaches every listener.
export class FakePool {
  constructor() { this.listeners = new Set(); this.subs = new Map(); this.published = []; }
  subscribe(id, f) { this.subs.set(id, f); }
  unsubscribe(id) { this.subs.delete(id); }
  publish(ev) { this.published.push(ev); for (const l of this.listeners) setTimeout(() => l(ev), 0); }
}

export const identity = async (name) => ({ ...(await generateIdentity()), name });
export const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); }
};
