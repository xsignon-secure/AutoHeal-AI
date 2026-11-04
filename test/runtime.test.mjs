// 0.4.0 Guard v2: what the test did at runtime, before and after a fix.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { compareRuns, findTrace, frameAt, prBody, recordFromFile, recordFromTrace, readZip } from '../dist/index.js';

/** Builds a zip (deflated entries) the way Playwright writes trace.zip. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.from(content).length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.from(content).length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const traceLines = (events) => events.map((e) => JSON.stringify(e)).join('\n');

const L = (events) => events.map((e) => JSON.stringify(e)).join('\n');

/**
 * A run: steps like [{ kind:'nav', url }, { kind:'click', target, box, url }, { kind:'expect', target, expected, url, fail }].
 * Produces the test.trace + 0-trace.trace pair Playwright 1.63 writes.
 */
function run(steps, title = 'login.spec.ts:4 › user can log in') {
  const test = [];
  const lib = [{ type: 'context-options', title }];
  steps.forEach((s, i) => {
    const stepId = s.kind === 'expect' ? `expect@${i}` : `pw:api@${i}`;
    const callId = `call@${i}`;
    if (s.kind === 'expect') {
      test.push({ type: 'before', stepId, method: 'expect', title: s.title ?? 'Expect "toHaveText"', params: { locator: s.target, expected: s.expected } });
    } else {
      test.push({ type: 'before', stepId, method: 'pw:api', title: s.kind === 'nav' ? 'Navigate' : s.title ?? 'Click', subtitle: s.target, params: s.kind === 'nav' ? { url: s.url } : {} });
    }
    test.push(s.fail ? { type: 'after', callId: stepId, error: { message: 'boom' } } : { type: 'after', callId: stepId });
    lib.push({ type: 'before', callId, stepId });
    if (s.url) lib.push({ type: 'frame-snapshot', snapshot: { callId, snapshotName: `before@${callId}`, frameUrl: s.url } });
    if (s.box) lib.push({ type: 'input', callId, box: s.box });
  });
  return { 'test.trace': L(test), '0-trace.trace': L(lib) };
}
const rec = (steps) => recordFromTrace(readZip(zip(run(steps))));

const APP = 'http://localhost:3000/login';
const before = [
  { kind: 'nav', url: APP },
  { kind: 'click', target: "getByTestId('submit')", box: { x: 100, y: 200, width: 80, height: 30 }, url: APP },
  { kind: 'expect', target: "getByTestId('greeting')", expected: 'Welcome, Ana', url: APP, fail: true },
];
const fixed = [
  { kind: 'nav', url: APP },
  { kind: 'click', target: "getByRole('button', { name: 'Sign in' })", box: { x: 102, y: 201, width: 80, height: 30 }, url: APP },
  { kind: 'expect', target: "getByTestId('welcome')", expected: 'Welcome, Ana', url: APP },
];

test('recordFromTrace reads steps, values, pages, boxes and the failure', () => {
  const r = rec(before);
  assert.equal(r.steps.length, 3);
  assert.equal(r.failedAt, 2);
  assert.deepEqual(r.steps.map((s) => s.kind), ['navigate', 'action', 'expect']);
  assert.equal(r.steps[1].box.x, 100);
  assert.equal(r.steps[2].expected, 'Welcome, Ana');
  assert.equal(r.steps[2].page, APP);
  assert.equal(r.steps[2].failed, true);
});

test('a real locator fix passes the runtime guard', () => {
  assert.deepEqual(compareRuns(rec(before), rec(fixed)), []);
});

test('blocks a fix that drops the failing assertion', () => {
  const f = compareRuns(rec(before), rec(fixed.slice(0, 2)));
  assert.equal(f[0].rule, 'runtime-no-checks');
});

test('blocks a fix that checks another value', () => {
  const f = compareRuns(rec(before), rec([...fixed.slice(0, 2), { ...fixed[2], expected: 'Welcome' }]));
  assert.ok(f.some((x) => x.rule === 'runtime-fewer-checks'), JSON.stringify(f));
});

test('blocks a fix that checks fewer things', () => {
  const two = [...before.slice(0, 2), { kind: 'expect', title: 'Expect "toBeVisible"', target: "getByTestId('menu')", url: APP }, before[2]];
  const one = [...fixed.slice(0, 2), fixed[2]];
  const f = compareRuns(rec(two), rec(one));
  assert.ok(f.some((x) => x.rule === 'runtime-fewer-checks' && x.message.includes('toBeVisible')), JSON.stringify(f));
});

test('blocks a fix whose steps run on another page', () => {
  const other = 'http://localhost:3000/welcome-static';
  const f = compareRuns(rec(before), rec(fixed.map((s) => ({ ...s, url: s.kind === 'nav' ? APP : other }))));
  assert.ok(f.some((x) => x.rule === 'runtime-other-page'), JSON.stringify(f));
});

test('blocks a fix that clicks another element', () => {
  const moved = fixed.map((s) => (s.kind === 'click' ? { ...s, box: { x: 600, y: 40, width: 80, height: 30 } } : s));
  const f = compareRuns(rec(before), rec(moved));
  assert.ok(f.some((x) => x.rule === 'runtime-other-element'), JSON.stringify(f));
});

test('a failed action may move (that is what the fix repairs)', () => {
  const b = [before[0], { ...before[1], fail: true }];
  const a = [fixed[0], { ...fixed[1], box: { x: 600, y: 40, width: 80, height: 30 } }, fixed[2]];
  assert.deepEqual(compareRuns(rec(b), rec(a)).filter((x) => x.rule === 'runtime-other-element'), []);
});

test('findTrace picks the newest matching trace and skips node_modules and dot folders', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const since = Date.now() - 1000;
  for (const d of ['test-results/a', 'test-results/node_modules/x', 'test-results/.cache']) {
    mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, d, 'trace.zip'), zip(run(fixed)));
  }
  mkdirSync(path.join(root, 'test-results/b'), { recursive: true });
  writeFileSync(path.join(root, 'test-results/b/trace.zip'), zip(run(fixed, 'other.spec.ts:1 › something else')));
  const found = await findTrace(root, ['test-results'], since, 'user can log in');
  assert.equal(found, path.join(root, 'test-results/a/trace.zip'));
  assert.equal(await findTrace(root, ['../'], since, 'user can log in'), null);
  const r = await recordFromFile(found);
  assert.equal(r.steps.length, 3);
});

test('frameAt picks the last screencast frame at or before a time', () => {
  const jpg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 0x11, 8, 0, 10, 0, 20, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.alloc(200, tag), Buffer.from([0xff, 0xd9])]);
  const entries = readZip(
    zip({
      '0-trace.trace': L([1000, 2000, 3000].map((t, i) => ({ type: 'screencast-frame', timestamp: t, file: `screencast/f${i}.jpeg` }))),
      'screencast/f0.jpeg': jpg(1),
      'screencast/f1.jpeg': jpg(2),
      'screencast/f2.jpeg': jpg(3),
    }),
  );
  const at = (t) => Buffer.from(frameAt(entries, t).data, 'base64').at(30);
  assert.equal(at(2100), 2);
  assert.equal(at(undefined), 3);
  assert.equal(at(1000), 1);
});

test('the PR shows the runtime guard and links the screenshots', () => {
  const r = {
    failure: { index: 1, file: 'a.spec.ts', title: 'a', kind: 'assertion', message: 'm' }, category: 'TEST_BUG', rootCause: 'LOCATOR_DRIFT', confidence: 0.9, reasons: [], status: 'FIXED', summary: 'ok',
    fix: { by: 'rules', file: 'a.spec.ts', explanation: 'e', diff: '-a\n+b' }, guard: { engine: 'PASS', local: 'PASS', findings: [] }, stability: { runs: 5, passed: true, detail: '' },
    runtime: { checked: true, checks: 2, repeated: 1, box: { x: 10.4, y: 20, width: 30, height: 40 }, evidence: { before: '1-before.png', after: '1-after.jpeg', url: 'https://github.com/o/r/actions/runs/9', artifact: 'autoheal-result-evidence' } },
    spend: { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true },
  };
  const summary = { tool: 'autoheal-ai', version: '0.4.0', startedAt: '', finishedAt: '', mode: 'draft-pr', provider: 'scripted', model: 'm', outcome: 'fixed', changes: true, changedFiles: ['a.spec.ts'], totalFailures: 1, skippedFailures: 0, minutesSaved: 30, spend: { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true }, results: [r] };
  const body = prBody(summary);
  assert.match(body, /Runtime guard \| traced rerun: 2 assertion\(s\) ran, all 1 the failed run made repeated/);
  assert.match(body, /acted at \(10, 20\)/);
  assert.match(body, /Screenshots \| before `evidence\/1-before\.png`, after `evidence\/1-after\.jpeg` in the \*\*autoheal-result-evidence\*\* artifact of \[this run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/9\)/);
  const bad = prBody({ ...summary, results: [{ ...r, runtime: { ...r.runtime, evidence: { ...r.runtime.evidence, url: 'javascript:alert(1)' } } }] });
  assert.doesNotMatch(bad, /javascript:/);
  const off = prBody({ ...summary, results: [{ ...r, runtime: { checked: false, note: 'no trace | here' } }] });
  assert.match(off, /Runtime guard \| no trace \\\| here/);
});
