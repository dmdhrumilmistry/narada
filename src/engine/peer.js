// One WebRTC connection to one paired device. Google STUN only, no TURN:
// after the handshake, data flows strictly peer-to-peer.
import { HEARTBEAT_MS, ICE_GATHER_TIMEOUT_MS, ICE_SERVERS, PEER_TIMEOUT_MS } from '../shared/constants.js';
import { SecureChannel } from './secure-channel.js';

const MAX_SDP = 32 * 1024;

export function dtlsFingerprint(sdp) {
  const fps = [...sdp.matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/gm)].map((m) => `${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  if (!fps.length) throw new Error('SDP without DTLS fingerprint');
  return [...new Set(fps)].sort().join(',');
}

function checkSdp(sdp) {
  if (typeof sdp !== 'string' || sdp.length > MAX_SDP || !sdp.startsWith('v=0')) throw new Error('invalid SDP');
  return sdp;
}

export class PeerLink {
  constructor({ identity, pair, role, iceServers = ICE_SERVERS, onReady, onMessage, onClose }) {
    Object.assign(this, { identity, pair, role, onReady, onMessage, onClose });
    this.state = 'connecting';
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(this.pc.connectionState)) this.close('connection ' + this.pc.connectionState);
    };
    if (role === 'offerer') this.#attach(this.pc.createDataChannel('narada', { ordered: true }));
    else this.pc.ondatachannel = (e) => this.#attach(e.channel);
  }

  async #gathered() {
    if (this.pc.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
        this.pc.addEventListener('icegatheringstatechange', () => {
          if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
        });
      });
    }
    return this.pc.localDescription.sdp;
  }

  async createOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.#gathered();
  }

  async acceptOffer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: checkSdp(sdp) });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.#gathered();
  }

  async acceptAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: checkSdp(sdp) });
  }

  #attach(dc) {
    if (this.dc) return dc.close(); // only one channel allowed
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      this.secure = new SecureChannel({
        identity: this.identity,
        pair: this.pair,
        role: this.role,
        localFp: dtlsFingerprint(this.pc.localDescription.sdp),
        remoteFp: dtlsFingerprint(this.pc.remoteDescription.sdp),
        send: (d) => this.#sendRaw(d),
        onReady: () => this.#ready(),
        onMessage: (m) => this.#message(m),
        onClose: (r) => this.close(r),
      });
      this.secure.start().catch((e) => this.close(e.message));
    };
    dc.onmessage = (e) => { this.lastSeen = Date.now(); this.secure?.receive(e.data); };
    dc.onclose = () => this.close('channel closed');
  }

  async #sendRaw(data) {
    const dc = this.dc;
    if (dc.readyState !== 'open') throw new Error('channel not open');
    if (dc.bufferedAmount > 4 * 1024 * 1024) {
      dc.bufferedAmountLowThreshold = 1024 * 1024;
      await new Promise((r) => dc.addEventListener('bufferedamountlow', r, { once: true }));
    }
    dc.send(data);
  }

  #ready() {
    this.state = 'connected';
    this.lastSeen = Date.now();
    this.hb = setInterval(() => {
      if (Date.now() - this.lastSeen > PEER_TIMEOUT_MS) return this.close('peer timeout');
      this.send({ type: 'ping' }).catch(() => {});
    }, HEARTBEAT_MS);
    this.onReady?.(this);
  }

  #message(m) {
    if (m.type === 'ping') return;
    this.onMessage?.(m, this);
  }

  send(obj) {
    if (this.state !== 'connected') return Promise.reject(new Error('not connected'));
    return this.secure.sendMessage(obj);
  }

  close(reason = 'closed') {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearInterval(this.hb);
    this.secure?.close(reason);
    try { this.dc?.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.onClose?.(this, reason);
  }
}
