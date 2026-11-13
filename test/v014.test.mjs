import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cover } from '../dist/cover.js';
import { Budget, ScriptedProvider, checkLogin, checkSessionPath, ensureSession, parseLoginStep, sessionFindings } from '../dist/index.js';
import { loginFromFlags } from '../dist/cli.js';

const SESSION = 'playwright/.auth/user.json';
const STEPS = [
  "fill getByLabel('Email') = {{env:E2E_USER}}",
  "fill getByLabel('Password') = {{env:E2E_PASSWORD}}",
  "click getByRole('button', { name: 'Sign in' })",
];
const CHECK = "getByRole('button', { name: 'Sign out' })";

function project() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-login-'));
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  return dir;
}

function engine({ status = 'saved', ok = true } = {}) {
  const calls = [];
  return {
    calls,
    async close() {},
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'save-login') return { ok, isError: !ok, text: ok ? `## SAVED ${args.path}` : 'LOGIN FAILED: the check failed', data: { status: ok ? status : 'failed', ok } };
      if (name === 'inspect-page') return { ok: true, isError: false, text: "button: getByRole('button', { name: 'Orders' })", data: {} };
      if (name === 'run-test') {
        const repeat = Number((args.args ?? []).find((a) => a.startsWith('--repeat-each='))?.split('=')[1] ?? 1);
        return { ok: true, isError: false, text: 'ok', data: { run: { passed: repeat, failed: 0, flaky: 0 } } };
      }
      return { ok: true, isError: false, text: '', data: {} };
    },
  };
}

test('login steps read like a person writes them', () => {
  assert.deepEqual(parseLoginStep("fill getByLabel('Email') = {{env:E2E_USER}}"), { type: 'fill', locator: "getByLabel('Email')", value: '{{env:E2E_USER}}' });
  assert.deepEqual(parseLoginStep("click getByRole('button', { name: 'Sign in' })"), { type: 'click', locator: "getByRole('button', { name: 'Sign in' })" });
  assert.deepEqual(parseLoginStep('goto /login'), { type: 'goto', url: '/login' });
  assert.deepEqual(parseLoginStep('wait 500'), { type: 'wait', ms: 500 });
  assert.deepEqual(parseLoginStep("press input[name=code] = Enter"), { type: 'press', locator: 'input[name=code]', value: 'Enter' });
  assert.throws(() => parseLoginStep('type foo'), /unknown action/);
  assert.throws(() => parseLoginStep("fill getByLabel('Email')"), /needs "<locator> = <value>"/);
  assert.throws(() => parseLoginStep('wait 20000'), /at most 10000/);
});

test('login config: secrets must come from env, a check is needed, paths stay in the project', () => {
  assert.deepEqual(checkLogin({ session: SESSION, steps: STEPS, check: CHECK }).steps.length, 3);
  assert.throws(() => checkLogin({ session: SESSION, steps: ["fill getByLabel('Password') = hunter2", ...STEPS.slice(2)], check: CHECK }), /plain text/);
  assert.throws(() => checkLogin({ session: SESSION, steps: STEPS }), /login-check/);
  assert.equal(checkLogin({ session: SESSION, steps: [...STEPS, `wait ${CHECK}`] }).session, SESSION);
  assert.throws(() => checkLogin({ session: SESSION, steps: ["fill getByLabel('Code') = {{totp}}", ...STEPS], check: CHECK }), /login-totp-env/);
  assert.throws(() => checkSessionPath('../secrets.json'), /inside the project/);
  assert.throws(() => checkSessionPath('/etc/passwd.json'), /relative/);
  assert.throws(() => checkSessionPath('playwright/.auth/user.txt'), /\.json/);
  assert.equal(checkSessionPath('./playwright\\.auth\\admin.json'), 'playwright/.auth/admin.json');
});

test('cover CLI flags: --session alone reuses a file, --login-step logs in, stray flags are refused', () => {
  assert.equal(loginFromFlags({}), null);
  assert.deepEqual(loginFromFlags({ session: 'auth/a.json' }), { session: 'auth/a.json' });
  assert.deepEqual(loginFromFlags({ 'login-step': STEPS, 'login-check': CHECK }), { session: SESSION, steps: STEPS, check: CHECK });
  assert.throws(() => loginFromFlags({ 'login-url': '/login' }), /need --login-step/);
});

test('ensureSession logs in through the engine, on the app only', async () => {
  const dir = project();
  const e = engine();
  const lines = [];
  const s = await ensureSession(e, { session: SESSION, url: '/signin', steps: STEPS, check: CHECK, totpEnv: 'E2E_TOTP' }, { projectRoot: dir, appUrl: 'http://127.0.0.1:3000', log: (l) => lines.push(l) });
  assert.equal(s, SESSION);
  const call = e.calls[0];
  assert.equal(call.name, 'save-login');
  assert.equal(call.args.url, 'http://127.0.0.1:3000/signin');
  assert.equal(call.args.path, SESSION);
  assert.deepEqual(call.args.verify, { visible: CHECK });
  assert.equal(call.args.totpSecretEnv, 'E2E_TOTP');
  assert.equal(call.args.actions[1].value, '{{env:E2E_PASSWORD}}');
  assert.match(lines[0], /saved the session/);

  await assert.rejects(ensureSession(engine({ ok: false }), { session: SESSION, steps: STEPS, check: CHECK }, { projectRoot: dir, appUrl: 'http://127.0.0.1:3000' }), /Login failed/);
  await assert.rejects(ensureSession(engine(), { session: SESSION, url: 'https://evil.example/login', steps: STEPS, check: CHECK }, { projectRoot: dir, appUrl: 'http://127.0.0.1:3000' }), /must be on the app/);
  await assert.rejects(ensureSession(engine(), { session: SESSION, steps: ['goto https://evil.example/', ...STEPS], check: CHECK }, { projectRoot: dir, appUrl: 'http://127.0.0.1:3000' }), /leaves the app/);
  // No steps: the session file must already exist (a setup project made it).
  await assert.rejects(ensureSession(engine(), { session: SESSION }, { projectRoot: dir }), /does not exist/);
  mkdirSync(path.join(dir, 'playwright/.auth'), { recursive: true });
  writeFileSync(path.join(dir, SESSION), '{"cookies":[],"origins":[]}');
  const quiet = engine();
  assert.equal(await ensureSession(quiet, { session: SESSION }, { projectRoot: dir }), SESSION);
  assert.equal(quiet.calls.length, 0);
});

test('a new test may load only the configured session', () => {
  assert.deepEqual(sessionFindings("test.use({ storageState: 'playwright/.auth/user.json' });", SESSION), []);
  assert.deepEqual(sessionFindings('@pytest.mark.browser_context_args(storage_state="./playwright/.auth/user.json")', SESSION), []);
  assert.equal(sessionFindings("test.use({ storageState: 'playwright/.auth/admin.json' });", SESSION).length, 1);
  assert.equal(sessionFindings("test.use({ storageState: path.join(dir, 'x.json') });", SESSION).length, 1);
  assert.equal(sessionFindings("test.use({ storageState: 'playwright/.auth/user.json' });", undefined).length, 1);
});

const SIGNED_IN = "import { test, expect } from '@playwright/test';\n\ntest.use({ storageState: 'playwright/.auth/user.json' });\n\ntest('orders', async ({ page }) => {\n  await page.goto('/account');\n  await page.getByRole('button', { name: 'Orders' }).click();\n  await expect(page.getByRole('heading')).toHaveText('Your orders');\n});\n";

test('cover with a session: pages open signed in, the prompt says so, the test must use it', async () => {
  const dir = project();
  const e = engine();
  const provider = new ScriptedProvider([
    { calls: [{ name: 'inspect_page', input: { url: '/account' } }] },
    { calls: [{ name: 'write_test', input: { content: SIGNED_IN.replace('user.json', 'admin.json'), explanation: 'wrong session' } }] },
    { calls: [{ name: 'write_test', input: { content: SIGNED_IN, explanation: 'orders' } }] },
  ]);
  const r = await cover({ projectRoot: dir, flow: 'see my orders', appUrl: 'http://127.0.0.1:3000', provider, budget: new Budget({ maxSteps: 20, maxTokens: 1e6, maxUsd: 1 }, null), mcp: e, runs: 3, session: SESSION });
  assert.equal(r.status, 'written', r.explanation);
  assert.equal(r.attempts, 2);
  assert.equal(readFileSync(path.join(dir, r.file), 'utf8'), SIGNED_IN);
  assert.deepEqual(e.calls.find((c) => c.name === 'inspect-page').args, { url: 'http://127.0.0.1:3000/account', storageState: SESSION });
});

import { existsSync } from 'node:fs';
import { heal } from '../dist/index.js';

function healEngine(dir, { loginOk = true } = {}) {
  const calls = [];
  return {
    calls,
    async close() {},
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'save-login') {
        if (!loginOk) return { ok: false, isError: false, text: 'LOGIN FAILED', data: { ok: false, status: 'failed' } };
        mkdirSync(path.join(dir, 'playwright/.auth'), { recursive: true });
        writeFileSync(path.join(dir, args.path), '{"cookies":[{"name":"sid"}],"origins":[]}');
        return { ok: true, isError: false, text: 'SAVED', data: { ok: true, status: 'saved' } };
      }
      if (name === 'get-failure') return { ok: false, isError: true, text: 'no failure', data: { ok: false } };
      return { ok: true, isError: false, text: '', data: { ok: true } };
    },
  };
}

const healOpts = (dir, mcp, extra = {}) => ({
  projectRoot: dir, report: 'r.json', mode: 'draft-pr', maxFailures: 3, repeatEach: 3, quarantineDays: 14, allowWarn: false, checkFlaky: false, flakyRuns: 3,
  budget: { maxSteps: 5, maxTokens: 1e5, maxUsd: 1 }, provider: null, mcp, appUrl: 'http://127.0.0.1:3000', ...extra,
});

test('heal job signs in to the live app, and never leaves the session file behind', async () => {
  const dir = project();
  const e = healEngine(dir);
  const s = await heal(healOpts(dir, e, { login: { session: SESSION, url: '/login', steps: STEPS, check: CHECK } }));
  assert.equal(s.signedIn, SESSION);
  assert.equal(e.calls.find((c) => c.name === 'save-login').args.url, 'http://127.0.0.1:3000/login');
  assert.equal(existsSync(path.join(dir, SESSION)), false, 'the session made by this job is removed');

  // A failed login is reported and healing goes on, signed out.
  const lines = [];
  const s2 = await heal(healOpts(dir, healEngine(dir, { loginOk: false }), { login: { session: SESSION, steps: STEPS, check: CHECK }, log: (l) => lines.push(l) }));
  assert.equal(s2.signedIn, undefined);
  assert.ok(lines.some((l) => /Sign-in: Login failed/.test(l)), lines.join('\n'));
  assert.notEqual(s2.outcome, 'error');

  // A session the project already had is kept.
  mkdirSync(path.join(dir, 'playwright/.auth'), { recursive: true });
  writeFileSync(path.join(dir, SESSION), '{}');
  await heal(healOpts(dir, healEngine(dir), { login: { session: SESSION } }));
  assert.equal(existsSync(path.join(dir, SESSION)), true);
});
