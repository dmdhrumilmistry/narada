// WebCrypto helpers. Private/derived keys are non-extractable wherever possible.
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const enc = (s) => te.encode(s);
export const dec = (b) => td.decode(b);
export const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Length-prefixed concatenation, so transcripts are unambiguous.
export function lp(...parts) {
  return concat(...parts.flatMap((p) => {
    const b = typeof p === 'string' ? enc(p) : p;
    const l = new Uint8Array(4);
    new DataView(l.buffer).setUint32(0, b.length);
    return [l, b];
  }));
}

export function b64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('invalid base64url');
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function unhex(h) {
  if (typeof h !== 'string' || h.length % 2 || !/^[0-9a-f]*$/i.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

export function ctEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

// ---- HKDF ----
export const hkdfKey = (ikm) => subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits', 'deriveKey']);

export async function hkdfBits(baseKey, salt, info, bits = 256) {
  const params = { name: 'HKDF', hash: 'SHA-256', salt: typeof salt === 'string' ? enc(salt) : salt, info: enc(info) };
  return new Uint8Array(await subtle.deriveBits(params, baseKey, bits));
}

export function hkdfAesKey(baseKey, salt, info) {
  const params = { name: 'HKDF', hash: 'SHA-256', salt: typeof salt === 'string' ? enc(salt) : salt, info: enc(info) };
  return subtle.deriveKey(params, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---- AES-256-GCM ----
export async function aesSeal(key, plaintext, aad, iv = rand(12)) {
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext));
  return concat(iv, ct);
}

export async function aesOpen(key, sealed, aad) {
  if (sealed.length < 12 + 16) throw new Error('ciphertext too short');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: aad }, key, sealed.subarray(12));
  return new Uint8Array(pt);
}

// ---- Identity (ECDSA P-256) ----
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

export async function generateIdentity() {
  const kp = await subtle.generateKey(ECDSA, false, ['sign', 'verify']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, pub, deviceId: await deviceIdOf(pub) };
}

export async function deviceIdOf(pubRaw) {
  return hex(await sha256(pubRaw)).slice(0, 32);
}

export async function sign(privateKey, data) {
  return new Uint8Array(await subtle.sign(SIGN, privateKey, data));
}

export async function verify(pubRaw, sig, data) {
  try {
    const key = await subtle.importKey('raw', pubRaw, ECDSA, false, ['verify']);
    return await subtle.verify(SIGN, key, sig, data);
  } catch {
    return false;
  }
}

export async function assertValidP256(pubRaw) {
  if (!(pubRaw instanceof Uint8Array) || pubRaw.length !== 65 || pubRaw[0] !== 4) throw new Error('bad public key');
  await subtle.importKey('raw', pubRaw, ECDSA, false, ['verify']); // throws if not on curve
}

// ---- Ephemeral ECDH P-256 ----
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export async function generateEphemeral() {
  const kp = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, pub };
}

export async function ecdh(privateKey, peerPubRaw) {
  const peer = await subtle.importKey('raw', peerPubRaw, ECDH, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
}

// 6-digit short authentication string from a transcript hash.
export async function sas(transcript) {
  const h = await sha256(concat(enc('websync-sas'), transcript));
  const n = new DataView(h.buffer).getUint32(0) % 1_000_000;
  return n.toString().padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
}
