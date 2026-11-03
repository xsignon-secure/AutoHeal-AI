import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REDACTED, makeRedactor, redactDeep } from '../dist/index.js';

test('redact: known credential shapes, labelled secrets and runner secret values', () => {
  const r = makeRedactor({ MY_API_KEY: 'supersecretvalue123', DATABASE_URL: 'postgres://u:p@db/x', PATH: '/usr/bin', RETRIES: '12345678' });
  const cases = [
    'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    'aws AKIAABCDEFGHIJKLMNOP',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    'shown on page: supersecretvalue123',
  ];
  for (const c of cases) {
    const out = r(c);
    assert.ok(out.includes(REDACTED), c);
    assert.ok(!/abcdefghijklmnopqrstuvwxyz0123|AKIAABCDEFGHIJKLMNOP|supersecretvalue123|MIIEow/.test(out), out);
  }
  assert.equal(r('{"password": "hunter2hunter"}'), `{"password": "${REDACTED}"}`);
  assert.equal(r('https://app:pa55word@db.example/x'), `https://app:${REDACTED}@db.example/x`);
  // Ordinary test output is left alone.
  for (const keep of ['Expected: "$10"\nReceived: "$12"', "waiting for getByRole('button', { name: 'Sign in' })", 'retries: 12345678 PATH /usr/bin']) {
    assert.equal(r(keep), keep);
  }
});

test('redactDeep scrubs every string in a summary', () => {
  const r = makeRedactor({});
  const out = redactDeep({ a: ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'], b: { c: 1, d: 'ok' } }, r);
  assert.deepEqual(out, { a: [`token ${REDACTED}`], b: { c: 1, d: 'ok' } });
});
