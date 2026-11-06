// Sync engine: identity, pairing, signaling, peer connections and the command API
// used by the popup. Runs in the Chromium offscreen document or the Firefox
// background page. Privileged browser APIs are reached through `ops`.
import { DEFAULT_RELAYS, LIMITS, OFFER_TIMEOUT_MS, PENDING_TRANSFER_TTL_MS } from '../shared/constants.js';
import { cleanName, safeRelayUrl, validateTabList, validateTransfer } from '../shared/validate.js';
import { b64u, generateIdentity, hex, rand } from './crypto.js';
import { newNostrKey, RelayPool } from './nostr.js';
import { deriveTopic, PairingSession } from './pairing.js';
import { PeerLink } from './peer.js';
import { SignalTopic } from './signaling.js';
import * as store from './store.js';

const day = (offset = 0) => Math.floor(Date.now() / 86_400_000) + offset;
const newId = () => b64u(rand(12));

export class Engine {
  constructor(ops) {
    this.ops = ops; // (method, args) => Promise
    this.pairs = new Map(); // deviceId -> pair record
    this.topics = new Map(); // deviceId -> Map(day -> SignalTopic)
    this.links = new Map(); // deviceId -> PeerLink
    this.pendingOffers = new Map(); // deviceId -> { sess, timer }
    this.status = new Map(); // deviceId -> 'offline'|'connecting'|'connected'
    this.incoming = new Map(); // transferId -> pending transfer (memory only)
    this.outgoing = []; // recent sent transfers (metadata only)
    this.remoteTabs = new Map(); // deviceId -> { at, tabs }
    this.sid = hex(rand(8));
    this.nostrKey = newNostrKey(); // ephemeral, never persisted
  }

  async init() {
    this.identity = await store.get('identity');
    if (!this.identity) {
      const id = await generateIdentity();
      const browser = /Firefox\//.test(navigator.userAgent) ? 'Firefox' : /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome';
      this.identity = { ...id, name: `${browser} ${id.deviceId.slice(0, 4).toUpperCase()}`, createdAt: Date.now() };
      await store.set('identity', this.identity);
    }
    this.settings = { relays: DEFAULT_RELAYS, shareTabList: true, ...(await store.get('settings')) };
    for (const p of await store.listPrefix('pair:')) this.pairs.set(p.deviceId, p);
    this.#newPool();
    for (const id of this.pairs.keys()) { this.status.set(id, 'offline'); this.#listen(id); }
    setInterval(() => this.#rotateTopics(), 10 * 60 * 1000);
    for (const id of this.pairs.keys()) this.connect(id).catch(() => {});
  }

  #newPool() {
    this.pool?.close();
    this.pool = new RelayPool(this.settings.relays, (ev) => this.#onEvent(ev));
  }

  // ---------- signaling ----------
  async #listen(deviceId) {
    const pair = this.pairs.get(deviceId);
    if (!pair || this.links.get(deviceId)?.state === 'connected') return;
    const map = this.topics.get(deviceId) ?? new Map();
    this.topics.set(deviceId, map);
    const wanted = [day(-1), day(0), day(1)];
    for (const d of wanted) {
      if (map.has(d)) continue;
      const { topic, key } = await deriveTopic(pair.pairKey, `day:${d}`, 'rdv');
      const t = new SignalTopic({ pool: this.pool, nostrKey: this.nostrKey, topic, key, sid: this.sid });
      map.set(d, t);
      t.subscribe();
    }
    for (const [d, t] of map) if (!wanted.includes(d)) { t.unsubscribe(); map.delete(d); }
  }

  #unlisten(deviceId) {
    for (const t of this.topics.get(deviceId)?.values() ?? []) t.unsubscribe();
    this.topics.delete(deviceId);
  }

  #rotateTopics() {
    for (const id of this.topics.keys()) this.#listen(id);
    // Periodically re-announce to devices that are still offline.
    for (const id of this.pairs.keys()) if (!this.links.has(id)) this.connect(id).catch(() => {});
  }

  async #onEvent(ev) {
    if (this.pairing) await this.pairing.handle(ev);
    for (const [deviceId, map] of this.topics) {
      for (const t of map.values()) {
        if (!t.matches(ev)) continue;
        const env = await t.open(ev);
        if (env) await this.#onSignal(deviceId, env).catch((e) => console.warn('signal error', e.message));
        return;
      }
    }
  }

  async #sendSignal(deviceId, type, body) {
    await this.#listen(deviceId);
    await this.topics.get(deviceId).get(day(0)).send(type, body);
  }

  async #onSignal(deviceId, { type, body }) {
    const pair = this.pairs.get(deviceId);
    if (!pair || !body || typeof body.sess !== 'string' || body.sess.length > 64) return;
    if (type === 'offer') {
      const mine = this.pendingOffers.get(deviceId);
      // Glare: the lower deviceId is polite and yields to the remote offer.
      if (mine && this.identity.deviceId > deviceId) return;
      if (mine) { clearTimeout(mine.timer); this.pendingOffers.delete(deviceId); }
      this.links.get(deviceId)?.close('replaced');
      const link = this.#newLink(pair, 'answerer');
      const sdp = await link.acceptOffer(body.sdp);
      await this.#sendSignal(deviceId, 'answer', { sess: body.sess, sdp });
    } else if (type === 'answer') {
      const mine = this.pendingOffers.get(deviceId);
      if (!mine || mine.sess !== body.sess) return;
      await this.links.get(deviceId)?.acceptAnswer(body.sdp);
    }
  }

  // ---------- connections ----------
  #newLink(pair, role) {
    this.status.set(pair.deviceId, 'connecting');
    const link = new PeerLink({
      identity: this.identity,
      pair,
      role,
      onReady: () => {
        if (this.links.get(pair.deviceId) !== link) return link.close('stale');
        const p = this.pendingOffers.get(pair.deviceId);
        if (p) { clearTimeout(p.timer); this.pendingOffers.delete(pair.deviceId); }
        this.status.set(pair.deviceId, 'connected');
        // Handshake done: stop using relays for this device.
        this.#unlisten(pair.deviceId);
      },
      onMessage: (m) => this.#onPeerMessage(pair.deviceId, m).catch((e) => console.warn('peer message error', e.message)),
      onClose: () => {
        if (this.links.get(pair.deviceId) !== link) return;
        const wasConnected = this.status.get(pair.deviceId) === 'connected';
        this.links.delete(pair.deviceId);
        this.status.set(pair.deviceId, 'offline');
        if (!this.pairs.has(pair.deviceId)) return;
        this.#listen(pair.deviceId);
        // Dropped connection: try once to re-establish (jittered to limit glare).
        if (wasConnected) setTimeout(() => this.connect(pair.deviceId).catch(() => {}), 2000 + Math.random() * 4000);
      },
    });
    this.links.set(pair.deviceId, link);
    return link;
  }

  async connect(deviceId) {
    const pair = this.pairs.get(deviceId);
    if (!pair) throw new Error('Unknown device');
    if (this.links.has(deviceId) && this.status.get(deviceId) !== 'offline') return;
    const sess = newId();
    const link = this.#newLink(pair, 'offerer');
    const timer = setTimeout(() => {
      if (this.pendingOffers.get(deviceId)?.sess !== sess) return;
      this.pendingOffers.delete(deviceId);
      link.close('no answer');
    }, OFFER_TIMEOUT_MS);
    this.pendingOffers.set(deviceId, { sess, timer });
    const sdp = await link.createOffer();
    if (this.pendingOffers.get(deviceId)?.sess === sess) await this.#sendSignal(deviceId, 'offer', { sess, sdp });
  }

  #link(deviceId) {
    const l = this.links.get(deviceId);
    if (!l || l.state !== 'connected') throw new Error('Device is not connected');
    return l;
  }

  // ---------- peer messages ----------
  async #onPeerMessage(deviceId, m) {
    const link = this.links.get(deviceId);
    switch (m.type) {
      case 'tabs.list.req': {
        const tabs = this.settings.shareTabList ? await this.ops('listTabs') : null;
        await link.send({ type: 'tabs.list.res', id: String(m.id).slice(0, 64), tabs, disabled: !tabs });
        break;
      }
      case 'tabs.list.res': {
        const tabs = m.disabled ? [] : validateTabList(m.tabs);
        if (tabs) this.remoteTabs.set(deviceId, { at: Date.now(), tabs, disabled: !!m.disabled });
        break;
      }
      case 'transfer': {
        const t = validateTransfer(m);
        const fromDevice = [...this.incoming.values()].filter((x) => x.from === deviceId).length;
        if (!t || this.incoming.has(t.id) || fromDevice >= 10) {
          await link.send({ type: 'transfer.ack', id: String(m.id).slice(0, 64), status: 'invalid' });
          break;
        }
        const entry = { ...t, from: deviceId, fromName: this.pairs.get(deviceId).name, at: Date.now() };
        entry.timer = setTimeout(() => this.#resolveIncoming(t.id, 'expired'), PENDING_TRANSFER_TTL_MS);
        this.incoming.set(t.id, entry);
        await this.#badge();
        const sensitive = t.tabs.some((x) => x.cookies?.length || x.storage);
        await this.ops('notify', {
          title: `${entry.fromName} sent ${t.tabs.length} tab(s)`,
          message: sensitive ? 'Includes cookies/site data. Open WebSync to review.' : 'Open WebSync to review.',
        });
        break;
      }
      case 'transfer.ack': {
        const o = this.outgoing.find((x) => x.id === m.id && x.to === deviceId);
        if (o && typeof m.status === 'string') o.status = m.status.slice(0, 32);
        break;
      }
      default:
        break; // unknown types are ignored (forward compatibility)
    }
  }

  async #resolveIncoming(id, status) {
    const t = this.incoming.get(id);
    if (!t) return null;
    clearTimeout(t.timer);
    this.incoming.delete(id);
    await this.#badge();
    this.links.get(t.from)?.send({ type: 'transfer.ack', id, status }).catch(() => {});
    return t;
  }

  #badge() {
    return this.ops('badge', { text: this.incoming.size ? String(this.incoming.size) : '' }).catch(() => {});
  }

  // ---------- commands (from popup) ----------
  async command(cmd, a = {}) {
    switch (cmd) {
      case 'getState': return this.#state();
      case 'pairStart':
      case 'pairJoin': {
        this.pairing?.cancel();
        this.pairing = new PairingSession({
          identity: this.identity, name: this.identity.name, pool: this.pool, nostrKey: this.nostrKey, sid: this.sid,
        });
        if (cmd === 'pairStart') await this.pairing.start();
        else await this.pairing.join(a.code);
        return this.pairing.view();
      }
      case 'pairConfirm': {
        const rec = this.pairing.record();
        this.pairing = null;
        this.pairs.set(rec.deviceId, rec);
        await store.set('pair:' + rec.deviceId, rec);
        this.status.set(rec.deviceId, 'offline');
        await this.#listen(rec.deviceId);
        this.connect(rec.deviceId).catch(() => {});
        return true;
      }
      case 'pairCancel':
        this.pairing?.cancel();
        this.pairing = null;
        return true;
      case 'connect':
        await this.connect(a.deviceId);
        return true;
      case 'unpair': {
        this.links.get(a.deviceId)?.close('unpaired');
        this.#unlisten(a.deviceId);
        this.pairs.delete(a.deviceId);
        this.status.delete(a.deviceId);
        this.remoteTabs.delete(a.deviceId);
        await store.del('pair:' + a.deviceId);
        return true;
      }
      case 'requestTabs':
        await this.#link(a.deviceId).send({ type: 'tabs.list.req', id: newId() });
        return true;
      case 'sendTransfer': {
        const t = validateTransfer({ id: newId(), tabs: a.tabs });
        if (!t) throw new Error('Nothing valid to send');
        await this.#link(a.deviceId).send({ type: 'transfer', ...t });
        this.outgoing.unshift({ id: t.id, to: a.deviceId, count: t.tabs.length, at: Date.now(), status: 'sent' });
        this.outgoing.length = Math.min(this.outgoing.length, 20);
        return { id: t.id, count: t.tabs.length };
      }
      case 'acceptTransfer': {
        const t = this.incoming.get(a.id);
        if (!t) throw new Error('Transfer expired');
        const result = await this.ops('applyTransfer', { tabs: t.tabs });
        await this.#resolveIncoming(a.id, 'accepted');
        return result;
      }
      case 'rejectTransfer':
        await this.#resolveIncoming(a.id, 'rejected');
        return true;
      case 'setSettings': return this.#setSettings(a);
      default:
        throw new Error('Unknown command');
    }
  }

  async #setSettings(a) {
    if (a.name !== undefined) {
      this.identity.name = cleanName(a.name);
      await store.set('identity', this.identity);
    }
    if (a.shareTabList !== undefined) this.settings.shareTabList = !!a.shareTabList;
    if (a.relays !== undefined) {
      const relays = [...new Set((a.relays || []).map(safeRelayUrl).filter(Boolean))].slice(0, LIMITS.relays);
      if (!relays.length) throw new Error('At least one wss:// relay is required');
      this.settings.relays = relays;
      // Rebuild the pool and re-subscribe every pair's topics.
      for (const id of [...this.topics.keys()]) this.#unlisten(id);
      this.#newPool();
      for (const id of this.pairs.keys()) this.#listen(id);
    }
    await store.set('settings', this.settings);
    return true;
  }

  #state() {
    return {
      device: { id: this.identity.deviceId, name: this.identity.name },
      relays: this.pool.status(),
      settings: this.settings,
      pairing: this.pairing?.view() ?? null,
      devices: [...this.pairs.values()].map((p) => ({
        deviceId: p.deviceId, name: p.name, createdAt: p.createdAt, status: this.status.get(p.deviceId) ?? 'offline',
      })),
      // Summaries only: cookie and storage values never leave the engine except to be applied.
      incoming: [...this.incoming.values()].map((t) => ({
        id: t.id, fromName: t.fromName, at: t.at,
        tabs: t.tabs.map((x) => ({
          url: x.url, title: x.title,
          cookieCount: x.cookies?.length ?? 0,
          cookieDomains: [...new Set((x.cookies ?? []).map((c) => c.domain.replace(/^\./, '')))],
          storageKeys: x.storage ? Object.keys(x.storage.local).length + Object.keys(x.storage.session).length : 0,
        })),
      })),
      outgoing: this.outgoing.map((o) => ({ ...o, toName: this.pairs.get(o.to)?.name ?? 'removed device' })),
      remoteTabs: Object.fromEntries(this.remoteTabs),
    };
  }
}
