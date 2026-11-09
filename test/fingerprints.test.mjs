// 0.6.0 smarter healing: element fingerprints, locator strength, one UI change one fix, live app.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  bestMatch,
  checkAppUrl,
  domFromTrace,
  elements,
  eventsFrom,
  fingerprintOf,
  fingerprintPath,
  learn,
  loadFingerprints,
  locatorChanges,
  locatorFor,
  lookup,
  parseSelector,
  prBody,
  readSnapshots,
  recordFromTrace,
  renderLocator,
  saveFingerprints,
  sourcePattern,
  startApp,
  strengthOf,
  uiChanges,
} from '../dist/index.js';

const enc = (lines) => Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n'));
const snap = (callId, phase, html, extra = {}) => ({ type: 'frame-snapshot', snapshot: { callId, phase, pageId: 'p1', frameId: 'f1', frameUrl: 'http://127.0.0.1:3000/login', html, ...extra } });

// The login page the way Playwright stores it: a full snapshot, then snapshots that reference it.
const LOGIN_OLD = ['HTML', {}, ['HEAD', {}, ['TITLE', {}, 'Login']], ['BODY', {}, ['H1', {}, 'Welcome back'], ['FORM', {}, ['LABEL', { for: 'email' }, 'Email'], ['INPUT', { id: 'email', type: 'email' }], ['BUTTON', { type: 'submit' }, 'Log in']]]];
// Post-order of LOGIN_OLD: "Login"0 TITLE1 HEAD2 "Welcome back"3 H1 4 "Email"5 LABEL6 INPUT7 "Log in"8 BUTTON9 FORM10 BODY11 HTML12

function greenTrace() {
  return new Map([
    [
      '0-trace.trace',
      enc([
        { type: 'before', callId: 'call@1', method: 'goto', params: { url: '/login' } },
        { type: 'after', callId: 'call@1' },
        snap('call@1', 'after', LOGIN_OLD),
        { type: 'before', callId: 'call@2', method: 'fill', params: { selector: 'internal:label="Email"i', value: 'ada@example.com' } },
        snap('call@2', 'before', [[1, 12]]),
        snap('call@2', 'action', ['HTML', {}, [[2, 2]], ['BODY', {}, [[2, 4]], ['FORM', {}, [[2, 6]], ['INPUT', { id: 'email', type: 'email', __playwright_target__: 'call@2' }], [[2, 9]]]]]),
        { type: 'after', callId: 'call@2' },
        { type: 'before', callId: 'call@3', method: 'click', params: { selector: 'internal:role=button[name="Log in"i]' } },
        snap('call@3', 'action', ['HTML', {}, [[3, 2]], ['BODY', {}, [[3, 4]], ['FORM', {}, [[3, 6]], [[3, 7]], ['BUTTON', { type: 'submit', __playwright_target__: '' }, 'Log in']]]]),
        { type: 'after', callId: 'call@3' },
      ]),
    ],
  ]);
}

/** The app renamed the button; the click times out (no "after"). */
function failedTrace() {
  return new Map([
    [
      '0-trace.trace',
      enc([
        { type: 'before', callId: 'call@1', method: 'goto', params: { url: '/login' } },
        { type: 'after', callId: 'call@1' },
        snap('call@1', 'after', ['HTML', {}, ['BODY', {}, ['H1', {}, 'Welcome back'], ['FORM', {}, ['LABEL', { for: 'email' }, 'Email'], ['INPUT', { id: 'email', type: 'email' }], ['BUTTON', { type: 'submit' }, 'Sign in']], ['A', { href: '/help' }, 'Help']]]),
        { type: 'before', callId: 'call@3', method: 'click', params: { selector: 'internal:role=button[name="Log in"i]' } },
        snap('call@3', 'before', [[1, 11]]),
      ]),
    ],
  ]);
}

test('snapshots: references to earlier snapshots are resolved like the trace viewer does', () => {
  const lines = greenTrace().get('0-trace.trace').toString().split('\n').map((l) => JSON.parse(l));
  const snaps = readSnapshots(lines);
  const before = snaps.find((s) => s.callId === 'call@2' && s.phase === 'before');
  assert.equal(before.root.tag, 'HTML');
  const tags = elements(before.root).map((e) => e.tag);
  assert.deepEqual(tags, ['HTML', 'HEAD', 'TITLE', 'BODY', 'H1', 'FORM', 'LABEL', 'INPUT', 'BUTTON']);
  const action = snaps.find((s) => s.callId === 'call@2' && s.phase === 'action');
  assert.equal(elements(action.root).find((e) => e.tag === 'LABEL').children[0], 'Email');
});

test('fingerprints: learned from each step that found its element', () => {
  const dom = domFromTrace(greenTrace());
  const entries = learn(dom, 'tests/login.spec.ts', '2026-11-04T00:00:00.000Z');
  assert.equal(entries.length, 2);
  const button = entries.find((e) => e.selector.startsWith('internal:role=button'));
  assert.deepEqual(button.fingerprint, { tag: 'BUTTON', role: 'button', name: 'Log in', text: 'Log in', type: 'submit', near: 'Welcome back' });
  assert.equal(button.page, '/login');
  const email = entries.find((e) => e.selector.startsWith('internal:label'));
  assert.equal(email.fingerprint.label, 'Email');
  assert.equal(email.fingerprint.id, 'email');
});

test('fingerprints: a renamed button is found again and gets the strongest locator', () => {
  const saved = learn(domFromTrace(greenTrace()))[1];
  const dom = domFromTrace(failedTrace());
  assert.equal(dom.failedCall.selector, 'internal:role=button[name="Log in"i]');
  assert.ok(dom.failedPage, 'the page at the failing click');
  const m = bestMatch(saved.fingerprint, elements(dom.failedPage.root), { action: true });
  assert.ok(m, 'matched');
  assert.equal(m.fingerprint.name, 'Sign in');
  const loc = locatorFor(m.element, dom.failedPage.root);
  assert.deepEqual(loc, { kind: 'role', value: 'button', name: 'Sign in' });
  assert.equal(renderLocator(loc, false), "getByRole('button', { name: 'Sign in' })");
  assert.equal(renderLocator(loc, true, '"'), 'get_by_role("button", name="Sign in")');
});

test('fingerprints: an assertion is never steered to another element by the value it checks', () => {
  // The test checks "$10" at #price. The app renamed #price and now shows $12 there,
  // while another plan happens to show $10. A text match would hide the regression.
  const page = ['HTML', {}, ['BODY', {}, ['SECTION', { 'aria-label': 'Pro' }, ['P', { id: 'price-pro', class: 'price' }, '$12']], ['SECTION', { 'aria-label': 'Basic' }, ['P', { id: 'price-basic', class: 'price' }, '$10']]]];
  const [s] = readSnapshots([snap('c', 'before', page)]);
  const saved = { tag: 'P', role: 'paragraph', text: '$10', id: 'price', near: 'Pro' };
  const m = bestMatch(saved, elements(s.root), { expected: '$10' });
  assert.notEqual(m?.fingerprint.id, 'price-basic', 'never the element that merely shows the expected value');
  // Same trap where only the text still matches: the guard leaves nothing to match on.
  const trap = { tag: 'P', role: 'paragraph', text: '$10', id: 'price' };
  assert.equal(bestMatch(trap, elements(s.root), { expected: '$10' }), null);
});

test('fingerprints: a test id that changed is matched by its other signals', () => {
  const page = ['HTML', {}, ['BODY', {}, ['NAV', {}, ['A', { href: '/cart', 'data-testid': 'cart-link-v2' }, 'Cart (2)']], ['A', { href: '/help' }, 'Help']]];
  const [s] = readSnapshots([snap('c', 'before', page)]);
  const saved = { tag: 'A', role: 'link', name: 'Cart (2)', text: 'Cart (2)', testId: 'cart-link', href: '/cart' };
  const m = bestMatch(saved, elements(s.root), { action: true });
  assert.equal(m?.fingerprint.href, '/cart');
  assert.ok(m.signals.includes('href'));
  // No clear winner: nothing.
  assert.equal(bestMatch({ tag: 'A', role: 'link', name: 'Gone' }, elements(s.root), {}), null);
});

test('fingerprints: stored one file per locator, named after its content, and read back', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-fp-'));
  const entries = learn(domFromTrace(greenTrace()), 'tests/login.spec.ts', '2026-11-04T00:00:00.000Z');
  const written = await saveFingerprints(root, entries);
  assert.equal(written.length, 2);
  for (const rel of written) assert.match(rel, /^\.autoheal\/fingerprints\/[0-9a-f]{16}\.json$/);
  const back = await loadFingerprints(root);
  assert.equal(back.length, 2);
  const hit = lookup(back, 'internal:role=button[name="Log in"i]', '/login');
  assert.equal(hit.fingerprint.name, 'Log in');
  assert.equal(fingerprintPath(hit.selector, hit.page), written.find((w) => w.endsWith(`${createHash('sha256').update(`${hit.selector}\n/login`).digest('hex').slice(0, 16)}.json`)));
});

test('locators: Playwright selectors are parsed and found in JS and Python source', () => {
  assert.deepEqual(parseSelector('internal:role=button[name="Log in"i]'), { kind: 'role', value: 'button', name: 'Log in' });
  assert.deepEqual(parseSelector('internal:testid=[data-testid="pro-price"s]'), { kind: 'testid', value: 'pro-price' });
  assert.deepEqual(parseSelector('internal:label="Email"s'), { kind: 'label', value: 'Email', exact: true });
  assert.deepEqual(parseSelector('#greeting'), { kind: 'css', value: '#greeting' });
  assert.deepEqual(parseSelector('internal:role=form >> internal:text="Save"i'), { kind: 'text', value: 'Save' });
  assert.equal(parseSelector('internal:has="x"'), null);

  const role = parseSelector('internal:role=button[name="Log in"i]');
  const js = "await page.getByRole('button', { name: 'Log in' }).click();\nawait page.getByRole(\"button\", {name: \"Log in\", exact: true}).click();";
  assert.equal([...js.matchAll(sourcePattern(role, false))].length, 2);
  const py = 'page.get_by_role("button", name="Log in").click()';
  assert.equal([...py.matchAll(sourcePattern(role, true))].length, 1);
  const css = parseSelector('#greeting');
  assert.equal([..."this.greeting = page.locator('#greeting');".matchAll(sourcePattern(css, false))].length, 1);
  assert.equal([..."page.locator('#greeting-2')".matchAll(sourcePattern(css, false))].length, 0);
  // Quotes inside names are escaped in the output.
  assert.equal(renderLocator({ kind: 'role', value: 'button', name: "Don't" }, false), "getByRole('button', { name: 'Don\\'t' })");
});

test('locators: strength follows Playwright, and the PR says whether a fix made a locator weaker', () => {
  assert.equal(strengthOf("getByRole('button', { name: 'Save' })"), 'strong');
  assert.equal(strengthOf("getByLabel('Email')"), 'strong');
  assert.equal(strengthOf("getByTestId('save')"), 'good');
  assert.equal(strengthOf("locator('#save')"), 'fair');
  assert.equal(strengthOf("locator('div.card > button:nth-child(2)')"), 'weak');
  const [c] = locatorChanges("  this.greeting = page.locator('#greeting');", "  this.greeting = page.getByText('Hello, Ada');");
  assert.equal(c.from, 'fair');
  assert.equal(c.to, 'good');
  assert.equal(c.direction, 1);
  const [w] = locatorChanges("page.getByRole('button', { name: 'Save' })", "page.locator('.btn-primary')");
  assert.equal(w.direction, -1);
});

test('locators: the strongest unique locator wins, CSS id last', () => {
  const page = ['HTML', {}, ['BODY', {}, ['DIV', { id: 'welcome-message' }, 'Hello, Ada'], ['DIV', { 'data-testid': 'x' }, ['SPAN', {}, 'one'], ['SPAN', {}, 'one']], ['INPUT', { id: 'q', placeholder: 'Search' }]]];
  const [s] = readSnapshots([snap('c', 'before', page)]);
  const all = elements(s.root);
  assert.deepEqual(locatorFor(all.find((e) => e.attrs.id === 'welcome-message'), s.root), { kind: 'text', value: 'Hello, Ada', exact: true });
  assert.deepEqual(locatorFor(all.find((e) => e.attrs['data-testid'] === 'x'), s.root), { kind: 'testid', value: 'x' });
  assert.deepEqual(locatorFor(all.find((e) => e.attrs.id === 'q'), s.root), { kind: 'role', value: 'textbox', name: 'Search' });
  assert.equal(fingerprintOf(all.find((e) => e.attrs.id === 'q')).placeholder, 'Search');
});

test('one UI change, one fix: the PR groups the tests one change fixed', () => {
  const base = { category: 'TEST_BUG', rootCause: 'LOCATOR_DRIFT', confidence: 0.9, reasons: [], spend: { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true } };
  const results = [
    { ...base, failure: { index: 1, file: 'a.spec.ts', title: 'checkout', kind: 'timeout', message: '' }, status: 'FIXED', summary: '', fix: { by: 'fingerprint', file: 'pages/cart.ts', explanation: 'x', diff: '-a\n+b', locators: [{ before: "getByRole('button', { name: 'Buy' })", after: "getByRole('button', { name: 'Buy now' })", from: 'strong', to: 'strong', direction: 0 }], match: { score: 0.7, signals: ['role', 'near'] } } },
    { ...base, failure: { index: 2, file: 'b.spec.ts', title: 'guest checkout', kind: 'timeout', message: '' }, status: 'FIXED', summary: '', fix: { by: 'same-change', file: 'pages/cart.ts', explanation: 'y', diff: '-a\n+b', sameAs: 'checkout' } },
  ];
  const lines = uiChanges(results).join('\n');
  assert.match(lines, /One UI change, one fix/);
  assert.match(lines, /fixed 2 tests: checkout; guest checkout/);
  const body = prBody({ tool: 'autoheal-ai', version: '0.6.0', startedAt: '', finishedAt: '', mode: 'draft-pr', provider: 'none', model: 'none', outcome: 'fixed', changes: true, changedFiles: [], results, totalFailures: 2, skippedFailures: 0, spend: base.spend, minutesSaved: 0, fingerprints: 3, app: 'started with `npm start` at http://localhost:3000' });
  assert.match(body, /element fingerprint, no AI tokens/);
  assert.match(body, /same UI change as another test, no AI tokens/);
  assert.match(body, /Fingerprint match: 70%/);
  assert.match(body, /Element fingerprints: 3 saved/);
  assert.match(body, /Live app: started with/);
  // Dashboards from before 0.6.0 accept only rules and ai.
  const events = eventsFrom({ results, run: {}, provider: 'none', model: 'none' });
  assert.deepEqual(events.map((e) => e.fix_by), ['rules', 'rules']);
});

test('one UI change, one fix: two different changes in one commit are not grouped', () => {
  const base = { category: 'TEST_BUG', rootCause: 'LOCATOR_DRIFT', confidence: 0.9, reasons: [], spend: { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true }, status: 'FIXED', summary: '' };
  const cause = { commit: 'f3085e6', short: 'f3085e6', subject: 'Shop redesign', files: ['app/server.mjs'], evidence: '', author: 'Dev', date: '2026-11-09' };
  const loc = (before, after) => [{ before, after, from: 'strong', to: 'strong', direction: 0 }];
  const results = [
    { ...base, cause, failure: { index: 1, file: 'cart.spec.ts', title: 'add a mug', kind: 'timeout', message: '' }, fix: { by: 'fingerprint', file: 'tests/cart.spec.ts', explanation: '', diff: '', locators: loc("getByTestId('add-mug')", "getByRole('button', { name: 'Add to cart' })") } },
    { ...base, cause, failure: { index: 2, file: 'login.spec.ts', title: 'user can log in', kind: 'timeout', message: '' }, fix: { by: 'fingerprint', file: 'tests/login.spec.ts', explanation: '', diff: '', locators: loc("getByRole('button', { name: 'Log in' })", "getByRole('button', { name: 'Sign in' })") } },
  ];
  assert.deepEqual(uiChanges(results), []);
});

test('runtime guard: newer traces mark the snapshot phase in "phase", and the page check reads it', () => {
  const entries = new Map([
    ['test.trace', enc([{ type: 'before', stepId: 's1', method: 'pw:api', title: 'Click', params: {} }])],
    ['0-trace.trace', enc([{ type: 'before', callId: 'c1', stepId: 's1' }, snap('c1', 'before', ['HTML', {}], { frameUrl: 'http://127.0.0.1:3000/cart?x=1' })])],
  ]);
  assert.equal(recordFromTrace(entries).steps[0].page, 'http://127.0.0.1:3000/cart');
});

test('live app: only this machine, and the app is started, awaited and stopped', async () => {
  assert.throws(() => checkAppUrl('https://example.com'), /this machine/);
  assert.throws(() => checkAppUrl('file:///etc/passwd'), /http/);
  assert.equal(checkAppUrl('http://127.0.0.1:4321/').port, '4321');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ah-app-'));
  mkdirSync(path.join(dir, 'app'));
  writeFileSync(path.join(dir, 'app', 'server.mjs'), "import http from 'node:http'; http.createServer((q, r) => r.end(process.env.ANTHROPIC_API_KEY ? 'leak' : 'ok')).listen(Number(process.env.PORT), '127.0.0.1');");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const app = await startApp({ command: `PORT=${port} node app/server.mjs`, url: `http://127.0.0.1:${port}/`, cwd: dir, timeoutMs: 20_000, env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const body = await (await fetch(app.url)).text();
  assert.equal(body, 'ok', 'the app does not get the AI key');
  await app.stop();
  await assert.rejects(fetch(app.url, { signal: AbortSignal.timeout(2000) }));
  await assert.rejects(startApp({ command: 'exit 3', url: `http://127.0.0.1:${port + 1}/`, cwd: dir, timeoutMs: 10_000 }), /exited before/);
});

test('publish job: accepts fingerprint files only in their exact shape, named after their content', async () => {
  const { Refused, checkFiles, checkFingerprint } = await import('../scripts/publish.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-pub-fp-'));
  const entry = learn(domFromTrace(greenTrace()), 'tests/login.spec.ts', '2026-11-04T00:00:00.000Z')[1];
  const [rel] = await saveFingerprints(root, [entry]);
  assert.doesNotThrow(() => checkFingerprint(root, rel));
  assert.doesNotThrow(() => checkFiles(root, [{ path: rel, isNew: false }], null));
  const write = (obj) => writeFileSync(path.join(root, rel), JSON.stringify(obj));
  write({ ...entry, selector: 'internal:role=button[name="Other"i]' });
  assert.throws(() => checkFingerprint(root, rel), /does not match its content/);
  write({ ...entry, script: 'x' });
  assert.throws(() => checkFingerprint(root, rel), /unexpected fields/);
  write({ ...entry, fingerprint: { ...entry.fingerprint, onclick: 'x' } });
  assert.throws(() => checkFingerprint(root, rel), /unexpected fingerprint fields/);
  write({ ...entry, fingerprint: { ...entry.fingerprint, name: 'x'.repeat(500) } });
  assert.throws(() => checkFingerprint(root, rel), Refused);
  const many = Array.from({ length: 61 }, (_, i) => ({ path: `.autoheal/fingerprints/${i.toString(16).padStart(16, '0')}.json`, isNew: true }));
  assert.throws(() => checkFiles(root, many, null), /too many fingerprint files/);
});
