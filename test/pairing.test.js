import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PairingSession, parseCode } from '../src/engine/pairing.js';
import { newNostrKey } from '../src/engine/nostr.js';
import { FakePool, identity, until } from './helpers.js';

function session(pool, id) {
  const s = new PairingSession({ identity: id, name: id.name, pool, nostrKey: newNostrKey(), sid: id.deviceId });
  pool.listeners.add((ev) => s.handle(ev));
  return s;
}

test('two devices pair and agree on SAS and peer identity', async () => {
  const pool = new FakePool();
  const [ida, idb] = await Promise.all([identity('Laptop'), identity('Desktop')]);
  const a = session(pool, ida);
  const b = session(pool, idb);
  await a.start();
  await b.join(a.view().code);
  await until(() => a.state === 'verify' && b.state === 'verify');
  assert.equal(a.sas, b.sas);
  assert.match(a.sas, /^\d{3} \d{3}$/);
  const ra = a.record();
  const rb = b.record();
  assert.equal(ra.deviceId, idb.deviceId);
  assert.equal(rb.deviceId, ida.deviceId);
  assert.equal(ra.name, 'Desktop');
  // Relays only ever saw ciphertext.
  for (const ev of pool.published) assert.ok(!ev.content.includes('Laptop') && !ev.content.includes('Desktop'));
});

test('wrong code never reaches verify; third party cannot join used code', async () => {
  const pool = new FakePool();
  const [ida, idb, idc] = await Promise.all([identity('A'), identity('B'), identity('C')]);
  const a = session(pool, ida);
  await a.start();
  const wrong = session(pool, idc);
  await wrong.join('WS1-' + 'A'.repeat(43));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.state, 'waiting');
  const b = session(pool, idb);
  await b.join(a.view().code);
  await until(() => a.state === 'verify');
  const c = session(pool, idc);
  await c.join(a.view().code);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.peer.deviceId, idb.deviceId);
  assert.equal(c.state, 'waiting');
  [a, b, c, wrong].forEach((s) => s.cancel());
});

test('parseCode rejects garbage', () => {
  assert.throws(() => parseCode('hello'));
  assert.throws(() => parseCode('WS1-abc'));
});
