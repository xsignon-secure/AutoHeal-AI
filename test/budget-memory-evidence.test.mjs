import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Budget, PRICES, VERSION, findReport, loadMemory, memoryText, prBody, priceFor, relevantMemory, remember, shortDiff } from '../dist/index.js';

test('version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('budget: step, token and dollar limits', () => {
  const b = new Budget({ maxSteps: 3, maxTokens: 1_000_000, maxUsd: 0.05 }, PRICES['claude-opus-5-5']);
  b.record({ inputTokens: 5000, outputTokens: 1000 });
  assert.equal(b.exceeded(), null);
  assert.equal(b.snapshot().usd, 0.04);
  b.record({ inputTokens: 5000, outputTokens: 0 });
  assert.match(b.exceeded() ?? '', /cost limit/);
  const steps = new Budget({ maxSteps: 1, maxTokens: 10, maxUsd: 1 }, null);
  steps.record({ inputTokens: 1, outputTokens: 1 });
  assert.match(steps.exceeded() ?? '', /step limit/);
  assert.equal(steps.snapshot().priced, false);
});

test('prices: env override and unknown models', () => {
  assert.deepEqual(priceFor('claude-sonnet-5-5', {}), [2, 10]);
  assert.equal(priceFor('some-local-model', {}), null);
  assert.deepEqual(priceFor('x', { AUTOHEAL_PRICE_IN: '1', AUTOHEAL_PRICE_OUT: '2' }), [1, 2]);
});

test('memory: remember, cap and relevance', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-mem-'));
  assert.deepEqual((await loadMemory(dir)).entries, []);
  await remember(dir, { file: 'a.spec.ts', test: 't1', rootCause: 'LOCATOR_DRIFT', before: 'x'.repeat(1000), after: 'y' });
  for (let i = 0; i < 205; i++) await remember(dir, { file: 'b.spec.ts', test: `t${i}`, rootCause: 'TIMING' });
  const mem = await loadMemory(dir);
  assert.equal(mem.entries.length, 200);
  const rel = relevantMemory(mem, 'b.spec.ts', 5);
  assert.equal(rel.length, 5);
  assert.equal(rel[0].test, 't204');
  assert.match(memoryText(rel), /b\.spec\.ts › t204: TIMING/);
  assert.equal(memoryText([]), 'No earlier fixes are recorded for this repo.');
});

test('shortDiff shows only the changed lines with context', () => {
  const a = 'l1\nl2\nl3\nold\nl5\nl6\n';
  const d = shortDiff('f.ts', a, a.replace('old', 'new'));
  assert.match(d, /-old\n\+new/);
  assert.doesNotMatch(d, /l1/);
  assert.match(shortDiff('f.ts', a, a), /no change/);
});

test('prBody lists fixes and the things it did not change', () => {
  const summary = {
    tool: 'autoheal-ai', version: '0.1.0', startedAt: '', finishedAt: '', mode: 'draft-pr', provider: 'scripted', model: 'm', outcome: 'fixed',
    changes: true, changedFiles: ['a.spec.ts'], totalFailures: 2, skippedFailures: 0, minutesSaved: 60,
    spend: { steps: 1, inputTokens: 10, outputTokens: 5, usd: 0.001, priced: true },
    run: { url: 'https://github.com/o/r/actions/runs/1', commit: 'abc1234' },
    results: [
      { failure: { index: 1, file: 'a.spec.ts', title: 'a', kind: 'assertion', message: 'boom ``` fence' }, category: 'TEST_BUG', rootCause: 'LOCATOR_DRIFT', confidence: 0.9, reasons: ['r|pipe'], status: 'FIXED', summary: 'ok', fix: { by: 'rules', file: 'a.spec.ts', explanation: 'e', diff: '-a\n+b' }, guard: { engine: 'PASS', local: 'PASS', findings: [] }, stability: { runs: 5, passed: true, detail: '' }, spend: { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true } },
      { failure: { index: 2, file: 'b.spec.ts', title: 'b', kind: 'assertion', message: 'm' }, category: 'APP_BUG', rootCause: 'REGRESSION', confidence: 0.75, reasons: ['x'], status: 'APP_BUG', summary: 'app wrong', spend: { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true } },
    ],
  };
  const body = prBody(summary);
  assert.match(body, /1 test fix\b/);
  assert.match(body, /Stability proof \| passed 5×/);
  assert.match(body, /Not changed in this PR[\s\S]*APP_BUG/);
  assert.match(body, /r\\\|pipe/);
  assert.match(body, /````/);
});

test('findReport finds a JSON report and trace folders in an artifacts tree', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoheal-art-'));
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(path.join(dir, 'playwright-results', 'playwright-report'), { recursive: true });
  mkdirSync(path.join(dir, 'playwright-results', 'test-results', 't1'), { recursive: true });
  writeFileSync(path.join(dir, 'playwright-results', 'playwright-report', 'results.json'), '{"config":{},"suites":[]}');
  writeFileSync(path.join(dir, 'playwright-results', 'package.json'), '{"name":"x"}');
  writeFileSync(path.join(dir, 'playwright-results', 'test-results', 't1', 'trace.zip'), 'x');
  const found = await findReport(dir);
  assert.equal(found?.kind, 'json');
  assert.match(found?.report ?? '', /results\.json$/);
  assert.deepEqual(found?.traceDirs, [path.join(dir, 'playwright-results', 'test-results')]);
  const empty = mkdtempSync(path.join(os.tmpdir(), 'autoheal-none-'));
  assert.equal(await findReport(empty), null);
});
