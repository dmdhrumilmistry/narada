// Application-layer authenticated encryption over the WebRTC data channel.
// Defense in depth on top of DTLS: keys come from an ephemeral ECDH exchange mixed
// with the pair secret, the handshake is signed with pinned identity keys and is
// bound to the DTLS fingerprints of this very connection (channel binding).
import { LIMITS } from '../shared/constants.js';
import {
  aesOpen, aesSeal, b64u, concat, dec, ecdh, enc, generateEphemeral, hkdfAesKey, hkdfBits, hkdfKey, lp, rand, sha256, sign, unb64u, verify,
} from './crypto.js';

const AAD = enc('narada-frame-v1');

export async function sessionTranscript(o, a, offererFp, answererFp) {
  return sha256(lp('narada-sess-v1', o.id, o.eph, o.nonce, a.id, a.eph, a.nonce, offererFp, answererFp));
}

export class SecureChannel {
  /**
   * @param {object} o
   * @param {{privateKey: CryptoKey, pub: Uint8Array, deviceId: string}} o.identity
   * @param {{deviceId: string, pub: Uint8Array, pairKey: CryptoKey}} o.pair
   * @param {'offerer'|'answerer'} o.role
   * @param {string} o.localFp DTLS fingerprint from local SDP
   * @param {string} o.remoteFp DTLS fingerprint from remote SDP
   * @param {(data: string|Uint8Array) => Promise|void} o.send
   */
  constructor(o) {
    Object.assign(this, o);
    this.ready = false;
    this.closed = false;
    this.inQ = Promise.resolve();
    this.outQ = Promise.resolve();
    this.sendSeq = 0n;
    this.recvSeq = 0n;
    this.parts = [];
    this.partBytes = 0;
  }

  // Queued on the inbound chain so a fast peer's auth1 is never processed before
  // our own ephemeral key exists (Firefox can deliver it that early).
  start() {
    const job = this.inQ.then(async () => {
      this.eph = await generateEphemeral();
      this.nonce = rand(16);
      await this.send(JSON.stringify({ t: 'auth1', eph: b64u(this.eph.pub), nonce: b64u(this.nonce) }));
    });
    this.inQ = job.catch((e) => this.close(e.message || 'handshake failed'));
    return job;
  }

  receive(data) {
    this.inQ = this.inQ.then(() => this.#receive(data)).catch((e) => this.close(e.message || 'protocol error'));
    return this.inQ;
  }

  async #receive(data) {
    if (this.closed) return;
    if (!this.ready) {
      if (typeof data !== 'string' || data.length > 4096) throw new Error('unexpected pre-auth frame');
      const m = JSON.parse(data);
      if (m.t === 'auth1' && !this.H) return this.#onAuth1(m);
      if (m.t === 'auth2' && this.H) return this.#onAuth2(m);
      throw new Error('unexpected handshake message');
    }
    if (typeof data === 'string') throw new Error('plaintext after auth');
    return this.#onFrame(new Uint8Array(data));
  }

  async #onAuth1(m) {
    const peerEph = unb64u(m.eph);
    const peerNonce = unb64u(m.nonce);
    if (peerEph.length !== 65 || peerNonce.length !== 16) throw new Error('bad auth1');
    const me = { id: enc(this.identity.deviceId), eph: this.eph.pub, nonce: this.nonce };
    const them = { id: enc(this.pair.deviceId), eph: peerEph, nonce: peerNonce };
    const offerer = this.role === 'offerer';
    this.H = await sessionTranscript(
      offerer ? me : them, offerer ? them : me,
      enc(offerer ? this.localFp : this.remoteFp), enc(offerer ? this.remoteFp : this.localFp),
    );
    const shared = await ecdh(this.eph.privateKey, peerEph);
    const psk = await hkdfBits(this.pair.pairKey, this.H, 'sess-psk');
    const base = await hkdfKey(concat(shared, psk));
    shared.fill(0);
    psk.fill(0);
    this.sendKey = await hkdfAesKey(base, this.H, 'k:' + this.identity.deviceId);
    this.recvKey = await hkdfAesKey(base, this.H, 'k:' + this.pair.deviceId);
    const sig = await sign(this.identity.privateKey, this.H);
    await this.send(JSON.stringify({ t: 'auth2', sig: b64u(sig) }));
  }

  async #onAuth2(m) {
    if (!(await verify(this.pair.pub, unb64u(m.sig), this.H))) throw new Error('peer authentication failed');
    this.ready = true;
    this.onReady?.();
  }

  async #onFrame(frame) {
    if (frame.length < 12 + 16 + 1) throw new Error('short frame');
    const dv = new DataView(frame.buffer, frame.byteOffset, 12);
    if (dv.getUint32(0) !== 0) throw new Error('bad iv');
    const seq = dv.getBigUint64(4);
    if (seq !== this.recvSeq + 1n) throw new Error('replayed or out-of-order frame');
    const pt = await aesOpen(this.recvKey, frame, AAD); // throws on tamper
    this.recvSeq = seq;
    const more = pt[0] === 0;
    this.parts.push(pt.subarray(1));
    this.partBytes += pt.length - 1;
    if (this.partBytes > LIMITS.messageBytes) throw new Error('message too large');
    if (more) return;
    const whole = concat(...this.parts);
    this.parts = [];
    this.partBytes = 0;
    let msg;
    try { msg = JSON.parse(dec(whole)); } catch { throw new Error('bad message'); }
    if (!msg || typeof msg.type !== 'string') throw new Error('bad message');
    this.onMessage?.(msg);
  }

  sendMessage(obj) {
    if (!this.ready || this.closed) return Promise.reject(new Error('channel not ready'));
    const bytes = enc(JSON.stringify(obj));
    if (bytes.length > LIMITS.messageBytes) return Promise.reject(new Error('message too large'));
    const job = async () => {
      const n = LIMITS.frameChunkBytes;
      for (let off = 0; off === 0 || off < bytes.length; off += n) {
        const chunk = bytes.subarray(off, off + n);
        const last = off + n >= bytes.length;
        this.sendSeq += 1n;
        const iv = new Uint8Array(12);
        new DataView(iv.buffer).setBigUint64(4, this.sendSeq);
        const frame = await aesSeal(this.sendKey, concat(Uint8Array.of(last ? 1 : 0), chunk), AAD, iv);
        await this.send(frame);
      }
    };
    this.outQ = this.outQ.then(job);
    return this.outQ;
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.onClose?.(reason);
  }
}
