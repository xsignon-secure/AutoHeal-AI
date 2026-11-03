import type { BudgetSnapshot } from './budget.js';
import type { CheatFinding } from './cheat.js';
import type { Category, RootCause } from './triage.js';
/** Rough engineer minutes each result saves (shown on the dashboard). */
export declare const MINUTES_SAVED: Readonly<Record<string, number>>;
export type Mode = 'comment' | 'draft-pr' | 'pr';
/** What happened to one failing test. */
export type Status = 'FIXED' | 'QUARANTINED' | 'FLAKY' | 'BLOCKED_CHEATING' | 'APP_BUG' | 'ENV' | 'UNFIXED';
export interface FailureInfo {
    index: number;
    file: string;
    line?: number;
    title: string;
    kind: string;
    message: string;
    expected?: string;
    actual?: string;
    project?: string;
    /** The Playwright trace for this failure, when the run kept one. */
    tracePath?: string;
    /** Where the AI's screenshot of the failure came from, when it got one. */
    screenshot?: 'attachment' | 'trace';
    /** The engine's Markdown for this failure (trace steps, network, console). */
    detail: string;
}
export interface FixInfo {
    by: 'rules' | 'ai';
    file: string;
    explanation: string;
    /** Unified-style excerpt of what changed (short). */
    diff: string;
    before?: string;
    after?: string;
}
export interface GuardInfo {
    engine: string;
    local: string;
    findings: Array<CheatFinding | {
        severity: string;
        rule: string;
        message: string;
    }>;
}
export interface FailureResult {
    failure: Omit<FailureInfo, 'detail'>;
    category: Category;
    rootCause: RootCause;
    confidence: number;
    reasons: string[];
    status: Status;
    summary: string;
    fix?: FixInfo;
    guard?: GuardInfo;
    stability?: {
        runs: number;
        passed: boolean;
        detail: string;
    };
    quarantine?: {
        days: number;
    };
    spend: BudgetSnapshot;
}
export type Outcome = 'fixed' | 'blocked' | 'app-bug' | 'quarantined' | 'nothing-to-do' | 'unfixed' | 'error';
export interface HealSummary {
    tool: 'autoheal-ai';
    version: string;
    startedAt: string;
    finishedAt: string;
    mode: Mode;
    provider: string;
    model: string;
    outcome: Outcome;
    /** True when files changed and passed every check (ready for a branch). */
    changes: boolean;
    changedFiles: string[];
    results: FailureResult[];
    totalFailures: number;
    skippedFailures: number;
    spend: BudgetSnapshot;
    /** Rough minutes saved, from MINUTES_SAVED. */
    minutesSaved: number;
    error?: string;
    run?: {
        url?: string;
        id?: string;
        commit?: string;
        branch?: string;
        repo?: string;
    };
}
