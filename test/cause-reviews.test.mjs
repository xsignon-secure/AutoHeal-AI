// 0.7.0: find the cause (the app commit behind a failure) and learn from reviews of earlier AutoHeal PRs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { causeText, findCause, fixesMarker, literals, prBody, readMarker, rejected, reviewHistory, reviewText, termsFromLocators, termsFromValues } from '../dist/index.js';

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ah-cause-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  const commit = (msg) => {
    git('add', '-A');
    git('-c', 'user.email=a@example.com', '-c', 'user.name=Ada', 'commit', '-qm', msg);
  };
  git('init', '-q');
  mkdirSync(path.join(dir, 'app'));
  mkdirSync(path.join(dir, 'tests'));
  writeFileSync(path.join(dir, 'app/login.html'), '<button>Log in</button>\n<p data-testid="price">$10</p>\n');
  writeFileSync(path.join(dir, 'tests/login.spec.ts'), "page.getByRole('button', { name: 'Log in' })\n");
  commit('first');
  writeFileSync(path.join(dir, 'app/other.html'), '<p>unrelated</p>\n');
  commit('unrelated change');
  writeFileSync(path.join(dir, 'app/login.html'), '<button>Sign in</button>\n<p data-testid="price">$10</p>\n');
  commit('Rename the login button');
  // A test-only commit that mentions the new name must never count as the cause.
  writeFileSync(path.join(dir, 'tests/login.spec.ts'), "page.getByRole('button', { name: 'Sign in' })\n");
  commit('fix tests');
  writeFileSync(path.join(dir, 'app/login.html'), '<button>Sign in</button>\n<p data-testid="price">$12</p>\n');
  commit('Raise the price');
  return dir;
}

test('cause: terms come from the locator change, without role names or CSS punctuation', () => {
  assert.deepEqual(literals("locator('#greeting')"), ['greeting']);
  assert.deepEqual(literals('locator(\'[data-testid="cart"]\')'), ['cart']);
  assert.deepEqual(termsFromLocators([{ before: "getByRole('button', { name: 'Log in' })", after: "getByRole('button', { name: 'Sign in' })" }]), { removed: ['Log in'], added: ['Sign in'] });
  assert.deepEqual(termsFromValues('"$10"', '"$12"'), { removed: ['$10'], added: ['$12'] });
  assert.deepEqual(termsFromValues('"a"', '"b"'), { removed: [], added: [] }, 'too short to search');
});

test('cause: the app commit that renamed the element, never a test commit', async () => {
  const dir = repo();
  const c = await findCause(dir, { removed: ['Log in'], added: ['Sign in'] });
  assert.equal(c.subject, 'Rename the login button');
  assert.equal(c.author, 'Ada');
  assert.deepEqual(c.files, ['app/login.html']);
  assert.equal(c.evidence, '"Log in" → "Sign in" in `app/login.html`');
  const price = await findCause(dir, { removed: ['$10'], added: ['$12'] });
  assert.equal(price.subject, 'Raise the price');
  assert.equal(await findCause(dir, { removed: ['Nothing like this'], added: [] }), null);
  assert.match(causeText(c, 'https://github.com/acme/shop'), /^\[`[0-9a-f]{7}`\]\(https:\/\/github\.com\/acme\/shop\/commit\/[0-9a-f]{40}\) "Rename the login button" \(Ada, \d{4}-\d\d-\d\d\): /);
  // Search text with shell or git syntax is only ever a literal.
  assert.equal(await findCause(dir, { removed: ['$(touch pwned)', '--output=/tmp/x'], added: [] }), null);
});

test('reviews: the PR body carries the fixes in a hidden marker that survives a round trip', () => {
  const marker = fixesMarker([{ file: 'tests/a.spec.ts', test: 'a', by: 'fingerprint', before: 'x'.repeat(500), after: 'y' }]);
  assert.match(marker, /^<!-- autoheal-fixes:[A-Za-z0-9+/=]+ -->$/);
  const back = readMarker(`intro\n${marker}\nmore`);
  assert.equal(back[0].before.length, 300);
  assert.deepEqual(readMarker('<!-- autoheal-fixes:bm90IGpzb24= -->'), []);
  const body = prBody({ tool: 'autoheal-ai', version: '0.7.0', startedAt: '', finishedAt: '', mode: 'draft-pr', provider: 'none', model: 'none', outcome: 'fixed', changes: true, changedFiles: [], totalFailures: 1, skippedFailures: 0, minutesSaved: 0, spend: { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true }, reviews: { merged: 2, edited: 1, closed: 1 }, results: [{ failure: { index: 1, file: 'tests/a.spec.ts', title: 'a', kind: 'timeout', message: '' }, category: 'TEST_BUG', rootCause: 'LOCATOR_DRIFT', confidence: 0.9, reasons: [], status: 'FIXED', summary: '', spend: { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true }, fix: { by: 'ai', file: 'tests/a.spec.ts', explanation: 'x', diff: '', locators: [{ before: "locator('#a')", after: "getByText('A')", from: 'fair', to: 'good', direction: 1 }] }, cause: { commit: 'a'.repeat(40), short: 'aaaaaaa', subject: 'Rename A', files: ['app/a.html'], evidence: '"a" → "A"' } }] });
  assert.equal(readMarker(body)[0].before, "locator('#a')", 'AI fixes are marked by their locator change');
  assert.match(body, /Likely cause \| \[?`aaaaaaa`(?:\]\([^)]+\))? "Rename A"/, 'linked when GitHub env vars are set, plain otherwise');
  assert.match(body, /Learned from 4 earlier AutoHeal PRs: 2 merged as written, 1 edited by a reviewer, 1 closed/);
});

test('reviews: merged, edited and closed AutoHeal PRs are read; other PRs and forks are ignored', async () => {
  const fix = (file, before, after) => fixesMarker([{ file, test: `${file} › t`, by: 'rules', before, after }]);
  const own = { repo: { full_name: 'acme/shop' } };
  const pulls = [
    { number: 1, body: fix('tests/a.spec.ts', 'A1', 'A2'), merged_at: '2026-11-01T00:00:00Z', head: { ref: 'autoheal/1', ...own }, base: own },
    { number: 2, body: fix('tests/b.spec.ts', 'B1', 'B2'), merged_at: '2026-11-02T00:00:00Z', head: { ref: 'autoheal/2', ...own }, base: own },
    { number: 3, body: fix('tests/c.spec.ts', 'C1', 'C2'), merged_at: null, closed_at: '2026-11-03T00:00:00Z', head: { ref: 'autoheal/3', ...own }, base: own },
    { number: 4, body: fix('tests/d.spec.ts', 'D1', 'D2'), merged_at: null, head: { ref: 'feature', ...own }, base: own },
    { number: 5, body: fix('tests/e.spec.ts', 'E1', 'E2'), merged_at: null, head: { ref: 'autoheal/5', repo: { full_name: 'evil/shop' } }, base: own },
  ];
  const sha = (c) => c.repeat(40);
  const routes = {
    '/repos/acme/shop/pulls': pulls,
    '/repos/acme/shop/pulls/1/commits': [{ sha: sha('1'), commit: { message: 'test: AutoHeal fixes for failed run 9' } }],
    '/repos/acme/shop/pulls/2/commits': [{ sha: sha('2'), commit: { message: 'test: AutoHeal fixes for failed run 8' } }, { sha: sha('3'), commit: { message: 'use the test id instead' } }],
    [`/repos/acme/shop/compare/${sha('2')}...${sha('3')}`]: { files: [{ filename: 'tests/b.spec.ts', patch: "-B2\n+getByTestId('b')" }, { filename: 'app/x.ts', patch: 'secret app change' }] },
  };
  const seen = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    seen.push(init.headers.authorization);
    const body = routes[u.pathname];
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  const h = await reviewHistory({ repo: 'acme/shop', token: 't0k', apiUrl: 'https://api.example.test', fetchFn });
  assert.deepEqual(h.prs, { merged: 1, edited: 1, closed: 1 });
  assert.ok(seen.every((a) => a === 'Bearer t0k'));
  const edited = h.fixes.find((f) => f.pr === 2);
  assert.equal(edited.outcome, 'edited');
  assert.equal(edited.edit, "-B2\n+getByTestId('b')", 'only the edit to the fixed file');
  assert.ok(!h.fixes.some((f) => f.pr === 4 || f.pr === 5), 'non-AutoHeal and fork PRs ignored');
  assert.equal(rejected(h, 'tests/c.spec.ts', 'C1', 'C2')?.pr, 3);
  assert.equal(rejected(h, 'tests/a.spec.ts', 'A1', 'A2'), undefined, 'a merged fix is not rejected');
  const text = reviewText(h, 'tests/b.spec.ts');
  assert.match(text, /PR #2 was merged after a reviewer edited it/);
  assert.match(text, /getByTestId\('b'\)/);
  assert.match(text, /PR #3 was closed without merging/);
  await assert.rejects(reviewHistory({ repo: 'acme/shop', token: 't', fetchFn: async () => ({ ok: false, status: 403 }) }), /403/);
  await assert.rejects(reviewHistory({ repo: '../x', token: 't', fetchFn }), /bad repository/);
});
