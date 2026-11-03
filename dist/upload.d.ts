/**
 * Optional: send heal results to your own self-hosted AutoHeal dashboard.
 * Only labels, counts, test titles, file paths and links leave the runner;
 * no source code, diffs, error text or secrets.
 */
import { type HealSummary } from './types.js';
export interface HealEvent {
    id: string;
    repo: string;
    run_id?: string;
    run_url?: string;
    commit_sha?: string;
    branch?: string;
    test_title: string;
    file_path: string;
    status: string;
    category: string;
    root_cause: string;
    confidence: number;
    fix_by?: string;
    pr_url?: string;
    issue_url?: string;
    tokens: number;
    usd: number;
    minutes_saved: number;
    created_at: string;
}
export declare function eventsFrom(summary: HealSummary, links?: {
    prUrl?: string;
    issueUrls?: Record<string, string>;
    repo?: string;
}): HealEvent[];
export declare function uploadEvents(url: string, secret: string, events: HealEvent[], timeoutMs?: number): Promise<{
    ok: boolean;
    status: number;
    text: string;
}>;
