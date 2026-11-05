// 0.9.0: metrics from AutoHeal PRs, issues and the quarantine file.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectMetrics, fixesMarker, metricsMarkdown, prBody, quarantineStats, readMarker, readRunMarker, runMarker } from '../dist/index.js';

const summary = (over = {}) => ({ tool: 'autoheal-ai', version: '0.9.0', startedAt: '', finishedAt: '', mode: 'draft-pr', provider: 'anthropic', model: 'm', outcome: 'fixed', changes: true, changedFiles: [], totalFailures: 2, skippedFailures: 0, minutesSaved: 65, spend: { steps: 3, inputTokens: 1000, outputTokens: 200, usd: 0.04567, priced: true }, results: [{ failure: { index: 1, file: 'tests/a.spec.ts', title: 'a', kind: 'timeout', message: '' }, category: 'TEST_BUG', rootCause: 'LOCATOR_DRIFT', confidence: 0.9, reasons: [], status: 'FIXED', summary: '', spend: { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true }, fix: { by: 'rules', file: 'tests/a.spec.ts', explanation: 'x', diff: '', before: 'A', after: 'B' } }], ...over });

test('metrics: the PR body carries run totals next to the fix list', () => {
  const body = prBody(summary());
  assert.deepEqual(readRunMarker(body), { usd: 0.0457, tokens: 1200, minutes: 65, failures: 2, fixed: 1, quarantined: 0 });
  assert.equal(readMarker(body).length, 1, 'the fix list is still read');
  assert.equal(readRunMarker('<!-- autoheal-run:bm9wZQ== -->'), null);
  const evil = `<!-- autoheal-run:${Buffer.from(JSON.stringify({ usd: -5, tokens: 'x', minutes: 1e12 })).toString('base64')} -->`;
  assert.deepEqual(readRunMarker(evil), { usd: 0, tokens: 0, minutes: 1e6, failures: 0, fixed: 0, quarantined: 0 });
  assert.match(runMarker(summary()), /^<!-- autoheal-run:[A-Za-z0-9+/=]+ -->$/);
});

test('metrics: quarantine entries are sorted into active, expiring and expired', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ah-metrics-'));
  assert.equal(await quarantineStats(dir), null);
  writeFileSync(path.join(dir, 'playwright-quarantine.json'), JSON.stringify({ version: 1, entries: [
    { file: 'a.spec.ts', title: 'old', until: '2026-10-01' },
    { file: 'b.spec.ts', title: 'soon', until: '2026-11-08' },
    { file: 'c.spec.ts', title: 'later', until: '2026-12-30' },
    { file: 'd.spec.ts', title: 'no date' },
  ] }));
  const q = await quarantineStats(dir, new Date('2026-11-05T00:00:00Z'));
  assert.equal(q.active, 2);
  assert.deepEqual(q.expiringSoon.map((e) => e.title), ['soon']);
  assert.deepEqual(q.expired.map((e) => e.title), ['old', 'no date']);
});

test('metrics: PRs, fixes, spend, issues and quarantine add up', async () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const own = { repo: { full_name: 'acme/shop' } };
  const body = (fixes, totals) => `${fixesMarker(fixes)}\n${totals ? runMarker(summary(totals)) : ''}`;
  const fx = (by, file = 'tests/a.spec.ts') => ({ file, test: 't', by });
  const pulls = [
    { number: 1, state: 'closed', created_at: '2026-11-04T00:00:00Z', merged_at: '2026-11-04T06:00:00Z', body: body([fx('rules'), fx('ai', 'tests/b.spec.ts')], { minutesSaved: 90 }), head: { ref: 'autoheal/1', ...own }, base: own },
    { number: 2, state: 'closed', created_at: '2026-11-03T00:00:00Z', merged_at: '2026-11-03T02:00:00Z', body: body([fx('fingerprint')]), head: { ref: 'autoheal/2', ...own }, base: own },
    { number: 3, state: 'closed', created_at: '2026-11-02T00:00:00Z', merged_at: null, body: body([fx('ai')], { minutesSaved: 45 }), head: { ref: 'autoheal/3', ...own }, base: own },
    { number: 4, state: 'open', created_at: '2026-11-01T00:00:00Z', merged_at: null, body: body([fx('same-change')]), head: { ref: 'autoheal/4', ...own }, base: own },
    { number: 5, state: 'closed', created_at: '2026-11-01T00:00:00Z', merged_at: '2026-11-01T01:00:00Z', body: body([fx('ai')]), head: { ref: 'feature', ...own }, base: own },
    { number: 6, state: 'closed', created_at: '2026-11-01T00:00:00Z', merged_at: '2026-11-01T01:00:00Z', body: body([fx('ai')]), head: { ref: 'autoheal/6', repo: { full_name: 'evil/shop' } }, base: own },
    { number: 7, state: 'closed', created_at: '2026-08-01T00:00:00Z', merged_at: '2026-08-01T01:00:00Z', body: body([fx('ai')]), head: { ref: 'autoheal/7', ...own }, base: own },
  ];
  const routes = {
    '/repos/acme/shop/pulls': pulls,
    '/repos/acme/shop/pulls/1/commits': [{ commit: { message: 'test: AutoHeal fixes for failed run 1' } }],
    '/repos/acme/shop/pulls/2/commits': [{ commit: { message: 'test: AutoHeal fixes for failed run 2' } }, { commit: { message: 'tidy' } }],
    '/repos/acme/shop/issues': [
      { title: 'AutoHeal: possible app regression in "price"', state: 'closed', created_at: '2026-11-02T00:00:00Z' },
      { title: 'AutoHeal: possible app regression in "cart"', state: 'open', created_at: '2026-11-03T00:00:00Z' },
      { title: 'AutoHeal: possible app regression in "pr"', state: 'open', created_at: '2026-11-03T00:00:00Z', pull_request: {} },
      { title: 'Some other bug', state: 'open', created_at: '2026-11-03T00:00:00Z' },
    ],
  };
  const fetchFn = async (url) => {
    const b = routes[new URL(url).pathname];
    return { ok: !!b, status: b ? 200 : 404, json: async () => b };
  };
  const m = await collectMetrics({ repo: 'acme/shop', token: 't', apiUrl: 'https://api.example.test/', fetchFn, now, days: 30 });
  assert.deepEqual(m.prs, { opened: 4, merged: 1, edited: 1, closed: 1, open: 1 });
  assert.equal(m.acceptance, 2 / 3);
  assert.equal(m.medianHoursToMerge, 4);
  assert.deepEqual(m.fixes, { rules: 1, ai: 2, fingerprint: 1, 'same-change': 1 });
  assert.equal(m.noAiShare, 3 / 5);
  assert.deepEqual(m.spend, { usd: 0.09, tokens: 2400, prsWithTotals: 2 });
  assert.equal(m.minutesSaved, 90, 'only merged PRs count toward time saved');
  assert.deepEqual(m.topFiles[0], { file: 'tests/a.spec.ts', fixes: 4 });
  assert.deepEqual(m.issues, { opened: 2, closed: 1 });
  const md = metricsMarkdown(m);
  assert.match(md, /Acceptance rate \| 67% \|/);
  assert.match(md, /Fixed without AI \| 60% \|/);
  assert.match(md, /from 2 of 4 PRs/);
  await assert.rejects(collectMetrics({ repo: 'acme/shop', token: 't', fetchFn: async () => ({ ok: false, status: 403 }) }), /403/);
  await assert.rejects(collectMetrics({ repo: '../x', token: 't', fetchFn }), /bad repository/);
});

test('metrics: the weekly template is read-only', () => {
  const t = readFileSync(new URL('../templates/autoheal-metrics.yml', import.meta.url), 'utf8');
  assert.match(t, /permissions:\n  contents: read\n  pull-requests: read\n  issues: read\n/);
  assert.doesNotMatch(t, /: write|API_KEY/);
});
