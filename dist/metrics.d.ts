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
import type { HealSummary } from './types.js';
/** Run totals hidden in the PR body, read back by `autoheal metrics`. */
export interface RunTotals {
    usd: number;
    tokens: number;
    minutes: number;
    failures: number;
    fixed: number;
    quarantined: number;
}
export declare function runMarker(summary: HealSummary): string;
export declare function readRunMarker(body: string | null | undefined): RunTotals | null;
export interface QuarantineStats {
    active: number;
    expiringSoon: Array<{
        file: string;
        title: string;
        until: string;
    }>;
    expired: Array<{
        file: string;
        title: string;
        until: string;
    }>;
}
export interface Metrics {
    repo: string;
    days: number;
    since: string;
    prs: {
        opened: number;
        merged: number;
        edited: number;
        closed: number;
        open: number;
    };
    /** Merged (as written or edited) out of all decided PRs, 0..1; null when none are decided yet. */
    acceptance: number | null;
    /** Median hours from opening to merge; null when nothing merged. */
    medianHoursToMerge: number | null;
    fixes: Record<string, number>;
    /** Share of fixes that used no AI, 0..1; null without fixes. */
    noAiShare: number | null;
    spend: {
        usd: number;
        tokens: number;
        prsWithTotals: number;
    };
    minutesSaved: number;
    topFiles: Array<{
        file: string;
        fixes: number;
    }>;
    issues: {
        opened: number;
        closed: number;
    };
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
export declare function quarantineStats(root: string, now?: Date): Promise<QuarantineStats | null>;
/** Reads AutoHeal PRs and issues from the last `days` days. Throws on an API error. */
export declare function collectMetrics(options: MetricsOptions): Promise<Metrics>;
export declare function metricsMarkdown(m: Metrics): string;
