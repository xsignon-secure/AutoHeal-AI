/**
 * The dashboard page: server-rendered HTML, no scripts, no external assets,
 * light and dark themes from the system setting.
 */

import type { EventRow, Stats } from './store.js';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_TONE: Record<string, string> = {
  FIXED: 'good',
  QUARANTINED: 'info',
  FLAKY: 'info',
  BLOCKED_CHEATING: 'bad',
  APP_BUG: 'warn',
  ENV: 'muted',
  UNFIXED: 'muted',
};

const ICONS: Record<string, string> = {
  repo: '<path d="M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z"/><path d="M8 4v16"/>',
  pr: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4"/>',
  check: '<path d="M5 12l4 4L19 6"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  bug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M12 7V4M4 13h3M17 13h3M5 8l2 2M19 8l-2 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M15 9a3 3 0 0 0-3-1.5c-1.7 0-3 .9-3 2.2 0 3 6 1.6 6 4.6 0 1.3-1.3 2.2-3 2.2A3 3 0 0 1 9 15M12 6v12"/>',
};

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

function card(label: string, value: string, iconName: string, hint: string): string {
  return `<div class="card"><div class="card-top">${icon(iconName)}<span>${escapeHtml(label)}</span></div><div class="value">${escapeHtml(value)}</div><div class="hint">${escapeHtml(hint)}</div></div>`;
}

function link(url: string | undefined, text: string): string {
  if (!url) return '';
  return `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

export function renderPage(stats: Stats, events: EventRow[], repos: string[], selected: string | undefined): string {
  const hours = (stats.minutesSaved / 60).toFixed(1);
  const rows = events
    .map((e) => {
      const tone = STATUS_TONE[e.status] ?? 'muted';
      const links = [link(e.pr_url, 'PR'), link(e.issue_url, 'Issue'), link(e.run_url, 'Run')].filter(Boolean).join(' · ');
      return `<tr>
        <td><span class="badge ${tone}">${escapeHtml(e.status)}</span></td>
        <td><div class="title">${escapeHtml(e.test_title)}</div><div class="sub">${escapeHtml(e.file_path)}</div></td>
        <td>${escapeHtml(e.repo)}</td>
        <td><span class="chip">${escapeHtml(e.root_cause)}</span><div class="sub">${escapeHtml(e.category)} · ${Math.round(e.confidence * 100)}%${e.fix_by ? ` · ${e.fix_by === 'ai' ? 'AI' : 'rules'}` : ''}</div></td>
        <td class="num">${e.tokens.toLocaleString('en-US')}</td>
        <td>${links || '<span class="sub">—</span>'}</td>
        <td class="sub">${escapeHtml(e.created_at.slice(0, 16).replace('T', ' '))}</td>
      </tr>`;
    })
    .join('');
  const options = [`<option value="">All repositories</option>`, ...repos.map((r) => `<option value="${escapeHtml(r)}"${r === selected ? ' selected' : ''}>${escapeHtml(r)}</option>`)].join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoHeal Dashboard</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e6e5e0;--good:#1f7a3d;--good-bg:#e4f4e8;--bad:#a42626;--bad-bg:#fbe9e9;--warn:#8a5a00;--warn-bg:#fbf0d9;--info:#1f5fa8;--info-bg:#e6effa;--chip:#f0efec}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--text:#ecebe6;--muted:#a3a29c;--line:#2e2e2b;--good:#7fd69a;--good-bg:#1b3324;--bad:#f08b8b;--bad-bg:#3a1d1d;--warn:#f0c46a;--warn-bg:#3a2e14;--info:#8db8f0;--info-bg:#1a2a40;--chip:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:20px}
h1{font-size:22px;margin:0}.lead{color:var(--muted);margin:2px 0 0}
form{display:flex;gap:8px}select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card-top{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:13px}.value{font-size:28px;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums}.hint{color:var(--muted);font-size:12px}
.table-wrap{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:820px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em}
tr:last-child td{border-bottom:0}.title{font-weight:550}.sub{color:var(--muted);font-size:12px}.num{font-variant-numeric:tabular-nums;text-align:right}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.good{color:var(--good);background:var(--good-bg)}.bad{color:var(--bad);background:var(--bad-bg)}.warn{color:var(--warn);background:var(--warn-bg)}.info{color:var(--info);background:var(--info-bg)}.muted{color:var(--muted);background:var(--chip)}
.chip{display:inline-block;padding:1px 6px;border-radius:6px;background:var(--chip);font-size:12px}
a{color:var(--info)}.empty{padding:32px;text-align:center;color:var(--muted)}
footer{margin-top:20px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<main>
<header>
  <div><h1>AutoHeal Dashboard</h1><p class="lead">Self-healing results from your own CI runners. Self-hosted, free and MIT.</p></div>
  <form method="get" action="/"><select name="repo" aria-label="Repository">${options}</select><button type="submit">Filter</button></form>
</header>
<section class="grid" aria-label="Totals">
  ${card('Repositories monitored', String(stats.repos), 'repo', `${stats.events} failures analysed`)}
  ${card('Fix PRs opened', String(stats.fixPrs), 'pr', `${stats.fixed} tests fixed`)}
  ${card('Flaky tests quarantined', String(stats.quarantined), 'flask', 'with an expiry date')}
  ${card('Cheating fixes blocked', String(stats.blocked), 'shield', 'weakened tests never merged')}
  ${card('App bugs surfaced', String(stats.appBugs), 'bug', 'opened as issues, not hidden')}
  ${card('Engineer hours saved', hours, 'clock', 'estimate: 45 min per fix')}
  ${card('AI spend', `$${stats.usd.toFixed(2)}`, 'coin', `${stats.tokens.toLocaleString('en-US')} tokens on your own key`)}
</section>
<div class="table-wrap">
${
  events.length
    ? `<table><thead><tr><th>Status</th><th>Test</th><th>Repository</th><th>Root cause</th><th class="num">Tokens</th><th>Links</th><th>When (UTC)</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">No heal results yet. Set AUTOHEAL_DASHBOARD_URL and AUTOHEAL_DASHBOARD_SECRET in the AutoHeal workflow to send them here.</div>'
}
</div>
<footer>AutoHeal AI · stores labels, counts, test titles and links only; never source code.</footer>
</main>
</body>
</html>`;
}
