// Sync engine: identity, pairing, signaling, peer connections and the command API
// used by the popup. Runs in the Chromium offscreen document or the Firefox
// background page. Privileged browser APIs are reached through `ops`.
import { DEFAULT_RELAYS, HISTORY_MAX, LIMITS, NOTE_TTL_MS, OFFER_TIMEOUT_MS, PENDING_TRANSFER_TTL_MS } from '../shared/constants.js';
import { cleanName, cleanNoteText, safeRelayUrl, validateNote, validateTabList, validateTransfer } from '../shared/validate.js';
import { b64u, generateIdentity, hex, rand } from './crypto.js';
import { newNostrKey, RelayPool } from './nostr.js';
import { deriveTopic, PairingSession } from './pairing.js';
import { PeerLink } from './peer.js';
import { SignalTopic } from './signaling.js';
import * as store from './store.js';

const day = (offset = 0) => Math.floor(Date.now() / 86_400_000) + offset;
const newId = () => b64u(rand(12));

export function browserName(ua = navigator.userAgent) {
  if (navigator.brave) return 'Brave';
  const known = [[/Edg\//, 'Edge'], [/OPR\//, 'Opera'], [/Vivaldi/, 'Vivaldi'], [/LibreWolf/, 'LibreWolf'],
    [/Waterfox/, 'Waterfox'], [/Floorp/, 'Floorp'], [/Zen\//, 'Zen'], [/Firefox\//, 'Firefox'], [/Chrome\//, 'Chrome']];
  return known.find(([re]) => re.test(ua))?.[1] ?? 'Browser';
}

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
    this.lastIssue = new Map(); // deviceId -> last connection problem (shown in UI)
    this.autoOpenLog = new Map(); // deviceId -> timestamps of auto-opened transfers (rate limit)
    this.sid = hex(rand(8));
    this.nostrKey = newNostrKey(); // ephemeral, never persisted
  }

  async init() {
    // Some hardened browsers (e.g. LibreWolf, or media.peerconnection.enabled=false) disable WebRTC.
    this.webrtc = typeof globalThis.RTCPeerConnection === 'function';
    this.identity = await store.get('identity');
    if (!this.identity) {
      const id = await generateIdentity();
      this.identity = { ...id, name: `${browserName()} ${id.deviceId.slice(0, 4).toUpperCase()}`, createdAt: Date.now() };
      await store.set('identity', this.identity);
    }
    this.settings = { relays: DEFAULT_RELAYS, shareTabList: true, keepHistory: true, ...(await store.get('settings')) };
    this.history = this.settings.keepHistory ? ((await store.get('history')) ?? []) : [];
    for (const p of await store.listPrefix('pair:')) this.pairs.set(p.deviceId, p);
    this.#newPool();
    for (const id of this.pairs.keys()) { this.#setStatus(id, 'offline'); this.#listen(id); }
    setInterval(() => this.#rotateTopics(), 10 * 60 * 1000);
    for (const id of this.pairs.keys()) this.connect(id).catch(() => {});
  }

  #newPool() {
    this.pool?.close();
    this.pool = new RelayPool(this.settings.relays, (ev) => this.#onEvent(ev));
  }

  // ---------- device list → background (context menus) ----------
  #setStatus(deviceId, status) {
    this.status.set(deviceId, status);
    this.#devicesChanged();
  }

  #devicesChanged() {
    clearTimeout(this.devicesTimer);
    this.devicesTimer = setTimeout(() => {
      this.ops('devices', { devices: this.#deviceList(), lastTarget: this.settings.lastTarget ?? null }).catch(() => {});
    }, 300);
  }

  #deviceList() {
    return [...this.pairs.values()].map((p) => ({
      deviceId: p.deviceId, name: p.name, createdAt: p.createdAt, autoOpen: !!p.autoOpen,
      status: this.status.get(p.deviceId) ?? 'offline',
    }));
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
        if (env) {
          await this.#onSignal(deviceId, env).catch((e) => {
            this.lastIssue.set(deviceId, `handshake error: ${e.message}`);
            this.links.get(deviceId)?.close('handshake error');
          });
        }
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
      if (!this.webrtc) return;
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
    this.#setStatus(pair.deviceId, 'connecting');
    const link = new PeerLink({
      identity: this.identity,
      pair,
      role,
      onReady: () => {
        if (this.links.get(pair.deviceId) !== link) return link.close('stale');
        const p = this.pendingOffers.get(pair.deviceId);
        if (p) { clearTimeout(p.timer); this.pendingOffers.delete(pair.deviceId); }
        this.#setStatus(pair.deviceId, 'connected');
        this.lastIssue.delete(pair.deviceId);
        // Handshake done: stop using relays for this device.
        this.#unlisten(pair.deviceId);
      },
      onMessage: (m) => this.#onPeerMessage(pair.deviceId, m).catch((e) => console.warn('peer message error', e.message)),
      onClose: (_l, reason) => {
        if (this.links.get(pair.deviceId) !== link) return;
        if (!['replaced', 'unpaired', 'stale'].includes(reason)) this.lastIssue.set(pair.deviceId, reason);
        const wasConnected = this.status.get(pair.deviceId) === 'connected';
        this.links.delete(pair.deviceId);
        this.#setStatus(pair.deviceId, 'offline');
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
    if (!this.webrtc) throw new Error('WebRTC is disabled in this browser');
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
        const pair = this.pairs.get(deviceId);
        const sensitive = t.tabs.some((x) => x.cookies?.length || x.storage);
        if (pair.autoOpen && !sensitive && this.#autoOpenAllowed(deviceId)) {
          // Trusted device + plain tabs: open right away. Sign-in data never auto-applies.
          const r = await this.ops('applyTransfer', { tabs: t.tabs });
          await this.#remember(deviceId, t.tabs);
          await link.send({ type: 'transfer.ack', id: t.id, status: 'accepted' });
          await this.ops('notify', { title: `Opened ${r.opened} tab(s) from ${pair.name}`, message: 'Auto-open is on for this device. Turn it off in Lokas.' });
          break;
        }
        const entry = { ...t, kind: 'tabs', from: deviceId, fromName: pair.name, at: Date.now() };
        entry.timer = setTimeout(() => this.#resolveIncoming(t.id, 'expired'), PENDING_TRANSFER_TTL_MS);
        this.incoming.set(t.id, entry);
        await this.#badge();
        await this.ops('notify', {
          title: `${entry.fromName} sent ${t.tabs.length} tab(s)`,
          message: sensitive ? 'Includes cookies/site data. Open Narada to review.' : 'Open Narada to review.',
        });
        break;
      }
      case 'note': {
        const n = validateNote(m);
        const fromDevice = [...this.incoming.values()].filter((x) => x.from === deviceId).length;
        if (!n || this.incoming.has(n.id) || fromDevice >= 10) {
          await link.send({ type: 'transfer.ack', id: String(m.id).slice(0, 64), status: 'invalid' });
          break;
        }
        const pair = this.pairs.get(deviceId);
        // Notes stay in memory only and expire; never written to disk.
        const entry = { ...n, kind: 'note', from: deviceId, fromName: pair.name, at: Date.now() };
        entry.timer = setTimeout(() => this.#resolveIncoming(n.id, 'expired'), NOTE_TTL_MS);
        this.incoming.set(n.id, entry);
        await this.#badge();
        await link.send({ type: 'transfer.ack', id: n.id, status: 'delivered' });
        // No preview in the notification: notes may hold sensitive text.
        await this.ops('notify', { title: `${pair.name} sent you a note`, message: 'Open Narada to read it.' });
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

  // Received-tab history: URLs and titles only (never cookies, storage or note text).
  async #remember(fromId, tabs) {
    if (!this.settings.keepHistory) return;
    this.history.unshift({
      at: Date.now(), fromName: this.pairs.get(fromId)?.name ?? 'removed device',
      tabs: tabs.map((t) => ({ url: t.url, title: t.title })),
    });
    this.history.length = Math.min(this.history.length, HISTORY_MAX);
    await store.set('history', this.history);
  }

  // At most 5 auto-opened transfers per device per minute; the rest wait for approval.
  #autoOpenAllowed(deviceId) {
    const now = Date.now();
    const recent = (this.autoOpenLog.get(deviceId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 5) return false;
    recent.push(now);
    this.autoOpenLog.set(deviceId, recent);
    return true;
  }

  async #waitConnected(deviceId, timeoutMs = 20_000) {
    if (this.status.get(deviceId) !== 'connected') await this.connect(deviceId);
    const end = Date.now() + timeoutMs;
    while (this.status.get(deviceId) !== 'connected') {
      if (Date.now() > end) throw new Error(`${this.pairs.get(deviceId)?.name ?? 'Device'} is offline. Open Narada on it and try again.`);
      if (this.status.get(deviceId) === 'offline' && !this.links.has(deviceId)) await this.connect(deviceId).catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
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
        this.#setStatus(rec.deviceId, 'offline');
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
        this.autoOpenLog.delete(a.deviceId);
        if (this.settings.lastTarget === a.deviceId) this.settings.lastTarget = null;
        await store.del('pair:' + a.deviceId);
        this.#devicesChanged();
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
        if (this.settings.lastTarget !== a.deviceId) {
          this.settings.lastTarget = a.deviceId;
          await store.set('settings', this.settings);
          this.#devicesChanged();
        }
        return { id: t.id, count: t.tabs.length };
      }
      case 'quickSend': {
        // Right-click menu / keyboard shortcut: plain tabs only (never sign-in data).
        const only = this.pairs.size === 1 ? [...this.pairs.keys()][0] : null;
        const deviceId = a.deviceId ?? (this.pairs.has(this.settings.lastTarget) ? this.settings.lastTarget : only);
        if (!deviceId || !this.pairs.has(deviceId)) throw new Error('Pick a device in Narada first (send once from the popup).');
        const tabs = (a.tabs ?? []).map((x) => ({ url: x.url, title: x.title }));
        await this.#waitConnected(deviceId);
        const r = await this.command('sendTransfer', { deviceId, tabs });
        return { ...r, name: this.pairs.get(deviceId).name };
      }
      case 'sendNote': {
        const text = cleanNoteText(a.text);
        if (!text) throw new Error(`Write something to send (up to ${LIMITS.noteLength / 1024} KB).`);
        const id = newId();
        await this.#link(a.deviceId).send({ type: 'note', id, text });
        this.outgoing.unshift({ id, kind: 'note', to: a.deviceId, count: 1, at: Date.now(), status: 'sent' });
        this.outgoing.length = Math.min(this.outgoing.length, 20);
        return { id };
      }
      case 'quickNote': {
        const only = this.pairs.size === 1 ? [...this.pairs.keys()][0] : null;
        const deviceId = a.deviceId ?? (this.pairs.has(this.settings.lastTarget) ? this.settings.lastTarget : only);
        if (!deviceId || !this.pairs.has(deviceId)) throw new Error('Pick a device in Narada first (send once from the popup).');
        await this.#waitConnected(deviceId);
        const r = await this.command('sendNote', { deviceId, text: a.text });
        return { ...r, name: this.pairs.get(deviceId).name };
      }
      case 'dismissNote': {
        const n = this.incoming.get(a.id);
        if (!n || n.kind !== 'note') throw new Error('Note expired');
        await this.#resolveIncoming(a.id, 'read');
        return true;
      }
      case 'clearHistory':
        this.history = [];
        await store.del('history');
        return true;
      case 'setDeviceOptions': {
        const pair = this.pairs.get(a.deviceId);
        if (!pair) throw new Error('Unknown device');
        if (a.name !== undefined) pair.name = cleanName(a.name);
        if (a.autoOpen !== undefined) pair.autoOpen = !!a.autoOpen;
        await store.set('pair:' + pair.deviceId, pair);
        this.#devicesChanged();
        return true;
      }
      case 'acceptTransfer': {
        const t = this.incoming.get(a.id);
        if (!t) throw new Error('Transfer expired');
        if (t.kind !== 'tabs') throw new Error('Not a tab transfer');
        const result = await this.ops('applyTransfer', { tabs: t.tabs });
        await this.#remember(t.from, t.tabs);
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
    if (a.keepHistory !== undefined) {
      this.settings.keepHistory = !!a.keepHistory;
      if (!this.settings.keepHistory) { this.history = []; await store.del('history'); }
    }
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
      webrtc: this.webrtc,
      relays: this.pool.status(),
      settings: this.settings,
      pairing: this.pairing?.view() ?? null,
      devices: this.#deviceList().map((d) => ({
        ...d,
        issue: this.lastIssue.get(d.deviceId) ?? null,
      })),
      // Summaries only: cookie and storage values never leave the engine except to be applied.
      history: this.history,
      incoming: [...this.incoming.values()].map((t) => (t.kind === 'note' ? {
        id: t.id, kind: 'note', fromName: t.fromName, at: t.at, text: t.text,
      } : {
        id: t.id, kind: 'tabs', fromName: t.fromName, at: t.at,
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
