// One-time-code pairing with mutual signatures and a short authentication string.
//
//   B -> A  hello   {pubB, nameB, nonceB}
//   A -> B  welcome {pubA, nameA, nonceA, sigA(T)}
//   B -> A  confirm {sigB(T)}
//   T = SHA-256(lp("narada-pair-v1", pubA, pubB, nonceA, nonceB))
//
// All messages are AES-GCM encrypted under a key derived from the 256-bit
// one-time secret, so only holders of the code can take part. SAS compares T
// out of band as a final check against a leaked code.
import { PAIR_CODE_PREFIX, PAIR_CODE_TTL_MS } from '../shared/constants.js';
import { cleanName } from '../shared/validate.js';
import {
  assertValidP256, b64u, ctEqual, deviceIdOf, hex, hkdfAesKey, hkdfBits, hkdfKey, lp, rand, sas, sha256, sign, unb64u, verify,
} from './crypto.js';
import { SignalTopic } from './signaling.js';

export async function deriveTopic(baseKey, salt, label) {
  const topic = hex(await hkdfBits(baseKey, salt, `${label}-topic`));
  const key = await hkdfAesKey(baseKey, salt, `${label}-enc`);
  return { topic, key };
}

export function parseCode(code) {
  const c = String(code || '').trim();
  if (!c.startsWith(PAIR_CODE_PREFIX)) throw new Error('Invalid pairing code');
  const s = unb64u(c.slice(PAIR_CODE_PREFIX.length));
  if (s.length !== 32) throw new Error('Invalid pairing code');
  return s;
}

export async function pairTranscript(pubA, pubB, nonceA, nonceB) {
  return sha256(lp('narada-pair-v1', pubA, pubB, nonceA, nonceB));
}

export async function derivePairKey(baseKey, transcript) {
  const bits = await hkdfBits(baseKey, transcript, 'pair-secret');
  const key = await hkdfKey(bits);
  bits.fill(0);
  return key;
}

export class PairingSession {
  constructor({ identity, name, pool, nostrKey, sid, onUpdate }) {
    Object.assign(this, { identity, name, pool, nostrKey, sid, onUpdate });
    this.state = 'init';
    this.error = null;
    this.timers = [];
  }

  async #setup(secret, role) {
    this.role = role;
    this.base = await hkdfKey(secret);
    const { topic, key } = await deriveTopic(this.base, 'narada-pair', 'pair');
    this.signal = new SignalTopic({ pool: this.pool, nostrKey: this.nostrKey, topic, key, sid: this.sid });
    this.signal.subscribe();
    this.expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    this.timers.push(setTimeout(() => this.#fail('Pairing code expired'), PAIR_CODE_TTL_MS));
  }

  async start() {
    const secret = rand(32);
    this.code = PAIR_CODE_PREFIX + b64u(secret);
    this.nonce = rand(16);
    await this.#setup(secret, 'initiator');
    secret.fill(0);
    this.#set('waiting');
  }

  async join(code) {
    const secret = parseCode(code);
    this.nonce = rand(16);
    await this.#setup(secret, 'joiner');
    secret.fill(0);
    this.#set('waiting');
    const hello = () => this.signal.send('hello', { pub: b64u(this.identity.pub), name: this.name, nonce: b64u(this.nonce) });
    hello();
    // Ephemeral events aren't stored by relays, so repeat until answered.
    const t = setInterval(() => (this.state === 'waiting' ? hello() : clearInterval(t)), 3000);
    this.timers.push(t);
  }

  async handle(ev) {
    if (!this.signal?.matches(ev) || ['verify', 'done', 'failed'].includes(this.state)) return;
    const env = await this.signal.open(ev);
    if (!env) return;
    try {
      if (this.role === 'initiator') await this.#initiatorStep(env);
      else await this.#joinerStep(env);
    } catch (e) {
      this.#fail(e.message || 'Pairing failed');
    }
  }

  async #initiatorStep({ type, body }) {
    if (type === 'hello') {
      const pub = unb64u(body?.pub);
      const nonce = unb64u(body?.nonce);
      if (nonce.length !== 16) throw new Error('bad nonce');
      await assertValidP256(pub);
      if (this.peer) {
        // Single use: only accept retransmits from the same device.
        if (!ctEqual(pub, this.peer.pub) || !ctEqual(nonce, this.peer.nonce)) return;
      } else {
        if (ctEqual(pub, this.identity.pub)) throw new Error('Cannot pair a device with itself');
        this.peer = { pub, nonce, name: cleanName(body.name), deviceId: await deviceIdOf(pub) };
        this.T = await pairTranscript(this.identity.pub, pub, this.nonce, nonce);
        this.sigA = await sign(this.identity.privateKey, this.T);
      }
      await this.signal.send('welcome', {
        pub: b64u(this.identity.pub), name: this.name, nonce: b64u(this.nonce), sig: b64u(this.sigA),
      });
    } else if (type === 'confirm' && this.peer) {
      if (!(await verify(this.peer.pub, unb64u(body?.sig), this.T))) throw new Error('Peer signature invalid');
      await this.#finish();
    }
  }

  async #joinerStep({ type, body }) {
    if (type !== 'welcome') return;
    const pub = unb64u(body?.pub);
    const nonce = unb64u(body?.nonce);
    if (nonce.length !== 16) throw new Error('bad nonce');
    await assertValidP256(pub);
    const T = await pairTranscript(pub, this.identity.pub, nonce, this.nonce);
    if (!(await verify(pub, unb64u(body.sig), T))) throw new Error('Peer signature invalid');
    this.peer = { pub, nonce, name: cleanName(body.name), deviceId: await deviceIdOf(pub) };
    this.T = T;
    const sig = b64u(await sign(this.identity.privateKey, T));
    for (const d of [0, 1500, 4000]) this.timers.push(setTimeout(() => this.signal.send('confirm', { sig }), d));
    await this.#finish(5000);
  }

  async #finish(unsubscribeDelay = 0) {
    this.pairKey = await derivePairKey(this.base, this.T);
    this.sas = await sas(this.T);
    this.#set('verify');
    setTimeout(() => this.signal.unsubscribe(), unsubscribeDelay);
  }

  /** Called after the user confirms the SAS matches on both screens. */
  record() {
    if (this.state !== 'verify') throw new Error('Nothing to confirm');
    this.#set('done');
    this.#cleanup();
    return {
      deviceId: this.peer.deviceId,
      name: this.peer.name,
      pub: this.peer.pub,
      pairKey: this.pairKey,
      createdAt: Date.now(),
    };
  }

  cancel() { this.#fail('Cancelled'); }

  #fail(msg) {
    if (this.state === 'done' || this.state === 'failed') return;
    this.error = msg;
    this.#set('failed');
    this.#cleanup();
    this.signal?.unsubscribe();
  }

  #cleanup() {
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.timers = [];
  }

  #set(state) {
    this.state = state;
    this.onUpdate?.();
  }

  view() {
    return {
      role: this.role, state: this.state, code: this.role === 'initiator' ? this.code : undefined,
      expiresAt: this.expiresAt, sas: this.sas, peerName: this.peer?.name, error: this.error,
    };
  }
}
