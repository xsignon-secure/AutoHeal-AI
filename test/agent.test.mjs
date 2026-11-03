import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Budget, ScriptedProvider, aiFix, aiTriage, relativeImports, safePath } from '../dist/index.js';

function project() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-agent-'));
  mkdirSync(path.join(dir, 'tests'));
  mkdirSync(path.join(dir, 'pages'));
  writeFileSync(path.join(dir, 'tests', 'a.spec.ts'), "import { P } from '../pages/p';\ntest('a', async () => { expect(1).toBe(1); });\n");
  writeFileSync(path.join(dir, 'pages', 'p.ts'), 'export class P {}\n');
  writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  return dir;
}

const failure = { index: 1, file: 'tests/a.spec.ts', title: 'a', kind: 'assertion', message: 'boom', detail: '## Failure' };
const triage = { category: 'TEST_BUG', rootCause: 'LOCATOR_DRIFT', confidence: 0.8, reasons: ['x'] };
const fakeMcp = { call: async () => ({ ok: true, isError: false, text: '', data: {} }), close: async () => {} };
const budget = () => new Budget({ maxSteps: 20, maxTokens: 1e6, maxUsd: 10 }, null);

test('safePath keeps paths inside the project and away from secrets', () => {
  const root = '/proj';
  assert.equal(safePath(root, 'tests/a.ts'), path.resolve('/proj/tests/a.ts'));
  assert.equal(safePath(root, '../etc/passwd'), null);
  assert.equal(safePath(root, '/etc/passwd'), null);
  assert.equal(safePath(root, '.env'), null);
  assert.equal(safePath(root, '.env.local'), null);
  assert.equal(safePath(root, 'node_modules/x/index.js'), null);
  assert.equal(safePath(root, '.git/config'), null);
  assert.equal(safePath(root, ''), null);
});

test('relativeImports finds page objects in TS and Python', () => {
  const ts = relativeImports('tests/a.spec.ts', "import { P } from '../pages/p';\nconst h = require('./helpers.js');");
  assert.ok(ts.includes('pages/p.ts'));
  assert.ok(ts.includes('tests/helpers.ts'));
  const py = relativeImports('tests/test_a.py', 'from .pages.login import LoginPage\n');
  assert.ok(py.includes('tests/pages/login.py'));
});

test('aiFix: reads, proposes, and returns the kept fix', async () => {
  const dir = project();
  const provider = new ScriptedProvider([
    { calls: [{ name: 'read_file', input: { path: 'tests/a.spec.ts' } }] },
    { calls: [{ name: 'propose_fix', input: { path: 'pages/p.ts', content: 'export class P { x = 1 }\n', explanation: 'renamed' } }] },
  ]);
  const verified = [];
  const r = await aiFix({ mcp: fakeMcp, provider, projectRoot: dir, failure, triage, memory: 'none', budget: budget(), verify: async (file, content) => (verified.push(file), { kept: true, blocked: false, message: 'kept', stability: { runs: 5, passed: true, detail: '' } }) });
  assert.equal(r.result, 'fixed');
  assert.equal(r.file, 'pages/p.ts');
  assert.deepEqual(verified, ['pages/p.ts']);
  assert.match(provider.requests[1].turns[2].parts[0].content, /import \{ P \}/, 'file content returned to the model');
});

test('aiFix: refuses files outside the test and its imports, and paths outside the project', async () => {
  const dir = project();
  const provider = new ScriptedProvider([
    { calls: [{ name: 'read_file', input: { path: '../../etc/passwd' } }, { name: 'propose_fix', input: { path: 'secret.txt', content: 'x', explanation: 'x' } }] },
    { calls: [{ name: 'give_up', input: { reason: 'app is broken' } }] },
  ]);
  let verifyCalls = 0;
  const r = await aiFix({ mcp: fakeMcp, provider, projectRoot: dir, failure, triage, memory: '', budget: budget(), verify: async () => (verifyCalls++, { kept: true, blocked: false, message: '' }) });
  assert.equal(r.result, 'gave-up');
  assert.equal(verifyCalls, 0);
  const results = provider.requests[1].turns[2].parts;
  assert.ok(results[0].isError && /outside the project/.test(results[0].content));
  assert.ok(results[1].isError && /may only change/.test(results[1].content));
});

test('aiFix: two blocked proposals stop the loop as blocked', async () => {
  const dir = project();
  const propose = { calls: [{ name: 'propose_fix', input: { path: 'tests/a.spec.ts', content: 'cheat', explanation: 'x' } }] };
  const provider = new ScriptedProvider([propose, propose, propose]);
  const r = await aiFix({ mcp: fakeMcp, provider, projectRoot: dir, failure, triage, memory: '', budget: budget(), verify: async () => ({ kept: false, blocked: true, message: 'assertion removed', guard: { engine: 'BLOCK', local: 'BLOCK', findings: [] } }) });
  assert.equal(r.result, 'blocked');
  assert.equal(r.blockedAttempts, 2);
  assert.equal(provider.requests.length, 2);
});

test('aiFix: stops at the budget', async () => {
  const dir = project();
  const provider = new ScriptedProvider(Array.from({ length: 10 }, () => ({ calls: [{ name: 'read_file', input: { path: 'tests/a.spec.ts' } }], usage: { inputTokens: 1000, outputTokens: 0 } })));
  const r = await aiFix({ mcp: fakeMcp, provider, projectRoot: dir, failure, triage, memory: '', budget: new Budget({ maxSteps: 3, maxTokens: 1e6, maxUsd: 1 }, null), verify: async () => ({ kept: false, blocked: false, message: '' }) });
  assert.equal(r.result, 'budget');
  assert.equal(provider.requests.length, 3);
});

test('aiFix: a model that stops without a tool call ends with no-proposal', async () => {
  const dir = project();
  const r = await aiFix({ mcp: fakeMcp, provider: new ScriptedProvider([{ text: 'I think it is fine.' }]), projectRoot: dir, failure, triage, memory: '', budget: budget(), verify: async () => ({ kept: false, blocked: false, message: '' }) });
  assert.equal(r.result, 'no-proposal');
});

test('aiTriage: refines a low-confidence call but caps the confidence; bad output leaves it alone', async () => {
  const low = { category: 'APP_BUG', rootCause: 'UNKNOWN', confidence: 0.35, reasons: ['no signal'] };
  const moved = await aiTriage(new ScriptedProvider([{ text: '{"category":"TEST_BUG","rootCause":"TIMING","reason":"waits for nothing"}' }]), budget(), failure, low);
  assert.equal(moved.category, 'TEST_BUG');
  assert.equal(moved.confidence, 0.6);
  const same = await aiTriage(new ScriptedProvider([{ text: 'no json here' }]), budget(), failure, low);
  assert.deepEqual(same, low);
  const bogus = await aiTriage(new ScriptedProvider([{ text: '{"category":"DELETE_IT"}' }]), budget(), failure, low);
  assert.deepEqual(bogus, low);
});

test('aiTriage: the model can never call a failure FLAKY (only real reruns can)', async () => {
  const low = { category: 'APP_BUG', rootCause: 'UNKNOWN', confidence: 0.35, reasons: ['no signal'] };
  const r = await aiTriage(new ScriptedProvider([{ text: '{"category":"FLAKY","rootCause":"TIMING","reason":"looks flaky"}' }]), budget(), failure, low);
  assert.deepEqual(r, low);
});

test('aiFix: live page tools only open the app, not other sites', async () => {
  const dir = project();
  const opened = [];
  const mcp = { call: async (name, args) => (opened.push(args.url), { ok: true, isError: false, text: 'page', data: {} }), close: async () => {} };
  const provider = new ScriptedProvider([
    { calls: [{ name: 'inspect_page', input: { url: 'https://evil.example/?leak=1' } }, { name: 'inspect_page', input: { url: '/login' } }] },
    { calls: [{ name: 'give_up', input: { reason: 'done' } }] },
  ]);
  await aiFix({ mcp, provider, projectRoot: dir, failure, triage, memory: '', budget: budget(), appUrl: 'http://localhost:3000', verify: async () => ({ kept: false, blocked: false, message: '' }) });
  assert.deepEqual(opened, ['http://localhost:3000/login']);
  assert.match(provider.requests[1].turns[2].parts[0].content, /Only pages of http:\/\/localhost:3000/);
});

test('engineEnv: tests never see the AI key, dashboard secret or runner tokens', async () => {
  const { engineEnv } = await import('../dist/index.js');
  const env = { PATH: '/bin', CI: '1', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', AUTOHEAL_DASHBOARD_SECRET: 's', GITHUB_TOKEN: 'g', GH_TOKEN: 'h', ACTIONS_RUNTIME_TOKEN: 'r', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'i', BASE_URL: 'http://app' };
  assert.deepEqual(Object.keys(engineEnv(env, false)).sort(), ['BASE_URL', 'CI', 'PATH']);
  assert.ok('GITHUB_TOKEN' in engineEnv(env, true), 'kept only to download a CI run by URL');
  assert.ok(!('ANTHROPIC_API_KEY' in engineEnv(env, true)));
});
