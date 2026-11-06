import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOtlpPayload, cleanAttributes, Telemetry } from '../src/engine/telemetry.js';

const quiet = () => { const o = { log: console.log, warn: console.warn, error: console.error }; console.log = console.warn = console.error = () => {}; return () => Object.assign(console, o); };

test('only allow-listed primitive attributes survive; URLs are scrubbed', () => {
  const out = cleanAttributes({
    tabs: 3, with_cookies: true, reason: 'failed at https://bank.example/login?session=abc',
    url: 'https://secret.example', title: 'My bank', text: 'password: hunter2', nested: { a: 1 }, 'peer.id': 'abcd1234',
  });
  const keys = out.map((a) => a.key).sort();
  assert.deepEqual(keys, ['peer.id', 'reason', 'tabs', 'with_cookies']);
  assert.equal(out.find((a) => a.key === 'reason').value.stringValue, 'failed at [url]');
  assert.equal(out.find((a) => a.key === 'tabs').value.intValue, '3');
});

test('OTLP/HTTP JSON payload shape', () => {
  const p = buildOtlpPayload([{ time: 1700000000000, level: 'warn', event: 'peer.closed', attrs: { reason: 'timeout' } }], { 'service.name': 'narada-extension' }, '0.3.0');
  const rec = p.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(p.resourceLogs[0].resource.attributes[0].key, 'service.name');
  assert.equal(p.resourceLogs[0].scopeLogs[0].scope.name, 'narada');
  assert.equal(rec.timeUnixNano, '1700000000000000000');
  assert.equal(rec.severityNumber, 13);
  assert.equal(rec.severityText, 'WARN');
  assert.equal(rec.body.stringValue, 'peer.closed');
  assert.ok(rec.attributes.some((a) => a.key === 'event.name'));
});

test('exports batches with headers, respects level, disabled = nothing sent', async () => {
  const restore = quiet();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  const t = new Telemetry({ version: '1.2.3', browser: 'Chrome', fetchImpl, flushMs: 10_000 });
  t.info('engine.start', { pairs: 1 });
  assert.equal(await t.flush(), false); // disabled by default
  t.configure({ enabled: true, endpoint: 'https://otel.example/v1/logs', logLevel: 'warn', headers: { Authorization: 'Bearer t' }, resourceAttributes: { 'deployment.environment': 'test' } }, { deviceId: 'deadbeefcafe0000' });
  t.info('too.chatty', {});
  t.warn('peer.closed', { reason: 'timeout' });
  t.error('policy.blocked', { policy: 'allowNotes' });
  assert.equal(await t.flush(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://otel.example/v1/logs');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
  assert.equal(calls[0].init.credentials, 'omit');
  const body = JSON.parse(calls[0].init.body);
  const events = body.resourceLogs[0].scopeLogs[0].logRecords.map((r) => r.body.stringValue);
  assert.deepEqual(events, ['peer.closed', 'policy.blocked']);
  const res = Object.fromEntries(body.resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(res['service.version'], '1.2.3');
  assert.equal(res['deployment.environment'], 'test');
  assert.equal(res['service.instance.id'], 'deadbeefcafe');
  restore();
});

test('failed exports retry a bounded number of times, then drop', async () => {
  const restore = quiet();
  let n = 0;
  const t = new Telemetry({ fetchImpl: async () => { n++; return { ok: false, status: 503 }; }, flushMs: 10_000 });
  t.configure({ enabled: true, endpoint: 'https://otel.example/v1/logs', logLevel: 'info' });
  t.info('engine.start', {});
  for (let i = 0; i < 5; i++) await t.flush();
  clearTimeout(t.timer);
  assert.equal(n, 4); // first try + 3 retries
  assert.equal(t.queue.length, 0);
  restore();
});
