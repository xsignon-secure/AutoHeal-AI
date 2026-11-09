import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkBaselines, main as publishMain, parsePatch, prBranchTarget, sourceComment } from '../scripts/publish.mjs';
import { checkFixCommit, parseCommand, runCommand, main as commandMain } from '../scripts/command.mjs';
import { githubForge } from '../scripts/forge.mjs';
import { historyOf, parseHistory, recordRun } from '../dist/history.js';
import { ScriptedProvider, isVisualFailure, visualIntent, engineEnv, failureGroup, heal, healedFolders, loadHealed, runtimeMode } from '../dist/index.js';

const LOGIN = "test('login', async ({ page }) => {\n  await page.getByRole('button', { name: 'Log in' }).click();\n});\n";

function project() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-v012-'));
  mkdirSync(path.join(dir, 'tests'));
  writeFileSync(path.join(dir, 'playwright.config.ts'), 'export default {};\n');
  writeFileSync(path.join(dir, 'tests', 'login.spec.ts'), LOGIN);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

const entry = (over = {}) => ({
  version: 1,
  file: 'tests/login.spec.ts',
  title: 'login',
  selector: 'internal:role=button[name="Log in"i]',
  locator: { kind: 'role', value: 'button', name: 'Sign in' },
  code: "getByRole('button', { name: 'Sign in' })",
  score: 0.67,
  signals: ['role', 'position'],
  action: 'click',
  mode: 'heal',
  at: '2026-11-09T00:00:00.000Z',
  ...over,
});

function writeHealed(dir, e) {
  const d = path.join(dir, 'autoheal-healed');
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'abcdef0123456789.json'), JSON.stringify(e));
}

/** An engine for a green run: no failures; the test passes only with the new locator. */
function greenEngine(dir, failures = []) {
  const calls = [];
  return {
    calls,
    async close() {},
    async call(name, args) {
      calls.push({ name, args });
      const ok = (data, text = '') => ({ ok: true, isError: false, text, data: { ok: true, ...data } });
      if (name === 'get-failure') {
        const f = failures[args.index - 1];
        return f ? ok({ failure: f, index: args.index, total: failures.length }, `### Error\n${f.message}`) : { ok: false, isError: true, text: 'none', data: { ok: false } };
      }
      if (name === 'check-test-change') return ok({ status: 'PASS', findings: [] });
      if (name === 'diagnose-flaky') return ok({ verdict: 'CONSISTENTLY FAILING' });
      if (name === 'run-test') {
        const fixed = readFileSync(path.join(dir, args.testFiles[0]), 'utf8').includes('Sign in');
        const repeat = Number((args.args ?? []).find((a) => a.startsWith('--repeat-each='))?.split('=')[1] ?? 1);
        return fixed ? ok({ run: { passed: repeat, failed: 0, flaky: 0, failures: [] } }) : { ok: false, isError: false, text: 'fail', data: { ok: false, run: { passed: 0, failed: 1, failures: [{ title: 'login' }] } } };
      }
      return ok({});
    },
  };
}

const opts = (dir, mcp, extra = {}) => ({
  projectRoot: dir,
  report: 'r.json',
  mode: 'draft-pr',
  maxFailures: 1,
  repeatEach: 3,
  quarantineDays: 14,
  allowWarn: false,
  checkFlaky: false,
  flakyRuns: 3,
  budget: { maxSteps: 20, maxTokens: 1e6, maxUsd: 1 },
  provider: null,
  mcp,
  ...extra,
});

test('runtime mode: env wins; the engine never heals', () => {
  assert.equal(runtimeMode({}), 'heal');
  assert.equal(runtimeMode({ AUTOHEAL_RUNTIME: 'report' }), 'report');
  assert.equal(runtimeMode({ AUTOHEAL_RUNTIME: 'OFF' }), 'off');
  assert.equal(runtimeMode({ AUTOHEAL_RUNTIME: 'junk' }, 'report'), 'report');
  assert.equal(engineEnv({ AUTOHEAL_RUNTIME: 'heal' }, false).AUTOHEAL_RUNTIME, 'off');
});

test('loadHealed: finds autoheal-healed folders inside artifacts, rejects bad entries', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-healed-'));
  const inner = path.join(dir, 'artifacts', 'autoheal-healed');
  mkdirSync(inner, { recursive: true });
  writeFileSync(path.join(inner, '0000000000000001.json'), JSON.stringify(entry()));
  writeFileSync(path.join(inner, '0000000000000002.json'), JSON.stringify(entry({ file: '../outside.spec.ts' })));
  writeFileSync(path.join(inner, '0000000000000003.json'), JSON.stringify(entry({ file: '/abs.spec.ts' })));
  writeFileSync(path.join(inner, 'not-an-entry.json'), JSON.stringify(entry({ title: 'other' })));
  writeFileSync(path.join(inner, '0000000000000004.json'), '{oops');
  const found = await loadHealed([path.join(dir, 'artifacts')]);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'tests/login.spec.ts');
  assert.ok(healedFolders(dir, 'artifacts/r.json', ['x']).includes(path.join(dir, 'autoheal-healed')));
});

test('a green run that healed during the run becomes a proven code fix (no AI)', async () => {
  const dir = project();
  writeHealed(dir, entry());
  const engine = greenEngine(dir);
  const s = await heal(opts(dir, engine));
  assert.equal(s.results.length, 1);
  const [r] = s.results;
  assert.equal(r.status, 'FIXED', r.summary);
  assert.equal(r.healed, true);
  assert.equal(r.fix.by, 'fingerprint');
  assert.match(r.summary, /Healed during the run/);
  assert.match(readFileSync(path.join(dir, 'tests/login.spec.ts'), 'utf8'), /getByRole\('button', \{ name: 'Sign in' \}\)/);
  assert.equal(s.outcome, 'fixed');
  assert.ok(s.changedFiles.includes('tests/login.spec.ts'));
  // Proven by a stability rerun.
  assert.ok(engine.calls.some((c) => c.name === 'run-test' && (c.args.args ?? []).includes('--repeat-each=3')));
});

test('a heal that does not pass on its own leaves the code alone', async () => {
  const dir = project();
  writeHealed(dir, entry({ locator: { kind: 'role', value: 'button', name: 'Nope' }, code: "getByRole('button', { name: 'Nope' })" }));
  const s = await heal(opts(dir, greenEngine(dir)));
  assert.equal(s.results[0].status, 'UNFIXED');
  assert.equal(readFileSync(path.join(dir, 'tests/login.spec.ts'), 'utf8'), LOGIN);
  assert.equal(s.changes, false);
});

test('no failures and no heals: nothing to do', async () => {
  const dir = project();
  const s = await heal(opts(dir, greenEngine(dir)));
  assert.equal(s.outcome, 'nothing-to-do');
});

test('grouping: same wrong value = one app bug, max-failures counts groups', async () => {
  assert.equal(failureGroup({ index: 1 }, 'internal:testid=[data-testid="x"s]'), 'locator:internal:testid=[data-testid="x"s]');
  assert.equal(failureGroup({ index: 1, expected: '"$10"', actual: '"$12"', kind: 'assertion' }), failureGroup({ index: 2, expected: '"$10"', actual: '"$12"', kind: 'assertion' }));
  assert.notEqual(failureGroup({ index: 1, kind: 'timeout' }), failureGroup({ index: 2, kind: 'timeout' }));
  const dir = project();
  const price = (n) => ({ file: `tests/p${n}.spec.ts`, line: 1, title: `p${n}`, kind: 'assertion', message: 'Expected: "$10"\nReceived: "$12"' });
  for (const n of [1, 2, 3]) writeFileSync(path.join(dir, `tests/p${n}.spec.ts`), "test('p', async ({ page }) => { await expect(page.getByTestId('price')).toHaveText('$10'); });\n");
  const other = { file: 'tests/login.spec.ts', line: 2, title: 'login', kind: 'assertion', message: 'Expected: "a"\nReceived: "b"' };
  const s = await heal(opts(dir, greenEngine(dir, [price(1), price(2), price(3), other]), { maxFailures: 2 }));
  assert.equal(s.groups, 2);
  const byTitle = Object.fromEntries(s.results.map((r) => [r.failure.title, r]));
  assert.equal(byTitle.p1.status, 'APP_BUG');
  assert.equal(byTitle.login.status, 'APP_BUG');
  assert.equal(byTitle.p2.groupOf, 'p1');
  assert.equal(byTitle.p3.groupOf, 'p1');
  assert.equal(s.skippedFailures, 0);
});

// ---------- Fix on the failing PR's own branch ----------

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

function mockServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      const [status, data] = handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('prBranchTarget: only an open PR branch that is not the default or a shared branch', async () => {
  const forge = { defaultBranch: async () => 'main' };
  assert.equal((await prBranchTarget(forge, 'feature/x', '')).ok, false);
  assert.equal((await prBranchTarget(forge, 'main', '3')).ok, false);
  assert.equal((await prBranchTarget(forge, 'release/1.2', '3')).ok, false);
  assert.equal((await prBranchTarget(forge, 'autoheal/9', '3')).ok, false);
  assert.equal((await prBranchTarget({}, 'feature/x', '3')).ok, false, 'unknown default branch');
  assert.equal((await prBranchTarget(forge, 'feature/x', '3')).ok, true);
  assert.match(sourceComment({ fixUrl: 'https://x/pr/2', onBranch: false, fixed: 2, label: 'pull request' }), /\/autoheal apply/);
  assert.match(sourceComment({ fixUrl: null, onBranch: true, fixed: 1, label: 'merge request' }), /pushed 1 test fix onto this branch/);
});

async function prBranchRun({ branch, target }) {
  const bare = tmp('autoheal-bare-');
  git(bare, 'init', '-q', '--bare');
  const work = tmp('autoheal-work-');
  git(work, 'init', '-q', '-b', branch);
  mkdirSync(path.join(work, 'tests'));
  writeFileSync(path.join(work, 'tests', 'login.spec.ts'), LOGIN);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', bare, `HEAD:refs/heads/${branch}`);
  const sha = git(work, 'rev-parse', 'HEAD');
  writeFileSync(path.join(work, 'tests', 'login.spec.ts'), LOGIN.replace("'Log in'", "'Sign in'"));
  const patch = execFileSync('git', ['diff'], { cwd: work, encoding: 'utf8' });
  git(work, 'checkout', '--', '.');
  const result = tmp('autoheal-result-');
  writeFileSync(path.join(result, 'patch.diff'), patch);
  writeFileSync(path.join(result, 'changed-files.txt'), 'tests/login.spec.ts\n');
  writeFileSync(path.join(result, 'meta.json'), JSON.stringify({ version: 1, fixed: 1, blocked: 0 }));
  writeFileSync(path.join(result, 'pr-body.md'), '## AutoHeal\n');
  writeFileSync(path.join(result, 'issues.json'), '[]');
  const { server, calls, url } = await mockServer((req) => {
    if (req.method === 'GET' && req.url === '/api/v4/projects/7') return [200, { default_branch: 'main' }];
    if (req.method === 'GET') return [200, []];
    if (req.url === '/api/v4/projects/7/merge_requests') return [201, { web_url: `${url}/acme/shop/-/merge_requests/9`, iid: 9 }];
    return [201, {}];
  });
  const cwd = process.cwd();
  try {
    process.chdir(work);
    const env = {
      GITLAB_CI: 'true',
      CI_SERVER_URL: url,
      CI_API_V4_URL: `${url}/api/v4`,
      CI_PROJECT_PATH: 'acme/shop',
      CI_PROJECT_ID: '7',
      CI_PIPELINE_ID: '556',
      CI_COMMIT_SHA: sha,
      CI_COMMIT_BRANCH: branch,
      CI_MERGE_REQUEST_IID: '4',
      AUTOHEAL_GITLAB_TOKEN: 'glpat-x',
      AUTOHEAL_PUSH_URL: bare,
      FIX_TARGET: target,
      RESULT_DIR: result,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    assert.equal(await publishMain(env), 0);
  } finally {
    process.chdir(cwd);
    server.close();
  }
  return { bare, calls, sha };
}

test('fix-target pr-branch: one more commit on the PR branch, and a note on the PR', async () => {
  const { bare, calls, sha } = await prBranchRun({ branch: 'feature/login', target: 'pr-branch' });
  assert.match(execFileSync('git', ['show', 'feature/login:tests/login.spec.ts'], { cwd: bare, encoding: 'utf8' }), /Sign in/);
  assert.equal(execFileSync('git', ['rev-parse', 'feature/login~1'], { cwd: bare, encoding: 'utf8' }).trim(), sha, 'a plain fast-forward commit');
  assert.match(execFileSync('git', ['log', '-1', '--format=%s', 'feature/login'], { cwd: bare, encoding: 'utf8' }), /^test: AutoHeal fixes for failed run 556/);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.url === '/api/v4/projects/7/merge_requests'), 'no separate MR');
  const note = calls.find((c) => c.method === 'POST' && c.url === '/api/v4/projects/7/merge_requests/4/notes');
  assert.match(JSON.parse(note.body).body, /pushed 1 test fix onto this branch/);
});

test('fix-target pr-branch never pushes to the default branch: falls back to a fix MR', async () => {
  const { bare, calls } = await prBranchRun({ branch: 'main', target: 'pr-branch' });
  assert.doesNotMatch(execFileSync('git', ['show', 'main:tests/login.spec.ts'], { cwd: bare, encoding: 'utf8' }), /Sign in/);
  assert.match(execFileSync('git', ['show', 'autoheal/556:tests/login.spec.ts'], { cwd: bare, encoding: 'utf8' }), /Sign in/);
  const note = calls.find((c) => c.method === 'POST' && c.url === '/api/v4/projects/7/merge_requests/4/notes');
  assert.match(JSON.parse(note.body).body, /\/autoheal apply/);
});

// ---------- /autoheal chat commands ----------

test('parseCommand: first line only, known commands', () => {
  assert.equal(parseCommand('/autoheal apply'), 'apply');
  assert.equal(parseCommand('  /autoheal Retry \nplease'), 'retry');
  assert.equal(parseCommand('/autoheal'), 'help');
  assert.equal(parseCommand('/autoheal nuke'), 'unknown');
  assert.equal(parseCommand('please /autoheal apply'), null);
  assert.equal(parseCommand('/autoheal apply now'), null);
  assert.equal(parseCommand(undefined), null);
});

/** A repo with a PR branch and an AutoHeal fix branch on top of it, in a bare remote. */
function commandRepo({ author = 'autoheal-ai@users.noreply.github.com', file = 'tests/login.spec.ts' } = {}) {
  const bare = tmp('autoheal-cbare-');
  git(bare, 'init', '-q', '--bare');
  const work = tmp('autoheal-cwork-');
  git(work, 'init', '-q', '-b', 'main');
  mkdirSync(path.join(work, 'tests'));
  writeFileSync(path.join(work, 'tests', 'login.spec.ts'), LOGIN);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', bare, 'HEAD:refs/heads/main');
  git(work, 'checkout', '-q', '-b', 'feature/x');
  writeFileSync(path.join(work, 'README.md'), 'hi\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'feature');
  git(work, 'push', '-q', bare, 'HEAD:refs/heads/feature/x');
  git(work, 'checkout', '-q', '-b', 'autoheal/77');
  mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  writeFileSync(path.join(work, file), LOGIN.replace("'Log in'", "'Sign in'"));
  git(work, 'add', '-A');
  execFileSync('git', ['-c', 'user.name=autoheal-ai[bot]', '-c', `user.email=${author}`, 'commit', '-qm', 'test: AutoHeal fixes for failed run 77'], { cwd: work });
  git(work, 'push', '-q', bare, 'HEAD:refs/heads/autoheal/77');
  // A new commit on the PR branch after the fix was made.
  execFileSync('git', ['--git-dir', bare, 'update-ref', 'refs/heads/feature/x', git(work, 'rev-parse', 'feature/x')]);
  const checkout = tmp('autoheal-ccheckout-');
  execFileSync('git', ['clone', '-q', bare, checkout]);
  return { bare, checkout, work };
}

function githubMock() {
  return mockServer((req) => {
    const u = req.url;
    if (req.method === 'GET' && u === '/repos/acme/shop') return [200, { default_branch: 'main' }];
    if (req.method === 'GET' && u === '/repos/acme/shop/pulls/5') return [200, { number: 5, html_url: 'https://gh/acme/shop/pull/5', state: 'open', head: { ref: 'feature/x', sha: 'abc', repo: { full_name: 'acme/shop' } }, base: { ref: 'main' } }];
    if (req.method === 'GET' && u.startsWith('/repos/acme/shop/pulls?state=open') && u.includes('base=feature%2Fx')) return [200, [{ number: 6, html_url: 'https://gh/acme/shop/pull/6', head: { ref: 'autoheal/77', repo: { full_name: 'acme/shop' } }, base: { ref: 'feature/x' }, body: 'Changed the login locator because @alice renamed it' }]];
    if (req.method === 'GET') return [200, []];
    return [200, {}];
  });
}

test('/autoheal apply: cherry-picks the AutoHeal commit onto the PR branch and closes the fix PR', async () => {
  const { bare, checkout } = commandRepo();
  const { server, calls, url } = await githubMock();
  try {
    const forge = githubForge({ api: url, server: url, repo: 'acme/shop', token: 't' });
    forge.pushUrl = bare;
    const reply = await runCommand({ cmd: 'apply', forge, number: '5', commenter: '@​bob', root: checkout, env: {} });
    assert.match(reply, /Applied the AutoHeal fix/);
    assert.match(execFileSync('git', ['show', 'feature/x:tests/login.spec.ts'], { cwd: bare, encoding: 'utf8' }), /Sign in/);
    assert.match(execFileSync('git', ['show', 'feature/x:README.md'], { cwd: bare, encoding: 'utf8' }), /hi/, 'the PR branch keeps its own commits');
    assert.ok(calls.some((c) => c.method === 'PATCH' && c.url === '/repos/acme/shop/pulls/6' && JSON.parse(c.body).state === 'closed'));
    const explain = await runCommand({ cmd: 'explain', forge, number: '5', commenter: '', root: checkout, env: {} });
    assert.match(explain, /@​alice/, 'mentions in the fix PR body are neutralized');
  } finally {
    server.close();
  }
});

test('/autoheal apply refuses a fix commit AutoHeal did not make, or outside the allowed paths', async () => {
  const a = commandRepo({ author: 'mallory@example.com' });
  execFileSync('git', ['fetch', '-q', a.bare, '+refs/heads/autoheal/77:refs/autoheal/fix'], { cwd: a.checkout });
  assert.throws(() => checkFixCommit(a.checkout, 'refs/autoheal/fix'), /not made by AutoHeal/);
  const b = commandRepo({ file: 'src/app.ts' });
  execFileSync('git', ['fetch', '-q', b.bare, '+refs/heads/autoheal/77:refs/autoheal/fix'], { cwd: b.checkout });
  assert.throws(() => checkFixCommit(b.checkout, 'refs/autoheal/fix'), /outside the allowed paths/);
});

test('commands from people without write access only get a refusal', async () => {
  const { server, calls, url } = await githubMock();
  try {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/shop', GITHUB_SERVER_URL: url, GITHUB_API_URL: url, GH_TOKEN: 't', COMMENT_BODY: '/autoheal ignore', PR_NUMBER: '5', AUTHOR_ASSOCIATION: 'NONE', COMMENTER: 'eve' };
    assert.equal(await commandMain(env), 0);
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
    const reply = calls.find((c) => c.method === 'POST' && c.url === '/repos/acme/shop/issues/5/comments');
    assert.match(JSON.parse(reply.body).body, /Only maintainers/);
  } finally {
    server.close();
  }
});

// ---------- Flaky: fix first, history ----------

test('history: parsed safely, runs recorded and capped, shown per test', () => {
  const h0 = parseHistory('{"tests":{"a":{"file":"t.spec.ts","title":"x","runs":[{"at":"2026-10-01T00:00:00Z","status":"FLAKY"}]},"b":{"file":1}}}');
  assert.equal(Object.keys(h0.tests).length, 1);
  assert.deepEqual(parseHistory('nope').tests, {});
  let h = h0;
  for (let i = 0; i < 40; i++) h = recordRun(h, [{ failure: { file: 't.spec.ts', title: 'x' }, status: 'QUARANTINED' }], `2026-11-0${i % 9}T00:00:00Z`);
  assert.equal(h.tests['t.spec.ts\nx'].runs.length, 30);
  const past = historyOf(h0, 't.spec.ts', 'x');
  assert.deepEqual(past, { failures: 1, flaky: 1, since: '2026-10-01' });
  assert.equal(historyOf(h0, 'other', 'x'), null);
});

const SOMETIMES = "test('sometimes', async ({ page }) => {\n  await page.goto('/');\n  await page.getByRole('button', { name: 'Go' }).click();\n});\n";

test('a flaky test gets an AI fix proven by 10 runs before any quarantine', async () => {
  const dir = project();
  writeFileSync(path.join(dir, 'tests', 'sometimes.spec.ts'), SOMETIMES);
  const failure = { file: 'tests/sometimes.spec.ts', line: 3, title: 'sometimes', kind: 'assertion', message: 'flaky' };
  const calls = [];
  const engine = {
    calls,
    async close() {},
    async call(name, args) {
      calls.push({ name, args });
      const ok = (data, text = '') => ({ ok: true, isError: false, text, data: { ok: true, ...data } });
      if (name === 'get-failure') return args.index === 1 ? ok({ failure, index: 1, total: 1 }, '### Error\nflaky') : { ok: false, isError: true, text: '', data: { ok: false } };
      if (name === 'diagnose-flaky') return ok({ verdict: 'FLAKY' });
      if (name === 'check-test-change') return ok({ status: 'PASS', findings: [] });
      if (name === 'run-test') {
        const fixed = readFileSync(path.join(dir, args.testFiles[0]), 'utf8').includes('toBeEnabled');
        const repeat = Number((args.args ?? []).find((a) => a.startsWith('--repeat-each='))?.split('=')[1] ?? 1);
        return fixed ? ok({ run: { passed: repeat, failed: 0, flaky: 0, failures: [] } }) : { ok: false, isError: false, text: 'flaky', data: { ok: false, run: { passed: 0, failed: 1, failures: [{ title: 'sometimes' }] } } };
      }
      if (name === 'quarantine') throw new Error('should not quarantine');
      return ok({});
    },
  };
  const fixed = SOMETIMES.replace("  await page.getByRole('button', { name: 'Go' }).click();", "  await expect(page.getByRole('button', { name: 'Go' })).toBeEnabled();\n  await page.getByRole('button', { name: 'Go' }).click();");
  const provider = new ScriptedProvider([{ calls: [{ name: 'propose_fix', input: { path: 'tests/sometimes.spec.ts', content: fixed, explanation: 'wait until the button is enabled' } }] }]);
  const history = parseHistory(JSON.stringify({ tests: { k: { file: 'tests/sometimes.spec.ts', title: 'sometimes', runs: [{ at: '2026-10-20T00:00:00Z', status: 'QUARANTINED' }] } } }));
  const s = await heal(opts(dir, engine, { provider, checkFlaky: true, history }));
  const [r] = s.results;
  assert.equal(r.category, 'FLAKY');
  assert.equal(r.status, 'FIXED', r.summary);
  assert.match(r.summary, /Flaky test fixed, not quarantined: the fix passed 10 runs/);
  assert.deepEqual(r.history, { failures: 1, flaky: 1, since: '2026-10-20' });
  assert.ok(calls.some((c) => c.name === 'run-test' && (c.args.args ?? []).includes('--repeat-each=10')));
});

// ---------- Visual snapshot triage ----------

const png = (n) => {
  const b = Buffer.alloc(64, n);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b[20] = 0;
  return b;
};

function visualProject({ appChange }) {
  const dir = project();
  mkdirSync(path.join(dir, 'tests', 'home.spec.ts-snapshots'));
  writeFileSync(path.join(dir, 'tests', 'home.spec.ts'), "test('home', async ({ page }) => {\n  await expect(page).toHaveScreenshot('home.png');\n});\n");
  writeFileSync(path.join(dir, 'tests', 'home.spec.ts-snapshots', 'home-chromium-linux.png'), png(1));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'app.css'), 'a{color:red}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'baseline');
  if (appChange) {
    writeFileSync(path.join(dir, 'src', 'app.css'), 'a{color:blue}\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'Make links blue');
  } else {
    writeFileSync(path.join(dir, 'tests', 'other.spec.ts'), '// test only\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'tests only');
  }
  return dir;
}

function visualEngine(dir) {
  const failure = { file: 'tests/home.spec.ts', line: 2, title: 'home', kind: 'assertion', message: 'Error: expect(page).toHaveScreenshot(expected) failed\n  1250 pixels (ratio 0.01 of all image pixels) are different.' };
  const calls = [];
  const snap = path.join(dir, 'tests', 'home.spec.ts-snapshots', 'home-chromium-linux.png');
  return {
    calls,
    async close() {},
    async call(name, args) {
      calls.push({ name, args });
      const ok = (data, text = '') => ({ ok: true, isError: false, text, data: { ok: true, ...data } });
      if (name === 'get-failure') return args.index === 1 ? ok({ failure, index: 1, total: 1 }, `### Error\n${failure.message}`) : { ok: false, isError: true, text: '', data: { ok: false } };
      if (name === 'run-test') {
        if ((args.args ?? []).includes('--update-snapshots')) {
          writeFileSync(snap, png(2));
          writeFileSync(path.join(dir, 'tests', 'home.spec.ts-snapshots', 'new-chromium-linux.png'), png(3));
          return ok({ run: { passed: 1, failed: 0 } });
        }
        const good = readFileSync(snap).equals(png(2));
        const repeat = Number((args.args ?? []).find((a) => a.startsWith('--repeat-each='))?.split('=')[1] ?? 1);
        return good ? ok({ run: { passed: repeat, failed: 0, flaky: 0, failures: [] } }) : { ok: false, isError: false, text: 'diff', data: { ok: false, run: { passed: 0, failed: 1, failures: [{ title: 'home' }] } } };
      }
      if (name === 'check-test-change') return ok({ status: 'PASS', findings: [] });
      return ok({});
    },
  };
}

test('visual: detection and intent from git history', async () => {
  assert.ok(isVisualFailure({ message: 'expect(page).toHaveScreenshot(expected) failed' }));
  assert.ok(isVisualFailure({ message: '12 pixels (ratio 0.01 of all image pixels) are different.' }));
  assert.ok(!isVisualFailure({ message: 'Expected: "a"' }));
  const yes = await visualIntent(visualProject({ appChange: true }), 'tests/home.spec.ts-snapshots');
  assert.equal(yes.intended, true);
  assert.match(yes.commits[0], /Make links blue/);
  const no = await visualIntent(visualProject({ appChange: false }), 'tests/home.spec.ts-snapshots');
  assert.equal(no.intended, false);
});

test('visual: an intended UI change updates only the existing baseline, proven by reruns', async () => {
  const dir = visualProject({ appChange: true });
  const evidenceDir = path.join(dir, '.out', 'evidence');
  const s = await heal(opts(dir, visualEngine(dir), { evidenceDir }));
  const [r] = s.results;
  assert.equal(r.status, 'FIXED', r.summary);
  assert.equal(r.fix.by, 'baseline');
  assert.equal(r.rootCause, 'VISUAL_CHANGE');
  assert.deepEqual(r.visual.baselines, ['tests/home.spec.ts-snapshots/home-chromium-linux.png']);
  assert.deepEqual(s.changedFiles.filter((f) => f.endsWith('.png')), ['tests/home.spec.ts-snapshots/home-chromium-linux.png']);
  assert.ok(readFileSync(path.join(dir, 'tests/home.spec.ts-snapshots/home-chromium-linux.png')).equals(png(2)));
  assert.throws(() => readFileSync(path.join(dir, 'tests/home.spec.ts-snapshots/new-chromium-linux.png')), /ENOENT/, 'new baselines are not added');
  assert.ok(readFileSync(path.join(evidenceDir, r.visual.evidence.before)).equals(png(1)));

  // The publish side: the binary patch is accepted only for that baseline.
  const patch = execFileSync('git', ['diff', '--binary', '--', 'tests/home.spec.ts-snapshots/home-chromium-linux.png'], { cwd: dir, encoding: 'utf8' });
  const files = parsePatch(patch);
  assert.deepEqual(files, [{ path: 'tests/home.spec.ts-snapshots/home-chromium-linux.png', isNew: false, binary: true }]);
  checkBaselines(dir, files, s.results);
  assert.throws(() => checkBaselines(dir, files, []), /no kept baseline fix/);
  writeFileSync(path.join(dir, 'tests/home.spec.ts-snapshots/home-chromium-linux.png'), 'not a png');
  assert.throws(() => checkBaselines(dir, files, s.results), /not a PNG/);
  const evil = execFileSync('git', ['diff', '--binary', '--', '.'], { cwd: dir, encoding: 'utf8' });
  assert.ok(evil.includes('GIT binary patch'));
  writeFileSync(path.join(dir, 'src', 'logo.png'), png(9));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'logo');
  writeFileSync(path.join(dir, 'src', 'logo.png'), png(8));
  assert.throws(() => parsePatch(execFileSync('git', ['diff', '--binary', '--', 'src/logo.png'], { cwd: dir, encoding: 'utf8' })), /unsupported change/);
});

test('visual: no app change since the baseline is an app bug, the baseline stays', async () => {
  const dir = visualProject({ appChange: false });
  const engine = visualEngine(dir);
  const s = await heal(opts(dir, engine));
  const [r] = s.results;
  assert.equal(r.status, 'APP_BUG');
  assert.equal(r.visual.intended, false);
  assert.ok(readFileSync(path.join(dir, 'tests/home.spec.ts-snapshots/home-chromium-linux.png')).equals(png(1)));
  assert.ok(!engine.calls.some((c) => (c.args.args ?? []).includes('--update-snapshots')));
});
