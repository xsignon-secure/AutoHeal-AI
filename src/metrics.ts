/**
 * Metrics: how AutoHeal is doing in this repository, read from GitHub and
 * the checkout, with no server and no AI.
 *
 *   - AutoHeal PRs opened, merged as written, merged after a reviewer edited
 *     them, closed, still open; the acceptance rate; time to merge
 *   - fixes by kind (rules, fingerprint, same-change, ai), so you can see how
 *     much needed no AI at all
 *   - AI spend and engineer minutes saved, from a hidden run marker in each
 *     PR body (PRs from before 0.9.0 have none and are counted without it)
 *   - the test files AutoHeal fixes most often (likely brittle)
 *   - app-bug issues AutoHeal opened, and how many are closed
 *   - quarantined tests: active, expiring this week, and expired entries that
 *     someone should fix or remove
 *
 * `autoheal metrics` prints a Markdown report (and writes it to the job
 * summary in GitHub Actions); `--json` saves the numbers.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readMarker } from './reviews.js';
import type { HealSummary } from './types.js';

const RUN_MARKER = /<!-- autoheal-run:([A-Za-z0-9+/=]{1,4000}) -->/;

/** Run totals hidden in the PR body, read back by `autoheal metrics`. */
export interface RunTotals {
  usd: number;
  tokens: number;
  minutes: number;
  failures: number;
  fixed: number;
  quarantined: number;
}

export function runMarker(summary: HealSummary): string {
  const count = (s: string) => summary.results.filter((r) => r.status === s).length;
  const totals: RunTotals = {
    usd: Math.round(summary.spend.usd * 10_000) / 10_000,
    tokens: summary.spend.inputTokens + summary.spend.outputTokens,
    minutes: summary.minutesSaved,
    failures: summary.totalFailures,
    fixed: count('FIXED'),
    quarantined: count('QUARANTINED'),
  };
  return `<!-- autoheal-run:${Buffer.from(JSON.stringify(totals)).toString('base64')} -->`;
}

export function readRunMarker(body: string | null | undefined): RunTotals | null {
  const m = RUN_MARKER.exec(body ?? '');
  if (!m) return null;
  try {
    const x = JSON.parse(Buffer.from(m[1] as string, 'base64').toString('utf8')) as Record<string, unknown>;
    const n = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0);
    return { usd: n(x.usd, 10_000), tokens: n(x.tokens, 1e9), minutes: n(x.minutes, 1e6), failures: n(x.failures, 1e4), fixed: n(x.fixed, 1e4), quarantined: n(x.quarantined, 1e4) };
  } catch {
    return null;
  }
}

export interface QuarantineStats {
  active: number;
  expiringSoon: Array<{ file: string; title: string; until: string }>;
  expired: Array<{ file: string; title: string; until: string }>;
}

export interface Metrics {
  repo: string;
  days: number;
  since: string;
  prs: { opened: number; merged: number; edited: number; closed: number; open: number };
  /** Merged (as written or edited) out of all decided PRs, 0..1; null when none are decided yet. */
  acceptance: number | null;
  /** Median hours from opening to merge; null when nothing merged. */
  medianHoursToMerge: number | null;
  fixes: Record<string, number>;
  /** Share of fixes that used no AI, 0..1; null without fixes. */
  noAiShare: number | null;
  spend: { usd: number; tokens: number; prsWithTotals: number };
  minutesSaved: number;
  topFiles: Array<{ file: string; fixes: number }>;
  issues: { opened: number; closed: number };
  quarantine: QuarantineStats | null;
}

export interface MetricsOptions {
  repo: string;
  token: string;
  days?: number;
  apiUrl?: string;
  fetchFn?: typeof fetch;
  /** Project folder with playwright-quarantine.json (optional). */
  root?: string;
  now?: Date;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

export async function quarantineStats(root: string, now = new Date()): Promise<QuarantineStats | null> {
  let text: string;
  try {
    text = await readFile(path.join(root, 'playwright-quarantine.json'), 'utf8');
  } catch {
    return null;
  }
  let q: { entries?: Array<Record<string, unknown>> };
  try {
    q = JSON.parse(text.slice(0, 2_000_000)) as typeof q;
  } catch {
    return null;
  }
  const today = now.toISOString().slice(0, 10);
  const week = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const out: QuarantineStats = { active: 0, expiringSoon: [], expired: [] };
  for (const e of Array.isArray(q.entries) ? q.entries.slice(0, 1000) : []) {
    const until = typeof e.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.until) ? e.until : '';
    const item = { file: String(e.file ?? '').slice(0, 200), title: String(e.title ?? '').slice(0, 200), until };
    if (!until || until < today) out.expired.push(item);
    else {
      out.active++;
      if (until <= week) out.expiringSoon.push(item);
    }
  }
  return out;
}

/** Reads AutoHeal PRs and issues from the last `days` days. Throws on an API error. */
export async function collectMetrics(options: MetricsOptions): Promise<Metrics> {
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(options.repo) || options.repo.includes('..')) throw new Error(`bad repository name ${options.repo}`);
  let api = (options.apiUrl ?? 'https://api.github.com').slice(0, 500);
  while (api.endsWith('/')) api = api.slice(0, -1);
  if (!/^https?:\/\//.test(api)) throw new Error('bad API URL');
  const fetchFn = options.fetchFn ?? fetch;
  const days = Math.min(Math.max(Math.floor(options.days ?? 30), 1), 365);
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const get = async (p: string): Promise<unknown> => {
    const res = await fetchFn(`${api}/repos/${options.repo}${p}`, {
      headers: { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'autoheal-ai' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${p.split('?')[0]}`);
    return res.json();
  };

  // AutoHeal PRs created in the window (newest first; at most 3 pages).
  const prs: Array<Record<string, any>> = [];
  for (let page = 1; page <= 3; page++) {
    const list = (await get(`/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`)) as Array<Record<string, any>>;
    if (!Array.isArray(list) || !list.length) break;
    let older = false;
    for (const p of list) {
      if (typeof p?.created_at !== 'string' || p.created_at < since) {
        older = true;
        continue;
      }
      if (typeof p?.head?.ref === 'string' && p.head.ref.startsWith('autoheal/') && p.head?.repo?.full_name === options.repo && p.base?.repo?.full_name === options.repo) prs.push(p);
    }
    if (older || list.length < 100) break;
  }

  const m: Metrics = {
    repo: options.repo,
    days,
    since: since.slice(0, 10),
    prs: { opened: 0, merged: 0, edited: 0, closed: 0, open: 0 },
    acceptance: null,
    medianHoursToMerge: null,
    fixes: {},
    noAiShare: null,
    spend: { usd: 0, tokens: 0, prsWithTotals: 0 },
    minutesSaved: 0,
    topFiles: [],
    issues: { opened: 0, closed: 0 },
    quarantine: null,
  };
  const hours: number[] = [];
  const files = new Map<string, number>();
  for (const p of prs.slice(0, 100)) {
    m.prs.opened++;
    if (p.merged_at) {
      // Edited: someone pushed commits after AutoHeal's own commit.
      let edited = false;
      if (typeof p.number === 'number' && m.prs.merged + m.prs.edited < 50) {
        const commits = (await get(`/pulls/${p.number}/commits?per_page=50`)) as Array<Record<string, any>>;
        const list = Array.isArray(commits) ? commits : [];
        const first = list.findIndex((c) => String(c?.commit?.message ?? '').startsWith('test: AutoHeal fixes'));
        edited = first >= 0 && list.slice(first + 1).some((c) => !String(c?.commit?.message ?? '').startsWith('test: AutoHeal fixes'));
      }
      if (edited) m.prs.edited++;
      else m.prs.merged++;
      const h = (Date.parse(p.merged_at) - Date.parse(p.created_at)) / 3_600_000;
      if (Number.isFinite(h) && h >= 0) hours.push(h);
    } else if (p.state === 'closed') m.prs.closed++;
    else m.prs.open++;
    for (const f of readMarker(p.body)) {
      m.fixes[f.by] = (m.fixes[f.by] ?? 0) + 1;
      files.set(f.file, (files.get(f.file) ?? 0) + 1);
    }
    const t = readRunMarker(p.body);
    if (t) {
      m.spend.usd += t.usd;
      m.spend.tokens += t.tokens;
      m.spend.prsWithTotals++;
      if (p.merged_at) m.minutesSaved += t.minutes;
    }
  }
  const decided = m.prs.merged + m.prs.edited + m.prs.closed;
  m.acceptance = decided ? (m.prs.merged + m.prs.edited) / decided : null;
  const med = median(hours);
  m.medianHoursToMerge = med === null ? null : Math.round(med * 10) / 10;
  const totalFixes = Object.values(m.fixes).reduce((a, b) => a + b, 0);
  m.noAiShare = totalFixes ? (totalFixes - (m.fixes.ai ?? 0)) / totalFixes : null;
  m.spend.usd = Math.round(m.spend.usd * 100) / 100;
  m.topFiles = [...files.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([file, fixes]) => ({ file, fixes }));

  // App-bug issues AutoHeal opened in the window.
  const issues = (await get(`/issues?state=all&since=${encodeURIComponent(since)}&per_page=100`)) as Array<Record<string, any>>;
  for (const i of Array.isArray(issues) ? issues : []) {
    if (i?.pull_request || typeof i?.title !== 'string' || !i.title.startsWith('AutoHeal: possible app regression') || typeof i.created_at !== 'string' || i.created_at < since) continue;
    m.issues.opened++;
    if (i.state === 'closed') m.issues.closed++;
  }
  if (options.root) m.quarantine = await quarantineStats(options.root, now);
  return m;
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const cell = (s: string) => s.replace(/[|\r\n`]/g, ' ').slice(0, 160);

export function metricsMarkdown(m: Metrics): string {
  const p = m.prs;
  const fixes = Object.entries(m.fixes).sort((a, b) => b[1] - a[1]);
  const total = fixes.reduce((a, [, n]) => a + n, 0);
  const lines = [
    `## AutoHeal metrics: ${cell(m.repo)}, last ${m.days} days (since ${m.since})`,
    '',
    '| | |',
    '|---|---|',
    `| Fix PRs opened | ${p.opened} |`,
    `| Merged as written | ${p.merged} |`,
    `| Merged after a reviewer edited them | ${p.edited} |`,
    `| Closed without merging | ${p.closed} |`,
    `| Still open | ${p.open} |`,
    `| Acceptance rate | ${pct(m.acceptance)} |`,
    `| Median time to merge | ${m.medianHoursToMerge === null ? 'n/a' : `${m.medianHoursToMerge} h`} |`,
    `| Test fixes | ${total}${total ? ` (${fixes.map(([k, n]) => `${n} ${k}`).join(', ')})` : ''} |`,
    `| Fixed without AI | ${pct(m.noAiShare)} |`,
    `| AI spend | $${m.spend.usd.toFixed(2)} · ${m.spend.tokens} tokens${m.spend.prsWithTotals < p.opened ? ` (from ${m.spend.prsWithTotals} of ${p.opened} PRs; older PRs have no totals)` : ''} |`,
    `| Engineer time saved (merged PRs, estimate) | ${Math.round(m.minutesSaved / 6) / 10} h |`,
    `| App-bug issues opened | ${m.issues.opened} (${m.issues.closed} closed) |`,
  ];
  if (m.quarantine) {
    const q = m.quarantine;
    lines.push(`| Quarantined tests | ${q.active} active, ${q.expiringSoon.length} expiring within 7 days, ${q.expired.length} expired |`);
  }
  if (m.topFiles.length) {
    lines.push('', '### Most often fixed', '', 'Tests AutoHeal had to fix again and again are worth a closer look: their locators may be brittle.', '');
    for (const f of m.topFiles) lines.push(`- \`${cell(f.file)}\`: ${f.fixes} fix${f.fixes === 1 ? '' : 'es'}`);
  }
  if (m.quarantine?.expired.length) {
    lines.push('', '### Expired quarantine entries', '', 'These tests count as failures again. Fix them, or remove the entries from `playwright-quarantine.json`.', '');
    for (const e of m.quarantine.expired.slice(0, 20)) lines.push(`- \`${cell(e.file)}\` › ${cell(e.title)} (until ${e.until || 'no date'})`);
  }
  if (m.quarantine?.expiringSoon.length) {
    lines.push('', '### Quarantine ending this week', '');
    for (const e of m.quarantine.expiringSoon.slice(0, 20)) lines.push(`- \`${cell(e.file)}\` › ${cell(e.title)} (until ${e.until})`);
  }
  if (p.closed && m.acceptance !== null && m.acceptance < 0.5) lines.push('', 'More than half of the decided fix PRs were closed. Closed fixes are not proposed again, but a `.autoheal.yml` with `fixes.allow` or `protect` can stop the kinds your team rejects.');
  return `${lines.join('\n')}\n`;
}
