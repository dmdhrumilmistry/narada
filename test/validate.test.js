import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeHttpUrl, safeRelayUrl, validateCookie, validateTab, validateTransfer } from '../src/shared/validate.js';

const future = Date.now() / 1000 + 3600;

test('only http(s) URLs', () => {
  assert.ok(safeHttpUrl('https://example.com/a'));
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'chrome://settings', 'https://u:p@x.com']) {
    assert.equal(safeHttpUrl(u), null, u);
  }
});

test('relays must be wss', () => {
  assert.equal(safeRelayUrl('wss://nos.lol/'), 'wss://nos.lol');
  assert.equal(safeRelayUrl('ws://nos.lol'), null);
});

test('cookies must domain-match the tab host', () => {
  const ok = { name: 'sid', value: 'v', domain: '.example.com', path: '/', session: false, expirationDate: future };
  assert.ok(validateCookie(ok, 'app.example.com'));
  assert.equal(validateCookie({ ...ok, domain: '.evil.com' }, 'app.example.com'), null);
  assert.equal(validateCookie({ ...ok, domain: 'ample.com' }, 'example.com'), null);
  assert.equal(validateCookie({ ...ok, expirationDate: 1 }, 'example.com'), null);
  assert.equal(validateCookie({ ...ok, name: '__Host-x', hostOnly: false, secure: true }, 'example.com'), null);
});

test('storage origin must match tab origin', () => {
  const base = { url: 'https://a.com/x', title: 't' };
  assert.ok(validateTab({ ...base, storage: { origin: 'https://a.com', local: { k: 'v' }, session: {} } }));
  assert.equal(validateTab({ ...base, storage: { origin: 'https://b.com', local: {}, session: {} } }), null);
});

test('transfer limits', () => {
  assert.equal(validateTransfer({ id: 'x', tabs: [] }), null);
  assert.equal(validateTransfer({ id: 'x', tabs: Array(51).fill({ url: 'https://a.com' }) }), null);
  assert.equal(validateTransfer({ id: 'x', tabs: [{ url: 'javascript:1' }] }), null);
  assert.ok(validateTransfer({ id: 'x', tabs: [{ url: 'https://a.com' }] }));
});
