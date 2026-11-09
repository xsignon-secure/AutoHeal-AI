/**
 * Builds the Markdown people see: the pull request body, the issue for an
 * app bug, the comment in comment mode, and the job summary. Every claim in
 * them comes from a check that ran (triage signals, both anti-cheat scans,
 * the stability rerun, the spend counters).
 */

import type { FailureResult, HealSummary } from './types.js';
import type { Cause } from './cause.js';
import { fixesMarker } from './reviews.js';
import { runMarker } from './metrics.js';
import { ciInfo, ciLabel } from './ci.js';

/** One line naming the commit, e.g. `abc1234` "Rename login" (Ada, 2026-11-03): "Log in" → "Sign in" in `app/login.tsx`. */
export function causeText(c: Cause, repoUrl?: string): string {
  const link = repoUrl && /^https:\/\/[^\s|()]+$/.test(repoUrl) && /^[0-9a-f]{40}$/.test(c.commit) ? (ciInfo().forge === 'gitlab' ? `${repoUrl}/-/commit/${c.commit}` : `${repoUrl}/commit/${c.commit}`) : undefined;
  const sha = link ? `[\`${cell(c.short)}\`](${link})` : `\`${cell(c.short)}\``;
  const who = [c.author, c.date].filter(Boolean).map((x) => cell(String(x))).join(', ');
  return `${sha} "${cell(c.subject)}"${who ? ` (${who})` : ''}: ${cell(c.evidence)}`;
}

function repoUrl(): string | undefined {
  const info = ciInfo();
  return info.server && info.repo ? `${info.server}/${info.repo}` : undefined;
}

/** Evidence markers for the result being rendered (set while its table is built). */
const evidenceMarkers = new WeakMap<FailureResult, string>();

const BADGE: Record<string, string> = {
  FIXED: '✅ FIXED',
  QUARANTINED: '🧪 QUARANTINED',
  FLAKY: '🔁 FLAKY',
  BLOCKED_CHEATING: '⛔ BLOCKED_CHEATING',
  APP_BUG: '🐞 APP_BUG',
  ENV: '🧰 ENV',
  UNFIXED: '⚠️ UNFIXED',
};

function money(usd: number, priced: boolean): string {
  return priced ? `$${usd.toFixed(4)}` : 'not priced (set AUTOHEAL_PRICE_IN/OUT)';
}

function fence(text: string, lang = ''): string {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${text.trimEnd()}\n${ticks}`;
}

function firstLines(text: string, lines = 12): string {
  const all = text.split('\n');
  return all.slice(0, lines).join('\n') + (all.length > lines ? '\n…' : '');
}

const FIX_BY: Record<string, string> = {
  rules: 'deterministic, no AI tokens',
  fingerprint: 'element fingerprint, no AI tokens',
  'same-change': 'same UI change as another test, no AI tokens',
  ai: 'AI agent',
};

/** Groups fixes by the UI change behind them: one change that broke several tests. */
export function uiChanges(results: FailureResult[]): string[] {
  const groups = new Map<string, { label: string; tests: string[] }>();
  for (const r of results) {
    if (r.status !== 'FIXED' || !r.fix) continue;
    const root = r.cause?.commit ?? r.fix.sameAs ?? r.failure.title;
    const g = groups.get(root) ?? { label: '', tests: [] };
    g.tests.push(r.failure.title);
    if (!r.fix.sameAs) {
      const l = r.fix.locators?.[0];
      g.label = l ? `\`${cell(l.before)}\` → \`${cell(l.after)}\`` : `fixed in \`${cell(r.fix.file)}\``;
    }
    if (r.cause && !g.label.includes(r.cause.short)) g.label = `${g.label || 'one change'}, from commit ${causeText(r.cause, repoUrl())},`;
    groups.set(root, g);
  }
  const shared = [...groups.values()].filter((g) => g.tests.length > 1);
  if (!shared.length) return [];
  const out = ['### One UI change, one fix', ''];
  for (const g of shared) out.push(`- ${g.label || 'one change'} fixed ${g.tests.length} tests: ${g.tests.map((t) => cell(t)).join('; ')}`);
  out.push('');
  return out;
}

function resultBlock(r: FailureResult): string {
  const out: string[] = [];
  const where = `${r.failure.file}${r.failure.line ? `:${r.failure.line}` : ''}`;
  out.push(`### ${BADGE[r.status] ?? r.status} · ${r.failure.title}`, '');
  out.push(`| | |`, `|---|---|`);
  out.push(`| File | \`${where}\` |`);
  out.push(`| Triage | **${r.category}** · ${r.rootCause} · confidence ${(r.confidence * 100).toFixed(0)}% |`);
  out.push(`| Why | ${cell(r.reasons.join('; '))} |`);
  if (r.healed) out.push(`| Healed during the run | the test passed because AutoHeal found the element again while it ran; this PR makes the code match |`);
  if (r.groupOf) out.push(`| Grouped with | ${cell(r.groupOf)} (same cause) |`);
  if (r.guard) out.push(`| Anti-cheat | engine heal guard: **${r.guard.engine}**, local scan: **${r.guard.local}** |`);
  if (r.stability) out.push(`| Stability proof | ${r.stability.passed ? 'passed' : 'failed'} ${r.stability.runs}× in a row |`);
  if (r.runtime?.checked) {
    const at = r.runtime.box ? `; the fixed step acted at (${Math.round(r.runtime.box.x)}, ${Math.round(r.runtime.box.y)}), ${Math.round(r.runtime.box.width)}×${Math.round(r.runtime.box.height)} px` : '';
    const n = r.runtime.repeated ?? 0;
    const repeated = n ? `all ${n} the failed run made repeated with the same values` : 'the failed run stopped before its first assertion';
    out.push(`| Runtime guard | traced rerun: ${r.runtime.checks ?? 0} assertion(s) ran, ${repeated}; the steps before the failure ran on the same pages and the same elements${at} |`);
    const ev = r.runtime.evidence;
    if (ev && (ev.before || ev.after)) {
      const files = [ev.before && `before \`evidence/${cell(ev.before)}\``, ev.after && `after \`evidence/${cell(ev.after)}\``].filter(Boolean).join(', ');
      const art = `**${cell(ev.artifact ?? 'evidence')}**`;
      const where = ev.url && /^https:\/\/[^\s|()]+$/.test(ev.url) ? `the ${art} artifact of [this run](${ev.url})` : `the ${art} artifact of the heal run`;
      out.push(`| Screenshots | ${files} in ${where} |`);
      // The publish job swaps this for the images themselves (hosted on the code host).
      const marker = `<!-- autoheal-evidence${ev.before && /^[\w.-]{1,40}$/.test(ev.before) ? ` before="${ev.before}"` : ''}${ev.after && /^[\w.-]{1,40}$/.test(ev.after) ? ` after="${ev.after}"` : ''} -->`;
      evidenceMarkers.set(r, marker);
    }
  } else if (r.runtime?.note) out.push(`| Runtime guard | ${cell(r.runtime.note)} |`);
  if (r.cause) out.push(`| Likely cause | ${causeText(r.cause, repoUrl())} |`);
  if (r.quarantine) out.push(`| Quarantine | ${r.quarantine.days} days, then it counts again |`);
  if (r.failure.screenshot && r.spend.steps > 0) out.push(`| Visual grounding | the AI saw the page at the moment of failure (${r.failure.screenshot === 'attachment' ? 'Playwright failure screenshot' : 'trace frame'}) |`);
  out.push(`| AI spend | ${r.spend.inputTokens + r.spend.outputTokens} tokens · ${money(r.spend.usd, r.spend.priced)} |`);
  out.push('');
  const marker = evidenceMarkers.get(r);
  if (marker) out.push(marker, '');
  out.push(r.summary, '');
  out.push('<details><summary>Original error</summary>', '', fence(firstLines(r.failure.message)), '', '</details>', '');
  if (r.fix) {
    out.push(`**Fix (${FIX_BY[r.fix.by] ?? r.fix.by}):** ${r.fix.explanation}`, '');
    if (r.fix.match) out.push(`Fingerprint match: ${Math.round(r.fix.match.score * 100)}% (same ${r.fix.match.signals.join(', ') || 'role and place'}).`, '');
    for (const l of r.fix.locators ?? []) {
      const how = l.direction > 0 ? 'stronger' : l.direction < 0 ? 'weaker' : 'same strength';
      out.push(`Locator: \`${cell(l.before)}\` (${l.from}) → \`${cell(l.after)}\` (${l.to}), ${how}.`, '');
    }
    out.push(fence(r.fix.diff, 'diff'), '');
  }
  if (r.guard?.findings.length) {
    out.push('<details><summary>Anti-cheat findings</summary>', '');
    for (const f of r.guard.findings) out.push(`- **${f.severity}** ${f.rule}: ${f.message}`);
    out.push('', '</details>', '');
  }
  return out.join('\n');
}

function totals(summary: HealSummary): string {
  const lines = [`Spend: ${summary.spend.inputTokens + summary.spend.outputTokens} tokens · ${money(summary.spend.usd, summary.spend.priced)} · model \`${summary.model}\``];
  if (summary.sandbox) lines.push(`Sandbox: ${summary.sandbox.replace(/[\r\n]+/g, ' ')}`);
  if (summary.policy) lines.push(summary.policy.replace(/[\r\n]+/g, ' '));
  if (summary.app) lines.push(`Live app: ${summary.app.replace(/[\r\n]+/g, ' ')}`);
  if (summary.reviews) {
    const r = summary.reviews;
    const n = r.merged + r.edited + r.closed;
    lines.push(r.note ? `Earlier AutoHeal PRs: ${r.note.replace(/[\r\n]+/g, ' ')}` : `Learned from ${n} earlier AutoHeal PR${n === 1 ? '' : 's'}: ${r.merged} merged as written, ${r.edited} edited by a reviewer, ${r.closed} closed.`);
  }
  if (summary.fingerprints) lines.push(`Element fingerprints: ${summary.fingerprints} saved in \`.autoheal/fingerprints/\`, so the next broken locator for these elements can be fixed without AI.`);
  return lines.join('\n\n');
}

const footer = (): string =>
  `\n---\n_Generated by [AutoHeal AI](https://github.com/xsignon-secure/AutoHeal-AI), free and MIT. It ran in this repository's own ${ciInfo().ci === 'local' ? 'CI' : ciLabel(ciInfo().ci)} with your own AI key; no code left the runner except to the AI provider you chose._\n`;

export function prBody(summary: HealSummary): string {
  const kept = summary.results.filter((r) => r.status === 'FIXED' || r.status === 'QUARANTINED');
  const fixed = kept.filter((r) => r.status === 'FIXED').length;
  const quarantined = kept.length - fixed;
  const marked = kept
    .filter((r) => r.status === 'FIXED' && r.fix)
    .map((r) => {
      const before = r.fix?.before ?? r.fix?.locators?.[0]?.before;
      const after = r.fix?.after ?? r.fix?.locators?.[0]?.after;
      return { file: r.fix?.file ?? r.failure.file, test: r.failure.title, by: r.fix?.by ?? 'rules', ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
    });
  const lines = [
    // Read by the next heal run to learn what reviewers kept, edited or closed.
    fixesMarker(marked),
    runMarker(summary),
    `## AutoHeal AI: ${fixed} test fix${fixed === 1 ? '' : 'es'}${quarantined ? `, ${quarantined} quarantined` : ''}`,
    '',
    summary.run?.url ? `Failed run: ${summary.run.url}` : '',
    summary.run?.commit ? `Commit: \`${summary.run.commit}\`` : '',
    '',
    'Each change below was triaged as a test problem (not an app bug), passed both anti-cheat checks, and passed a stability rerun before this PR was opened. Please review it like any other change.',
    '',
    ...uiChanges(kept),
    ...kept.map(resultBlock),
  ];
  const others = summary.results.filter((r) => r.status !== 'FIXED' && r.status !== 'QUARANTINED');
  if (others.length) {
    lines.push('### Not changed in this PR', '');
    for (const r of others) lines.push(`- ${BADGE[r.status] ?? r.status} \`${r.failure.file}\` › ${r.failure.title}: ${r.summary}`);
    lines.push('');
  }
  lines.push(totals(summary), footer());
  return fitGithub(lines.filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n'));
}

/** GitHub rejects bodies over 65,536 characters. */
export function fitGithub(text: string, max = 60_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (cut to fit GitHub; the full report is in the job summary)\n${footer()}`;
}

export function issueTitle(r: FailureResult): string {
  return `AutoHeal: possible app regression in "${r.failure.title}"`.slice(0, 240);
}

export function issueBody(summary: HealSummary, r: FailureResult): string {
  return fitGithub([
    '## Possible app regression',
    '',
    'AutoHeal AI did **not** change this test: the evidence says the app behaves differently, not that the test is wrong. Fixing the test would hide the bug.',
    '',
    summary.run?.url ? `Failed run: ${summary.run.url}` : '',
    summary.run?.commit ? `Commit: \`${summary.run.commit}\`` : '',
    '',
    resultBlock(r),
    footer(),
  ].join('\n'));
}

export function commentBody(summary: HealSummary): string {
  return fitGithub([
    '## AutoHeal AI report',
    '',
    `Outcome: **${summary.outcome}** · ${summary.results.length} of ${summary.totalFailures} failure(s) analysed${summary.groups && summary.groups < summary.totalFailures ? ` · ${summary.groups} distinct cause(s)` : ''}`,
    '',
    ...summary.results.map(resultBlock),
    totals(summary),
    footer(),
  ].join('\n'));
}

/** Makes text safe inside a Markdown table cell: backslashes first, then pipes and line breaks. */
export function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function jobSummary(summary: HealSummary): string {
  const rows = summary.results.map(
    (r) => `| ${BADGE[r.status] ?? r.status} | \`${r.failure.file}\` | ${cell(r.failure.title)} | ${r.category} / ${r.rootCause} | ${(r.confidence * 100).toFixed(0)}% |`,
  );
  return [
    '## AutoHeal AI',
    '',
    `Outcome: **${summary.outcome}**${summary.error ? ` (${summary.error})` : ''}`,
    '',
    rows.length ? '| Status | File | Test | Triage | Confidence |\n|---|---|---|---|---|\n' + rows.join('\n') : 'No failing tests were found in the report.',
    '',
    totals(summary),
    '',
  ].join('\n');
}

/** A short diff excerpt of two versions of a file (changed lines with a little context). */
export function shortDiff(file: string, before: string, after: string, context = 2, maxLines = 60): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  if (start > endA && start > endB) return `--- a/${file}\n+++ b/${file}\n(no change)`;
  const from = Math.max(0, start - context);
  const out = [`--- a/${file}`, `+++ b/${file}`, `@@ -${from + 1} +${from + 1} @@`];
  for (let i = from; i < start; i++) out.push(` ${a[i]}`);
  for (let i = start; i <= endA; i++) out.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+${b[i]}`);
  for (let i = endA + 1; i < Math.min(a.length, endA + 1 + context); i++) out.push(` ${a[i]}`);
  return out.length > maxLines ? [...out.slice(0, maxLines), '… (diff shortened)'].join('\n') : out.join('\n');
}
