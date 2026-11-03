import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eventsFrom, sign, uploadEvents, verifySignature } from '../dist/index.js';
import { startDashboard } from '../dist/server/app.js';
import { escapeHtml } from '../dist/server/page.js';
import { Store } from '../dist/server/store.js';
import { validateBatch } from '../dist/server/validate.js';

const SECRET = 'a-very-long-dashboard-secret-0123456789';

const event = (over = {}) => ({
  id: 'abcdef0123456789',
  repo: 'acme/shop',
  test_title: 'login › works',
  file_path: 'tests/login.spec.ts',
  status: 'FIXED',
  category: 'TEST_BUG',
  root_cause: 'LOCATOR_DRIFT',
  confidence: 0.9,
  tokens: 1200,
  usd: 0.01,
  minutes_saved: 45,
  created_at: '2026-11-03T10:00:00.000Z',
  pr_url: 'https://github.com/acme/shop/pull/1',
  ...over,
});

async function withServer(fn, opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-dash-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const server = await startDashboard({ store, secret: SECRET, port: 0, host: '127.0.0.1', ...opts });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(url, store);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
}

test('signatures: valid, stale, mismatched and missing', () => {
  const now = 1_800_000_000;
  const body = '{"a":1}';
  assert.equal(verifySignature(SECRET, body, sign(SECRET, now, body), String(now), now), null);
  assert.equal(verifySignature(SECRET, body, sign(SECRET, now - 1000, body), String(now - 1000), now), 'stale');
  assert.equal(verifySignature(SECRET, body + ' ', sign(SECRET, now, body), String(now), now), 'mismatch');
  assert.equal(verifySignature(SECRET, body, undefined, String(now), now), 'missing');
});

test('validation rejects unknown fields, code-like payloads and bad links', () => {
  assert.equal(validateBatch({ version: 1, events: [event()] }).length, 1);
  assert.throws(() => validateBatch({ version: 1, events: [event({ diff: '-a\n+b' })] }), /not an accepted field/);
  assert.throws(() => validateBatch({ version: 1, events: [event({ pr_url: 'javascript:alert(1)' })] }), /http/);
  assert.throws(() => validateBatch({ version: 1, events: [event({ status: 'DONE' })] }), /status must be one of/);
  assert.throws(() => validateBatch({ version: 1, events: [event({ repo: '../../etc' })] }), /owner\/name/);
  assert.throws(() => validateBatch({ version: 2, events: [] }), /version/);
  assert.throws(() => validateBatch({ version: 1, events: Array.from({ length: 201 }, () => event()) }), /at most/);
});

test("dashboard refuses a short secret", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-dash-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  await assert.rejects(startDashboard({ store, secret: 'short', port: 0, host: '127.0.0.1' }));
  store.close();
});

test('upload → stats → events → page, with idempotent re-uploads', async () => {
  await withServer(async (url) => {
    const ok = await uploadEvents(url, SECRET, [event(), event({ id: 'bbbbbbbbbbbbbbbb', status: 'APP_BUG', category: 'APP_BUG', root_cause: 'REGRESSION', pr_url: undefined, test_title: '<script>alert(1)</script>' })]);
    assert.equal(ok.status, 200);
    const again = await uploadEvents(url, SECRET, [event({ status: 'FIXED' })]);
    assert.equal(again.status, 200);
    const stats = (await (await fetch(`${url}/api/stats`)).json()).stats;
    assert.equal(stats.events, 2);
    assert.equal(stats.fixed, 1);
    assert.equal(stats.fixPrs, 1);
    assert.equal(stats.appBugs, 1);
    assert.equal(stats.minutesSaved, 90);
    const events = (await (await fetch(`${url}/api/events?status=APP_BUG`)).json()).events;
    assert.equal(events.length, 1);
    const page = await (await fetch(`${url}/?repo=acme/shop`)).text();
    assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!page.includes('<script>alert(1)'));
    const res = await fetch(url);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  });
});

test('wrong signature, oversize body and other repos are refused', async () => {
  await withServer(
    async (url) => {
      assert.equal((await uploadEvents(url, 'another-secret-that-is-long-enough-123', [event()])).status, 401);
      const big = await fetch(`${url}/api/heal`, { method: 'POST', body: 'x'.repeat(300 * 1024) });
      assert.ok([401, 413].includes(big.status));
      assert.equal((await uploadEvents(url, SECRET, [event({ repo: 'evil/repo' })])).status, 403);
      assert.equal((await uploadEvents(url, SECRET, [event()])).status, 200);
    },
    { repos: ['acme/shop'] },
  );
});

test('view token: required for reading, then kept in a cookie', async () => {
  await withServer(
    async (url) => {
      assert.equal((await fetch(`${url}/api/stats`)).status, 401);
      assert.equal((await fetch(`${url}/healthz`)).status, 200);
      const redirect = await fetch(`${url}/?token=view-123&repo=acme/shop`, { redirect: 'manual' });
      assert.equal(redirect.status, 303);
      assert.equal(redirect.headers.get('location'), '/?repo=acme%2Fshop');
      const cookie = redirect.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly/);
      assert.equal((await fetch(`${url}/api/stats`, { headers: { cookie: cookie.split(';')[0] } })).status, 200);
      assert.equal((await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer view-123' } })).status, 200);
      assert.equal((await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    },
    { viewToken: 'view-123' },
  );
});

test('eventsFrom sends labels and links only', () => {
  const summary = {
    startedAt: '2026-11-03T00:00:00Z', finishedAt: '2026-11-03T00:05:00Z', run: { id: '42', repo: 'acme/shop', commit: 'abcdef1', url: 'https://github.com/acme/shop/actions/runs/42' },
    results: [{ failure: { file: 'a.spec.ts', title: 'a', message: 'SECRET STACK' }, category: 'TEST_BUG', rootCause: 'LOCATOR_DRIFT', confidence: 0.9, status: 'FIXED', fix: { by: 'ai', diff: 'SECRET DIFF' }, spend: { inputTokens: 10, outputTokens: 5, usd: 0.001 } }],
  };
  const [e] = eventsFrom(summary, { prUrl: 'https://github.com/acme/shop/pull/9' });
  assert.equal(e.pr_url, 'https://github.com/acme/shop/pull/9');
  assert.equal(e.tokens, 15);
  assert.ok(!JSON.stringify(e).includes('SECRET'));
  assert.equal(validateBatch({ version: 1, events: [e] }).length, 1);
});

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('repeated failed sign-ins and bad signatures are locked out for a while', async () => {
  await withServer(
    async (url) => {
      for (let i = 0; i < 20; i++) assert.equal((await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
      assert.equal((await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer view-token-1234567890' } })).status, 429, 'even the right token waits');
      assert.equal((await fetch(`${url}/healthz`)).status, 200);
    },
    { viewToken: 'view-token-1234567890' },
  );
});

test('cli: the dashboard refuses to start without a view token unless made public on purpose', () => {
  const cli = path.join(import.meta.dirname, '..', 'dist', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'dashboard', '--port', '18765', '--db', path.join(mkdtempSync(path.join(os.tmpdir(), 'autoheal-cli-')), 'x.db')], { encoding: 'utf8', env: { ...process.env, AUTOHEAL_DASHBOARD_SECRET: SECRET, AUTOHEAL_DASHBOARD_VIEW_TOKEN: '', AUTOHEAL_DASHBOARD_PUBLIC: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /AUTOHEAL_DASHBOARD_VIEW_TOKEN/);
  const short = spawnSync(process.execPath, [cli, 'dashboard', '--port', '18765', '--db', path.join(mkdtempSync(path.join(os.tmpdir(), 'autoheal-cli-')), 'x.db')], { encoding: 'utf8', env: { ...process.env, AUTOHEAL_DASHBOARD_SECRET: SECRET, AUTOHEAL_DASHBOARD_VIEW_TOKEN: 'short' } });
  assert.equal(short.status, 2);
});

test('the store keeps at most maxEvents rows, dropping the oldest', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-dash-'));
  const store = new Store(path.join(dir, 'db.sqlite'), 3);
  for (let i = 0; i < 5; i++) store.upsert([event({ id: `event-${String(i).padStart(4, '0')}` })]);
  assert.equal(store.stats().events, 3);
  store.close();
});
