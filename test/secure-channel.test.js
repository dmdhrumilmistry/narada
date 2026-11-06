import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hkdfKey, rand } from '../src/engine/crypto.js';
import { SecureChannel } from '../src/engine/secure-channel.js';
import { identity, until } from './helpers.js';

async function setup({ tamper, peerKeyOverride } = {}) {
  const [ia, ib] = await Promise.all([identity('a'), identity('b')]);
  const pairKey = await hkdfKey(rand(32));
  const got = { a: [], b: [] };
  const closed = {};
  const wire = { a: [], b: [] }; // frames sent by a / b
  let A, B;
  const deliver = (to, d) => setTimeout(() => to.receive(tamper ? tamper(d) : d), 0);
  A = new SecureChannel({
    identity: ia, pair: { deviceId: ib.deviceId, pub: peerKeyOverride ?? ib.pub, pairKey }, role: 'offerer',
    localFp: 'sha-256 AA', remoteFp: 'sha-256 BB',
    send: (d) => { wire.a.push(d); deliver(B, d); },
    onMessage: (m) => got.a.push(m), onClose: (r) => { closed.a = r; },
  });
  B = new SecureChannel({
    identity: ib, pair: { deviceId: ia.deviceId, pub: ia.pub, pairKey }, role: 'answerer',
    localFp: 'sha-256 BB', remoteFp: 'sha-256 AA',
    send: (d) => { wire.b.push(d); deliver(A, d); },
    onMessage: (m) => got.b.push(m), onClose: (r) => { closed.b = r; },
  });
  await Promise.all([A.start(), B.start()]);
  return { A, B, got, closed, wire };
}

test('handshake authenticates and messages round-trip (including chunked)', async () => {
  const { A, B, got } = await setup();
  await until(() => A.ready && B.ready);
  await A.sendMessage({ type: 'hi', n: 1 });
  const big = 'x'.repeat(200_000);
  await B.sendMessage({ type: 'big', big });
  await until(() => got.b.length === 1 && got.a.length === 1);
  assert.deepEqual(got.b[0], { type: 'hi', n: 1 });
  assert.equal(got.a[0].big.length, 200_000);
});

test('replayed frame closes the channel', async () => {
  const { A, B, closed, wire } = await setup();
  await until(() => A.ready && B.ready);
  await A.sendMessage({ type: 'one' });
  const frame = wire.a.at(-1);
  await B.receive(frame);
  await until(() => closed.b);
  assert.match(closed.b, /replay|out-of-order/);
});

test('tampered ciphertext closes the channel', async () => {
  const { A, B, closed, wire } = await setup();
  await until(() => A.ready && B.ready);
  await A.sendMessage({ type: 'one' });
  await new Promise((r) => setTimeout(r, 10));
  const t = new Uint8Array(wire.a.at(-1));
  t[4 + 7] += 1; // next expected seq...
  t[t.length - 1] ^= 1; // ...but tag is corrupted
  await B.receive(t);
  await until(() => closed.b);
});

test('wrong pinned identity key fails authentication', async () => {
  const other = await identity('mallory');
  const { closed } = await setup({ peerKeyOverride: other.pub });
  await until(() => closed.a);
  assert.match(closed.a, /authentication failed/);
});

test('plaintext before auth completes is rejected', async () => {
  const { closed, B } = await setup();
  await B.receive(new Uint8Array(64));
  await until(() => closed.b);
});

test('peer auth1 arriving while our own start() is still running is handled', async () => {
  const [ia, ib] = await Promise.all([identity('a'), identity('b')]);
  const pairKey = await hkdfKey(rand(32));
  let A, B;
  const fromB = [];
  B = new SecureChannel({
    identity: ib, pair: { deviceId: ia.deviceId, pub: ia.pub, pairKey }, role: 'answerer', localFp: 'B', remoteFp: 'A',
    send: (d) => { fromB.push(d); if (A?.eph) setTimeout(() => A.receive(d), 0); },
  });
  A = new SecureChannel({
    identity: ia, pair: { deviceId: ib.deviceId, pub: ib.pub, pairKey }, role: 'offerer', localFp: 'A', remoteFp: 'B',
    send: (d) => setTimeout(() => B.receive(d), 0),
  });
  await B.start();
  // Same order as PeerLink: start() is called, then a message lands before it resolves.
  const started = A.start();
  A.receive(fromB[0]);
  await started;
  await until(() => A.ready && B.ready);
  assert.equal(A.closed, false);
});
