import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/engine/crypto.js';
import { newNostrKey, signEvent, verifyEvent } from '../src/engine/nostr.js';

test('base64url round trip and strictness', () => {
  const b = c.rand(100);
  assert.deepEqual(c.unb64u(c.b64u(b)), b);
  assert.throws(() => c.unb64u('abc+/='));
});

test('AES-GCM seal/open, tamper and wrong AAD fail', async () => {
  const k = await c.hkdfAesKey(await c.hkdfKey(c.rand(32)), 'salt', 'info');
  const sealed = await c.aesSeal(k, c.enc('hello'), c.enc('aad'));
  assert.equal(c.dec(await c.aesOpen(k, sealed, c.enc('aad'))), 'hello');
  await assert.rejects(c.aesOpen(k, sealed, c.enc('other')));
  sealed[20] ^= 1;
  await assert.rejects(c.aesOpen(k, sealed, c.enc('aad')));
});

test('identity sign/verify, non-extractable private key', async () => {
  const id = await c.generateIdentity();
  assert.equal(id.privateKey.extractable, false);
  const sig = await c.sign(id.privateKey, c.enc('msg'));
  assert.ok(await c.verify(id.pub, sig, c.enc('msg')));
  assert.ok(!(await c.verify(id.pub, sig, c.enc('msg2'))));
  assert.equal(id.deviceId.length, 32);
});

test('HKDF determinism', async () => {
  const s = c.rand(32);
  const a = await c.hkdfBits(await c.hkdfKey(s), 'x', 'y');
  const b = await c.hkdfBits(await c.hkdfKey(s), 'x', 'y');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, await c.hkdfBits(await c.hkdfKey(s), 'x', 'z'));
});

test('nostr events sign and verify; tampering detected', async () => {
  const k = newNostrKey();
  const ev = await signEvent({ kind: 25133, tags: [['p', 'ab'.repeat(32)]], content: 'x' }, k);
  assert.ok(await verifyEvent(ev));
  assert.ok(!(await verifyEvent({ ...ev, content: 'y' })));
});
