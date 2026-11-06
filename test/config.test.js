import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, effective, safeOtlpEndpoint, safeStunUrl, sanitize } from '../src/shared/config.js';

test('defaults match the current behaviour', () => {
  const { values, locked } = effective();
  assert.equal(values.allowCookieTransfer, true);
  assert.equal(values.telemetry.enabled, false);
  assert.ok(values.stunServers[0].startsWith('stun:stun.l.google.com'));
  assert.equal(locked.size, 0);
});

test('managed values win over user values and are locked', () => {
  const { values, locked } = effective(
    { allowNotes: true, keepHistory: true, telemetry: { logLevel: 'debug' } },
    { allowNotes: false, telemetry: { enabled: true, endpoint: 'https://otel.corp.example' } },
  );
  assert.equal(values.allowNotes, false);
  assert.equal(values.keepHistory, true);
  assert.ok(locked.has('allowNotes') && !locked.has('keepHistory'));
  assert.equal(values.telemetry.endpoint, 'https://otel.corp.example/v1/logs');
  assert.equal(values.telemetry.logLevel, 'debug'); // user's choice where policy is silent
  assert.ok(locked.has('telemetry.endpoint') && !locked.has('telemetry.logLevel'));
});

test('invalid values are dropped, not half-applied', () => {
  const { values, errors } = sanitize({ allowNotes: 'no', relays: ['ws://insecure'], stunServers: ['turn:relay.example'], telemetry: { logLevel: 'loud' } });
  assert.deepEqual(Object.keys(values), ['telemetry']);
  assert.deepEqual(errors.sort(), ['allowNotes', 'relays', 'stunServers', 'telemetry.logLevel']);
});

test('STUN only (no TURN), OTLP endpoint must be https or localhost', () => {
  assert.equal(safeStunUrl('stun:stun.example.com:3478'), 'stun:stun.example.com:3478');
  assert.equal(safeStunUrl('stuns:stun.example.com'), 'stuns:stun.example.com');
  assert.equal(safeStunUrl('turn:relay.example.com'), null);
  assert.equal(safeOtlpEndpoint('https://collector.example.com/'), 'https://collector.example.com/v1/logs');
  assert.equal(safeOtlpEndpoint('https://collector.example.com/v1/logs'), 'https://collector.example.com/v1/logs');
  assert.equal(safeOtlpEndpoint('http://localhost:4318'), 'http://localhost:4318/v1/logs');
  assert.equal(safeOtlpEndpoint('http://collector.example.com'), null);
  assert.equal(safeOtlpEndpoint('https://u:p@collector.example.com'), null);
  assert.equal(safeOtlpEndpoint('javascript:alert(1)'), null);
});

test('telemetry headers: valid names only, no hop-by-hop or cookie headers', () => {
  assert.deepEqual(sanitize({ telemetry: { headers: { Authorization: 'Bearer x' } } }).values.telemetry.headers, { Authorization: 'Bearer x' });
  assert.deepEqual(sanitize({ telemetry: { headers: { Cookie: 'a=b' } } }).errors, ['telemetry.headers']);
  assert.deepEqual(sanitize({ telemetry: { headers: { 'bad header': 'x' } } }).errors, ['telemetry.headers']);
});

test('telemetry without an endpoint stays off', () => {
  assert.equal(effective({ telemetry: { enabled: true } }).values.telemetry.enabled, false);
  assert.equal(DEFAULTS.telemetry.enabled, false);
});
