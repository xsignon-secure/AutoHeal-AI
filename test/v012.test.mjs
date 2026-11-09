import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main as publishMain, prBranchTarget, sourceComment } from '../scripts/publish.mjs';
import { engineEnv, failureGroup, heal, healedFolders, loadHealed, runtimeMode } from '../dist/index.js';

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
