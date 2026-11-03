import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ScriptedProvider, heal, outcomeOf } from '../dist/index.js';

const LOGIN = "test('login', async ({ page }) => {\n  await page.getByRole('button', { name: 'Log in' }).click();\n  await expect(page.getByRole('status')).toHaveText('ok');\n});\n";
const PRICE = "test('price', async ({ page }) => {\n  await expect(page.getByTestId('price')).toHaveText('$10');\n});\n";

function project({ git = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-heal-'));
  mkdirSync(path.join(dir, 'tests'));
  writeFileSync(path.join(dir, 'playwright.config.ts'), 'export default {};\n');
  writeFileSync(path.join(dir, 'tests', 'login.spec.ts'), LOGIN);
  writeFileSync(path.join(dir, 'tests', 'price.spec.ts'), PRICE);
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  }
  return dir;
}

/** A fake engine: two failures; run-test passes once the login file says "Sign in". */
function fakeEngine(dir, opts = {}) {
  const calls = [];
  const failures = [
    { file: 'tests/login.spec.ts', line: 1, title: 'login.spec.ts › login', kind: 'timeout', message: "Test timeout of 30000ms exceeded.\nwaiting for getByRole('button', { name: 'Log in' })" },
    { file: 'tests/price.spec.ts', line: 1, title: 'price.spec.ts › price', kind: 'assertion', message: 'Expected: "$10"\nReceived: "$12"' },
    ...(opts.flaky ? [{ file: 'tests/login.spec.ts', line: 9, title: 'login.spec.ts › sometimes', kind: 'assertion', message: 'x' }] : []),
  ];
  return {
    calls,
    async close() {},
    async call(name, args) {
      calls.push({ name, args });
      const ok = (data, text = '') => ({ ok: data.ok !== false, isError: false, text, data: { ok: true, ...data } });
      switch (name) {
        case 'load-report':
          return opts.loadFails ? { ok: false, isError: true, text: 'REPORT_MISSING: nothing there', data: { ok: false, error: { kind: 'REPORT_MISSING' } } } : ok({});
        case 'get-failure': {
          const f = failures[args.index - 1];
          return f ? ok({ failure: f, index: args.index, total: failures.length }, `## Failure ${args.index}\n### Error\n${f.message}\n### Diagnosis\nLook for an element that never appears`) : { ok: false, isError: true, text: 'no failure', data: { ok: false } };
        }
        case 'suggest-fix':
          if (opts.rulesFix && args.index === 1) {
            return ok({ fix: { file: 'tests/login.spec.ts', line: 2, before: "  await page.getByRole('button', { name: 'Log in' }).click();", after: "  await page.getByRole('button', { name: 'Sign in' }).click();", kind: 'locator', confidence: 'high', why: 'renamed' } });
          }
          if (args.index === 2) return ok({ fix: { file: 'tests/price.spec.ts', line: 2, before: 'same', after: 'same', kind: 'locator' } });
          return ok({});
        case 'diagnose-flaky':
          return ok({ verdict: args.testFiles[0].endsWith(':9') ? 'FLAKY' : 'CONSISTENTLY FAILING' });
        case 'check-test-change':
          if (args.base === 'HEAD') return ok({ status: opts.finalBlock ? 'BLOCK' : 'PASS', findings: [] });
          return ok({ status: 'PASS', findings: [] });
        case 'run-test': {
          const content = readFileSync(path.join(dir, args.testFiles[0]), 'utf8');
          const fixed = content.includes('Sign in') && !opts.neverPasses;
          const repeat = Number((args.args ?? []).find((a) => a.startsWith('--repeat-each='))?.split('=')[1] ?? 1);
          return fixed
            ? ok({ run: { passed: repeat, failed: 0, flaky: 0, failures: [] } })
            : { ok: false, isError: false, text: 'still failing', data: { ok: false, run: { passed: 0, failed: 1, flaky: 0, failures: [{ title: 'login.spec.ts › login' }] } } };
        }
        case 'quarantine':
          writeFileSync(path.join(dir, 'playwright-quarantine.json'), JSON.stringify({ entries: [{ title: args.title, owner: args.owner }] }));
          return ok({ status: 'added' });
        default:
          return ok({});
      }
    },
  };
}

const opts = (dir, engine, extra = {}) => ({
  projectRoot: dir,
  report: 'r.json',
  mode: 'draft-pr',
  maxFailures: 5,
  repeatEach: 5,
  quarantineDays: 14,
  allowWarn: false,
  checkFlaky: true,
  flakyRuns: 3,
  budget: { maxSteps: 20, maxTokens: 1e6, maxUsd: 1 },
  provider: null,
  mcp: engine,
  ...extra,
});

test('rules fix: kept after guard and stability; app bug untouched; no-op engine fix ignored', async () => {
  const dir = project();
  const engine = fakeEngine(dir, { rulesFix: true });
  const s = await heal(opts(dir, engine));
  const [login, price] = s.results;
  assert.equal(login.status, 'FIXED');
  assert.equal(login.fix.by, 'rules');
  assert.equal(login.stability.runs, 5);
  assert.equal(price.status, 'APP_BUG');
  assert.equal(readFileSync(path.join(dir, 'tests/price.spec.ts'), 'utf8'), PRICE);
  assert.match(readFileSync(path.join(dir, 'tests/login.spec.ts'), 'utf8'), /Sign in/);
  assert.deepEqual(s.changedFiles, ['.autoheal/memory.json', 'tests/login.spec.ts']);
  assert.equal(s.outcome, 'fixed');
  assert.equal(s.minutesSaved, 60);
  const stability = engine.calls.find((c) => c.name === 'run-test' && c.args.args);
  assert.deepEqual(stability.args.args, ['--repeat-each=5']);
  assert.equal(stability.args.grep, 'login');
});

test('AI fix path with a scripted provider, then repo memory', async () => {
  const dir = project();
  const provider = new ScriptedProvider([
    { calls: [{ name: 'propose_fix', input: { path: 'tests/login.spec.ts', content: LOGIN.replace('Log in', 'Sign in'), explanation: 'renamed button' } }] },
  ]);
  const s = await heal(opts(dir, fakeEngine(dir), { provider }));
  assert.equal(s.results[0].status, 'FIXED');
  assert.equal(s.results[0].fix.by, 'ai');
  const memory = JSON.parse(readFileSync(path.join(dir, '.autoheal/memory.json'), 'utf8'));
  assert.equal(memory.entries[0].note, 'renamed button');
});

test('a fix that never passes is reverted and reported as unfixed', async () => {
  const dir = project();
  const s = await heal(opts(dir, fakeEngine(dir, { rulesFix: true, neverPasses: true })));
  assert.equal(s.results[0].status, 'UNFIXED');
  assert.equal(readFileSync(path.join(dir, 'tests/login.spec.ts'), 'utf8'), LOGIN);
  assert.deepEqual(s.changedFiles, []);
  assert.equal(s.changes, false);
});

test('the final whole-tree guard reverts everything on BLOCK', async () => {
  const dir = project();
  const s = await heal(opts(dir, fakeEngine(dir, { rulesFix: true, finalBlock: true })));
  assert.equal(s.results[0].status, 'BLOCKED_CHEATING');
  assert.equal(s.outcome, 'blocked');
  assert.equal(readFileSync(path.join(dir, 'tests/login.spec.ts'), 'utf8'), LOGIN);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '');
});

test('flaky tests are quarantined with an owner; comment mode leaves no changes', async () => {
  const dir = project();
  const s = await heal(opts(dir, fakeEngine(dir, { flaky: true, rulesFix: true }), { owner: '@ada' }));
  const flaky = s.results.find((r) => r.failure.title.endsWith('sometimes'));
  assert.equal(flaky.status, 'QUARANTINED');
  assert.match(readFileSync(path.join(dir, 'playwright-quarantine.json'), 'utf8'), /@ada/);

  const dir2 = project();
  const s2 = await heal(opts(dir2, fakeEngine(dir2, { flaky: true, rulesFix: true }), { mode: 'comment' }));
  assert.equal(s2.results.find((r) => r.failure.title.endsWith('sometimes')).status, 'FLAKY');
  assert.equal(s2.results[0].status, 'FIXED');
  assert.equal(s2.changes, false);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir2, encoding: 'utf8' }).stdout.trim(), '');
  assert.ok(!existsSync(path.join(dir2, '.autoheal')));
});

test('max failures, load errors and nothing to do', async () => {
  const dir = project();
  const limited = await heal(opts(dir, fakeEngine(dir), { maxFailures: 1, checkFlaky: false }));
  assert.equal(limited.results.length, 1);
  assert.equal(limited.skippedFailures, 1);
  const failed = await heal(opts(dir, fakeEngine(dir, { loadFails: true })));
  assert.equal(failed.outcome, 'error');
  assert.match(failed.error, /Could not load the report/);
  assert.equal(outcomeOf([]), 'nothing-to-do');
});

test('without an AI key a test bug is reported, not guessed', async () => {
  const dir = project();
  const s = await heal(opts(dir, fakeEngine(dir), { checkFlaky: false }));
  assert.equal(s.results[0].status, 'UNFIXED');
  assert.match(s.results[0].summary, /no AI key/);
});

test('cli: help, version and usage errors', () => {
  const cli = path.join(import.meta.dirname, '..', 'dist', 'cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(run('--version').stdout.trim(), JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
  assert.match(run('--help').stdout, /autoheal heal --report/);
  assert.equal(run().status, 2);
  assert.equal(run('heal').status, 2);
  assert.equal(run('heal', '--report', 'x', '--mode', 'yolo').status, 2);
  assert.equal(run('heal', '--report', 'missing-dir').status, 2);
  assert.equal(run('nope').status, 2);
  const up = run('upload', '--summary', 'x.json');
  assert.equal(up.status, 0);
  assert.match(up.stderr, /skipped/);
});
