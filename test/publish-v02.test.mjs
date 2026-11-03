// 0.2.0 hardening: publish-job patch checks, budget shares, fail-closed
// pricing, importer reruns and dashboard lockout/cookie handling.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Budget, priceFor } from '../dist/index.js';
import { findImporters } from '../dist/heal.js';
import { startDashboard, viewCookieValue } from '../dist/server/app.js';
import { Store } from '../dist/server/store.js';
import { Refused, checkFiles, parsePatch, safePath } from '../scripts/publish.mjs';

const edit = (p) => `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`;
const added = (p) => `diff --git a/${p} b/${p}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+{}\n`;

test('publish: safe paths only', () => {
  for (const ok of ['tests/a.spec.ts', 'e2e/pages/login.py', '.autoheal/memory/0123456789abcdef.json']) assert.ok(safePath(ok), ok);
  for (const bad of ['../x.ts', '/etc/x', 'a/../b.ts', '.git/config', 'sub/.git/hooks/x', '.github/workflows/x.yml', 'node_modules/x.js', 'a\\b.ts', '-rf.ts', 'a//b.ts', 'x\n.ts']) assert.ok(!safePath(bad), bad);
});

test('publish: the patch parser accepts plain edits and memory files only', () => {
  const files = parsePatch(edit('tests/a.spec.ts') + added('.autoheal/memory/0123456789abcdef.json'));
  assert.deepEqual(files, [{ path: 'tests/a.spec.ts', isNew: false }, { path: '.autoheal/memory/0123456789abcdef.json', isNew: true }]);
  const refused = {
    rename: 'diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n',
    mode: 'diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n',
    symlink: 'diff --git a/l.ts b/l.ts\nnew file mode 120000\nindex 0000000..1\n--- /dev/null\n+++ b/l.ts\n@@ -0,0 +1 @@\n+/etc/passwd\n',
    delete: 'diff --git a/a.ts b/a.ts\ndeleted file mode 100644\nindex 1..0\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n',
    binary: 'diff --git a/a.ts b/a.ts\nindex 1..2 100644\nGIT binary patch\nliteral 1\n',
    quoted: 'diff --git "a/x\\ty.ts" "b/x\\ty.ts"\n',
    twice: edit('a.ts') + edit('a.ts'),
    garbage: 'hello\n',
  };
  for (const [name, patch] of Object.entries(refused)) assert.throws(() => parsePatch(patch), Refused, name);
});

test('publish: files are checked against the checkout', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'autoheal-pub-'));
  mkdirSync(path.join(root, 'tests'));
  writeFileSync(path.join(root, 'tests', 'a.spec.ts'), 'a\n');
  writeFileSync(path.join(root, 'playwright.config.ts'), 'a\n');
  writeFileSync(path.join(root, 'README.md'), 'a\n');
  mkdirSync(path.join(root, 'outside'));
  symlinkSync(path.join(root, 'outside'), path.join(root, 'linked'));
  writeFileSync(path.join(root, 'outside', 'b.spec.ts'), 'a\n');
  symlinkSync(path.join(root, 'tests', 'a.spec.ts'), path.join(root, 'tests', 'link.spec.ts'));

  assert.doesNotThrow(() => checkFiles(root, [{ path: 'tests/a.spec.ts', isNew: false }, { path: '.autoheal/memory/0123456789abcdef.json', isNew: true }], null));
  const bad = [
    [{ path: 'playwright.config.ts', isNew: false }, /config file/],
    [{ path: 'README.md', isNew: false }, /only source files/],
    [{ path: 'tests/new.spec.ts', isNew: true }, /new file not allowed/],
    [{ path: 'tests/missing.spec.ts', isNew: false }, /does not exist/],
    [{ path: 'linked/b.spec.ts', isNew: false }, /symlink/],
    [{ path: 'tests/link.spec.ts', isNew: false }, /not a regular file/],
  ];
  for (const [file, why] of bad) assert.throws(() => checkFiles(root, [file], null), why, file.path);
  assert.throws(() => checkFiles(root, [{ path: 'tests/a.spec.ts', isNew: false }], ['tests/other.spec.ts']), /not in the list/);
});

test('budget: each failure gets a share of what is left, unspent money rolls over', () => {
  const b = new Budget({ maxSteps: 100, maxTokens: 10_000_000, maxUsd: 0.9 }, [4, 20]);
  b.share(3); // $0.30 for the first failure
  assert.equal(b.wouldExceed(10_000, 8_000), null); // $0.04 + $0.16 = $0.20
  b.record({ inputTokens: 10_000, outputTokens: 8_000 });
  assert.match(b.wouldExceed(10_000, 8_000), /share for this failure/); // would reach $0.40
  b.share(2); // ($0.90 - $0.20) / 2 = $0.35 more
  assert.equal(b.wouldExceed(10_000, 8_000), null);
  b.share(1);
  assert.equal(b.wouldExceed(30_000, 8_000), null); // everything left: $0.70
});

test('pricing: negative custom prices are ignored, 0 is allowed', () => {
  assert.deepEqual(priceFor('local', { AUTOHEAL_PRICE_IN: '0', AUTOHEAL_PRICE_OUT: '0' }), [0, 0]);
  assert.equal(priceFor('local', { AUTOHEAL_PRICE_IN: '-1', AUTOHEAL_PRICE_OUT: '0' }), null);
});

test('cli: an unpriced model fails closed', () => {
  const cli = path.join(import.meta.dirname, '..', 'dist', 'cli.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-price-'));
  writeFileSync(path.join(dir, 'r.json'), '{}');
  const env = { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', AUTOHEAL_BASE_URL: 'http://127.0.0.1:9/v1', AUTOHEAL_MODEL: 'my-local-model', AUTOHEAL_PRICE_IN: '', AUTOHEAL_PRICE_OUT: '' };
  const r = spawnSync(process.execPath, [cli, 'heal', '--report', 'r.json', '--out', path.join(dir, 'out')], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /AUTOHEAL_PRICE_IN/);
});

test('findImporters: specs that import a page object, in JS and Python', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'autoheal-imp-'));
  for (const d of ['tests', 'pages', 'py/tests', 'py/pages', 'node_modules/x']) mkdirSync(path.join(root, d), { recursive: true });
  writeFileSync(path.join(root, 'pages', 'login.ts'), 'export class Login {}');
  writeFileSync(path.join(root, 'tests', 'a.spec.ts'), "import { Login } from '../pages/login';");
  writeFileSync(path.join(root, 'tests', 'b.spec.ts'), "import { Login } from '../pages/login.js';");
  writeFileSync(path.join(root, 'tests', 'c.spec.ts'), "import { x } from '../pages/other';");
  writeFileSync(path.join(root, 'node_modules', 'x', 'd.spec.ts'), "import { Login } from '../../pages/login';");
  assert.deepEqual(await findImporters(root, 'pages/login.ts'), ['tests/a.spec.ts', 'tests/b.spec.ts']);
  writeFileSync(path.join(root, 'py', 'pages', 'login.py'), 'class Login: pass');
  writeFileSync(path.join(root, 'py', 'tests', 'test_login.py'), 'from py.pages.login import Login');
  writeFileSync(path.join(root, 'py', 'tests', 'test_other.py'), 'from py.pages.loginx import Login');
  assert.deepEqual(await findImporters(root, 'py/pages/login.py'), ['py/tests/test_login.py']);
});

async function withServer(fn, opts) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-dash-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const server = await startDashboard({ store, secret: 'a-very-long-dashboard-secret-0123456789', port: 0, host: '127.0.0.1', ...opts });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
}

test('dashboard: the cookie holds an HMAC, not the view token', async () => {
  const token = 'view-token-1234567890';
  await withServer(
    async (url) => {
      const res = await fetch(`${url}/?token=${token}`, { redirect: 'manual' });
      const cookie = res.headers.get('set-cookie');
      assert.ok(!cookie.includes(token));
      assert.ok(cookie.startsWith(`autoheal_view=${viewCookieValue(token)};`));
      assert.equal((await fetch(`${url}/api/stats`, { headers: { cookie: `autoheal_view=${token}` } })).status, 401, 'the raw token is not a valid cookie');
    },
    { viewToken: token },
  );
});

test('dashboard: behind a proxy, a spoofed X-Forwarded-For does not dodge the lockout', async () => {
  await withServer(
    async (url) => {
      // The client rotates the first entry; the proxy-added last entry stays the same.
      for (let i = 0; i < 20; i++) await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer wrong', 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` } });
      const res = await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer view-token-1234567890', 'x-forwarded-for': '10.9.9.9, 203.0.113.7' } });
      assert.equal(res.status, 429);
      const other = await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer view-token-1234567890', 'x-forwarded-for': '203.0.113.8' } });
      assert.equal(other.status, 200);
    },
    { viewToken: 'view-token-1234567890', trustProxy: true },
  );
});

test('dashboard: a flood of new clients does not lift an active lockout', async () => {
  await withServer(
    async (url) => {
      for (let i = 0; i < 20; i++) await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer wrong', 'x-forwarded-for': '198.51.100.1' } });
      // 10,050 other clients fail once each (in parallel batches).
      for (let batch = 0; batch < 201; batch++) {
        await Promise.all(Array.from({ length: 50 }, (_, j) => fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer wrong', 'x-forwarded-for': `10.${batch}.${j}.1` } })));
      }
      const res = await fetch(`${url}/api/stats`, { headers: { authorization: 'Bearer view-token-1234567890', 'x-forwarded-for': '198.51.100.1' } });
      assert.equal(res.status, 429);
    },
    { viewToken: 'view-token-1234567890', trustProxy: true },
  );
});
