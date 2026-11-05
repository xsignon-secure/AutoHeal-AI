import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CypressTools,
  ScriptedProvider,
  cypressKind,
  cypressValues,
  frameworkSetting,
  heal,
  isCypressProject,
  matchScreenshot,
  parseCypressReport,
  scanChange,
  specPath,
  systemPrompt,
  triage,
} from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" time="5.1" tests="3" failures="2">
  <testsuite name="Root Suite" timestamp="2026-11-05T10:00:00" tests="0" file="cypress/e2e/login.cy.js" time="0.000" failures="0">
  </testsuite>
  <testsuite name="login" timestamp="2026-11-05T10:00:00" tests="3" time="5.1" failures="2">
    <testcase name="login user can log in" time="4.2" classname="user can log in">
      <failure message="Timed out retrying after 4000ms: Expected to find element: \`[data-cy=login]\`, but never found it." type="AssertionError"><![CDATA[AssertionError: Timed out retrying after 4000ms: Expected to find element: \`[data-cy=login]\`, but never found it.
    at Context.eval (webpack://shop/./cypress/e2e/login.cy.js:6:8)]]></failure>
    </testcase>
    <testcase name="login shows the price" time="0.5" classname="shows the price">
      <failure message="Timed out retrying after 4000ms: expected &apos;&lt;p.price&gt;&apos; to have text &apos;$10&apos;, but the text was &apos;$12&apos;" type="AssertionError"><![CDATA[AssertionError: ...
    at Context.eval (webpack://shop/./cypress/e2e/login.cy.js:11:25)]]></failure>
    </testcase>
    <testcase name="login has a title" time="0.4" classname="has a title"></testcase>
  </testsuite>
</testsuites>`;

test('JUnit from Cypress: file from the Root Suite, full titles, messages, lines, values', () => {
  const tests = parseCypressReport(JUNIT);
  assert.equal(tests.length, 3);
  assert.deepEqual(
    tests.map((t) => [t.file, t.title, t.state]),
    [
      ['cypress/e2e/login.cy.js', 'login user can log in', 'failed'],
      ['cypress/e2e/login.cy.js', 'login shows the price', 'failed'],
      ['cypress/e2e/login.cy.js', 'login has a title', 'passed'],
    ],
  );
  assert.match(tests[0].stack, /login\.cy\.js:6:8/);
  assert.equal(cypressValues(tests[1].message).expected, '$10');
  assert.equal(cypressValues(tests[1].message).actual, '$12');
});

test('mochawesome and cypress.run() results parse to the same tests', () => {
  const mocha = parseCypressReport(
    JSON.stringify({
      stats: { tests: 2 },
      results: [{ file: 'cypress/e2e/a.cy.ts', suites: [{ title: 'cart', tests: [{ title: 'adds', fullTitle: 'cart adds', state: 'failed', fail: true, err: { message: 'AssertionError: expected 2 to equal 3', estack: 'AssertionError: expected 2 to equal 3\n at a.cy.ts:9:3' } }, { title: 'ok', fullTitle: 'cart ok', state: 'passed', pass: true }], suites: [] }] }],
    }),
  );
  assert.deepEqual(mocha.map((t) => [t.file, t.title, t.state]), [['cypress/e2e/a.cy.ts', 'cart adds', 'failed'], ['cypress/e2e/a.cy.ts', 'cart ok', 'passed']]);
  const mod = parseCypressReport(JSON.stringify({ runs: [{ spec: { relative: 'cypress/e2e/a.cy.ts' }, tests: [{ title: ['cart', 'adds'], state: 'failed', displayError: 'boom' }], screenshots: [{ path: 'cypress/screenshots/a.cy.ts/cart -- adds (failed).png' }] }] }));
  assert.equal(mod[0].title, 'cart adds');
  assert.equal(mod[0].screenshot, 'cypress/screenshots/a.cy.ts/cart -- adds (failed).png');
  assert.equal(parseCypressReport('{"suites": []}'), null);
  assert.equal(parseCypressReport('<html></html>'), null);
});

test('Cypress messages: kinds, values and triage', () => {
  const notFound = 'Timed out retrying after 4000ms: Expected to find element: `#greeting`, but never found it.';
  assert.equal(cypressKind(notFound), 'timeout');
  assert.equal(triage({ kind: 'timeout', message: notFound }).rootCause, 'LOCATOR_DRIFT');
  const contains = "Timed out retrying after 4000ms: Expected to find content: 'Log in' within the selector: 'button' but never did.";
  assert.equal(triage({ kind: cypressKind(contains), message: contains }).category, 'TEST_BUG');
  const text = "Timed out retrying after 4000ms: expected '<p#msg>' to have text 'Signed in as ada', but the text was 'Signed in'";
  assert.equal(cypressKind(text), 'assertion');
  const v = cypressValues(text);
  assert.deepEqual(v, { expected: 'Signed in as ada', actual: 'Signed in' });
  assert.equal(triage({ kind: 'assertion', message: text, ...v }).category, 'APP_BUG');
  assert.deepEqual(cypressValues("AssertionError: expected 'B' to equal 'A'"), { expected: 'A', actual: 'B' });
  assert.equal(cypressKind('Cypress could not verify that this server is running: http://localhost:3000'), 'server-unreachable');
  assert.equal(triage({ kind: 'server-unreachable', message: 'x' }).category, 'ENV');
  assert.equal(cypressKind('Error: Webpack Compilation Error\nModule not found'), 'syntax');
  const covered = 'cy.click() failed because this element: <button> is being covered by another element: <div>';
  assert.equal(triage({ kind: cypressKind(covered), message: covered }).rootCause, 'HYDRATION_RACE');
  const many = 'cy.click() can only be called on a single element. Your subject contained 2 elements.';
  assert.equal(triage({ kind: cypressKind(many), message: many }).rootCause, 'LOCATOR_DRIFT');
});

test('framework setting, project detection, spec paths and screenshots', async () => {
  assert.equal(frameworkSetting(undefined), 'auto');
  assert.equal(frameworkSetting('Cypress'), 'cypress');
  assert.throws(() => frameworkSetting('jest'), /framework must be/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-cy-detect-'));
  assert.equal(await isCypressProject(dir), false);
  writeFileSync(path.join(dir, 'cypress.config.js'), 'module.exports = {};\n');
  assert.equal(await isCypressProject(dir), true);
  writeFileSync(path.join(dir, 'playwright.config.ts'), 'export default {};\n');
  assert.equal(await isCypressProject(dir), false, 'a Playwright config wins');
  assert.equal(specPath('/repo', '/home/runner/work/shop/shop/cypress/e2e/a.cy.js'), 'cypress/e2e/a.cy.js');
  assert.equal(specPath('/repo', '/repo/cypress/e2e/a.cy.js'), 'cypress/e2e/a.cy.js');
  assert.equal(specPath('/repo', './cypress/e2e/a.cy.js'), 'cypress/e2e/a.cy.js');
  const shots = ['cypress/screenshots/a.cy.js/cart -- adds (failed).png', 'cypress/screenshots/a.cy.js/cart -- ok.png'];
  assert.equal(matchScreenshot(shots, { file: 'cypress/e2e/a.cy.js', title: 'cart adds', state: 'failed' }), shots[0]);
  assert.equal(matchScreenshot(shots, { file: 'cypress/e2e/a.cy.js', title: 'cart ok', state: 'failed' }), undefined);
});

const SPEC = `describe('login', () => {
  it('user can log in', () => {
    cy.visit('/login');
    cy.get('#email').type('ada@example.com');
    cy.contains('button', 'Log in').click();
    cy.get('#msg').should('have.text', 'Signed in as ada@example.com');
  });
});
`;

test('anti-cheat on Cypress specs: locator changes pass, everything else is blocked', () => {
  const pass = (after) => assert.equal(scanChange(SPEC, after, 'cypress/e2e/login.cy.js').verdict, 'PASS', after);
  const verdict = (after) => scanChange(SPEC, after, 'cypress/e2e/login.cy.js');
  pass(SPEC.replace("cy.contains('button', 'Log in')", "cy.contains('button', 'Sign in')"));
  pass(SPEC.replace("cy.get('#email')", 'cy.get(\'[data-cy="email"]\')'));
  pass(SPEC.replace("cy.get('#msg')", "cy.get('#welcome').find('p')"));
  const rules = (after) => verdict(after).findings.map((f) => f.rule);
  assert.ok(rules(SPEC.replace("'Signed in as ada@example.com'", "'Signed in'")).includes('expectation-changed'));
  assert.ok(rules(SPEC.replace(".should('have.text', 'Signed in as ada@example.com')", '')).includes('assertion-removed'));
  assert.ok(rules(SPEC.replace("it('user", "it.skip('user")).includes('skip-added'));
  assert.ok(rules(SPEC.replace("it('user", "xit('user")).includes('skip-added'));
  assert.ok(rules(SPEC.replace("cy.visit('/login');", "cy.visit('/login');\n    cy.intercept('POST', '/api/login', { ok: true });")).includes('app-tampered'));
  assert.ok(rules(SPEC.replace("cy.get('#msg')", "cy.get('#msg').invoke('text', 'Signed in as ada@example.com')")).includes('app-tampered'));
  assert.ok(rules(SPEC.replace("cy.visit('/login');", "cy.on('uncaught:exception', () => false);\n    cy.visit('/login');")).includes('swallowed-error'));
  assert.ok(rules(SPEC.replace("cy.visit('/login')", "cy.visit('/signin')")).includes('navigation-changed'));
  assert.ok(rules(SPEC.replace("cy.visit('/login');", "cy.visit('/login');\n    cy.exec('cat ~/.ssh/id_rsa');")).includes('unsafe-code'));
  assert.ok(rules(SPEC.replace("cy.visit('/login');", "cy.visit('/login');\n    Cypress.config('defaultCommandTimeout', 60000);")).includes('config-changed'));
  assert.ok(rules(SPEC.replace(".click()", '.click({ force: true })')).includes('force-action'));
  assert.ok(rules(SPEC.replace("cy.visit('/login');", "cy.visit('/login');\n    cy.wait(3000);")).includes('fixed-wait'));
  assert.ok(rules(SPEC.replace(".type('ada@example.com')", ".type('ada@example.com').clear()")).includes('action-changed'));
  // The text an assertion is about is content: cy.contains(...).should(...) keeps its text.
  const asserted = "describe('x', () => {\n  it('y', () => {\n    cy.visit('/');\n    cy.contains('Welcome back').should('be.visible');\n  });\n});\n";
  assert.ok(scanChange(asserted, asserted.replace('Welcome back', 'Hello'), 'a.cy.js').findings.some((f) => f.rule === 'assertion-retargeted'));
  // chai in a .then(): the expected value is protected too.
  const chai = "describe('x', () => {\n  it('y', () => {\n    cy.get('#n').then(($el) => {\n      expect($el.text()).to.equal('3');\n    });\n  });\n});\n";
  assert.ok(scanChange(chai, chai.replace("to.equal('3')", "to.equal('4')"), 'a.cy.js').findings.some((f) => f.rule === 'expectation-changed'));
});

test('the AI gets Cypress advice for Cypress projects only', () => {
  assert.match(systemPrompt('cypress'), /This is a Cypress test/);
  assert.doesNotMatch(systemPrompt('playwright'), /Cypress/);
});

/** A Cypress project whose `cypress` package is the fake in test/fake-cypress. */
function cypressProject(elements) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-cy-'));
  writeFileSync(path.join(dir, 'package.json'), '{"name":"shop","private":true}\n');
  writeFileSync(path.join(dir, 'cypress.config.js'), 'module.exports = { e2e: { baseUrl: "http://localhost:3000" } };\n');
  mkdirSync(path.join(dir, 'cypress', 'e2e'), { recursive: true });
  writeFileSync(path.join(dir, 'cypress', 'e2e', 'login.cy.js'), SPEC);
  writeFileSync(
    path.join(dir, 'cypress', 'e2e', 'price.cy.js'),
    "describe('pricing', () => {\n  it('pro plan price', () => {\n    cy.visit('/pricing');\n    cy.get('[data-cy=pro-price]').should('have.text', '$10');\n  });\n});\n",
  );
  cpSync(path.join(here, 'fake-cypress'), path.join(dir, 'node_modules', 'cypress'), { recursive: true });
  writeFileSync(path.join(dir, 'fake-app.json'), JSON.stringify({ elements }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

const APP = { '#email': '', 'button[type=submit]': 'Sign in', '#msg': 'Signed in as ada@example.com', '[data-cy=pro-price]': '$12' };

test('CypressTools runs specs through the runner script and reports matching tests', async () => {
  const dir = cypressProject(APP);
  const tools = new CypressTools(dir, { env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-secret' } });
  const run = await tools.call('run-test', { testFiles: ['cypress/e2e/login.cy.js', 'cypress/e2e/price.cy.js'], retries: 0 });
  assert.equal(run.data.run.failed, 2);
  assert.deepEqual(run.data.run.failures.map((f) => f.title).sort(), ['login user can log in', 'pricing pro plan price']);
  const one = await tools.call('run-test', { testFiles: ['cypress/e2e/price.cy.js'], grep: 'pricing pro plan price' });
  assert.equal(one.data.run.failed, 1);
  assert.match(one.text, /to have text '\$10', but the text was '\$12'/);
  const outside = await tools.call('run-test', { testFiles: ['../elsewhere.cy.js'] });
  assert.equal(outside.ok, false);
  assert.equal((await tools.call('quarantine', { action: 'add' })).ok, false);
  assert.equal((await tools.call('check-test-change', { file: 'x', after: 'y' })).ok, false, 'per-file checks fall back to the strict local scan');
  await tools.close();
});

test('heal on a Cypress project: the AI fix is guarded and rerun; the price change is an app bug', async () => {
  const dir = cypressProject(APP);
  // The failed CI run, as Cypress's junit reporter writes it.
  const tools = new CypressTools(dir);
  const ci = await tools.runSpecs(['cypress/e2e/login.cy.js', 'cypress/e2e/price.cy.js'], 60_000);
  mkdirSync(path.join(dir, 'autoheal-artifacts'));
  writeFileSync(path.join(dir, 'autoheal-artifacts', 'results.json'), JSON.stringify({ runs: [{ spec: 'cypress/e2e/login.cy.js', tests: ci.tests.filter((t) => t.file.endsWith('login.cy.js')).map((t) => ({ title: t.title.split(' '), state: t.state, displayError: t.message })) }] }));
  const priceXml = `<testsuites name="Mocha Tests"><testsuite name="Root Suite" file="cypress/e2e/price.cy.js"></testsuite><testsuite name="pricing">
<testcase name="pricing pro plan price" classname="pro plan price"><failure message="Timed out retrying after 4000ms: expected &apos;&lt;p&gt;&apos; to have text &apos;$10&apos;, but the text was &apos;$12&apos;" type="AssertionError"/></testcase>
<testcase name="pricing other" classname="other"/></testsuite></testsuites>`;
  writeFileSync(path.join(dir, 'autoheal-artifacts', 'price.xml'), priceXml);
  writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'autoheal-artifacts/\n.fake-cypress-runs\n');
  const fixed = SPEC.replace("cy.contains('button', 'Log in')", "cy.contains('button', 'Sign in')");
  const cheat = SPEC.replace(".should('have.text', 'Signed in as ada@example.com')", '');
  const provider = new ScriptedProvider([
    { calls: [{ name: 'read_file', input: { path: 'cypress/e2e/login.cy.js' } }] },
    { calls: [{ name: 'propose_fix', input: { path: 'cypress/e2e/login.cy.js', content: cheat, explanation: 'drop the check' } }] },
    { calls: [{ name: 'propose_fix', input: { path: 'cypress/e2e/login.cy.js', content: fixed, explanation: 'The button now says Sign in.' } }] },
  ]);
  const s = await heal({
    projectRoot: dir,
    report: 'autoheal-artifacts',
    mode: 'draft-pr',
    maxFailures: 5,
    repeatEach: 5,
    quarantineDays: 14,
    allowWarn: false,
    checkFlaky: false,
    flakyRuns: 3,
    budget: { maxSteps: 20, maxTokens: 1e6, maxUsd: 1 },
    provider,
  });
  assert.equal(s.framework, 'cypress');
  assert.equal(s.totalFailures, 2, 'one from the junit file and one from the results file');
  const login = s.results.find((r) => r.failure.title === 'login user can log in');
  assert.equal(login.status, 'FIXED', JSON.stringify(login, null, 1));
  assert.equal(login.fix.by, 'ai');
  assert.equal(login.stability.runs, 3, 'Cypress fixes pass 3 separate runs');
  assert.equal(login.runtime.checked, false);
  assert.equal(login.guard.engine, 'UNAVAILABLE', 'per-file checks use the strict local scan');
  assert.equal(readFileSync(path.join(dir, 'cypress/e2e/login.cy.js'), 'utf8'), fixed);
  assert.match(provider.requests[0].system, /This is a Cypress test/);
  const price = s.results.find((r) => r.failure.title === 'pricing pro plan price');
  assert.equal(price.status, 'APP_BUG');
  assert.equal(price.failure.expected, '$10');
  assert.equal(readFileSync(path.join(dir, 'cypress/e2e/price.cy.js'), 'utf8').includes("'$10'"), true);
});
