/**
 * Optional: send heal results to your own self-hosted AutoHeal dashboard.
 * Only labels, counts, test titles, file paths and links leave the runner;
 * no source code, diffs, error text or secrets.
 */
import { createHash } from 'node:crypto';
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './signing.js';
import { MINUTES_SAVED } from './types.js';
export function eventsFrom(summary, links = {}) {
    const repo = links.repo ?? summary.run?.repo ?? 'unknown';
    const runKey = summary.run?.id ?? summary.run?.url ?? summary.startedAt;
    return summary.results.map((r) => {
        const id = createHash('sha256').update(`${repo}|${runKey}|${r.failure.file}|${r.failure.title}`).digest('hex').slice(0, 32);
        const event = {
            id,
            repo,
            test_title: r.failure.title.slice(0, 500),
            file_path: r.failure.file.slice(0, 500),
            status: r.status,
            category: r.category,
            root_cause: r.rootCause,
            confidence: Math.round(r.confidence * 100) / 100,
            tokens: r.spend.inputTokens + r.spend.outputTokens,
            usd: r.spend.usd,
            minutes_saved: MINUTES_SAVED[r.status] ?? 0,
            created_at: summary.finishedAt,
        };
        if (summary.run?.id)
            event.run_id = summary.run.id;
        if (summary.run?.url)
            event.run_url = summary.run.url;
        if (summary.run?.commit)
            event.commit_sha = summary.run.commit;
        if (summary.run?.branch)
            event.branch = summary.run.branch;
        if (r.fix)
            event.fix_by = r.fix.by;
        if (links.prUrl && (r.status === 'FIXED' || r.status === 'QUARANTINED'))
            event.pr_url = links.prUrl;
        const issue = links.issueUrls?.[r.failure.title];
        if (issue && r.status === 'APP_BUG')
            event.issue_url = issue;
        return event;
    });
}
export async function uploadEvents(url, secret, events, timeoutMs = 20_000) {
    const body = JSON.stringify({ version: 1, events });
    const ts = Math.floor(Date.now() / 1000);
    let base = url;
    while (base.endsWith('/'))
        base = base.slice(0, -1);
    const endpoint = `${base}/api/heal`;
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(secret, ts, body), [TIMESTAMP_HEADER]: String(ts) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 500) };
}
//# sourceMappingURL=upload.js.map