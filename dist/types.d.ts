import type { BudgetSnapshot } from './budget.js';
import type { CheatFinding } from './cheat.js';
import type { Category, RootCause } from './triage.js';
import type { Cause } from './cause.js';
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
    /** A failure screenshot saved by the test runner (Cypress), relative to the project. */
    screenshotPath?: string;
    /** Where the AI's screenshot of the failure came from, when it got one. */
    screenshot?: 'attachment' | 'trace';
    /** The engine's Markdown for this failure (trace steps, network, console). */
    detail: string;
}
export interface FixInfo {
    /**
     * rules: the engine's verified locator. fingerprint: the element found again
     * from its saved fingerprint. same-change: the fix kept for another test with
     * the same broken locator. ai: the AI agent. Only ai spends tokens.
     */
    by: 'rules' | 'ai' | 'fingerprint' | 'same-change';
    file: string;
    explanation: string;
    /** Unified-style excerpt of what changed (short). */
    diff: string;
    before?: string;
    after?: string;
    /** Locators the fix replaced, with Playwright's strength ranking. */
    locators?: Array<{
        before: string;
        after: string;
        from: string;
        to: string;
        direction: -1 | 0 | 1;
    }>;
    /** For fingerprint fixes: how well the element still matched. */
    match?: {
        score: number;
        signals: string[];
    };
    /** For same-change fixes: the test whose fix this reuses. */
    sameAs?: string;
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
/** Guard v2: what the traced run of the fix showed, compared with the failed run. */
export interface RuntimeInfo {
    /** True when both traces were read and compared. */
    checked: boolean;
    /** Assertions the fixed run made, and how many of the failed run's it repeated. */
    checks?: number;
    repeated?: number;
    /** Where the formerly failing step acted in the fixed run. */
    box?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    /** Screenshot files saved for the PR: the failed run, and the fixed run at the same step. */
    evidence?: {
        before?: string;
        after?: string;
        url?: string;
        artifact?: string;
    };
    note?: string;
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
    runtime?: RuntimeInfo;
    quarantine?: {
        days: number;
    };
    /** Left alone because .autoheal.yml says so (skip). */
    skipped?: true;
    /** The app commit that most likely caused this failure. */
    cause?: Cause;
    /** The test passed only because AutoHeal healed a locator during the run. */
    healed?: true;
    /** Grouped with this test's failure (same cause), so not worked on again. */
    groupOf?: string;
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
    /** The test framework: playwright, pytest or cypress. */
    framework?: string;
    /** How the tests were isolated from the AI key. */
    sandbox?: string;
    /** The app the heal job started (start-command), when it started one. */
    app?: string;
    /** Element fingerprints saved with this change. */
    fingerprints?: number;
    /** Distinct problems among the failures (same broken locator or same wrong value = one). */
    groups?: number;
    /** What the repository's .autoheal.yml changed. */
    policy?: string;
    /** What earlier AutoHeal PRs taught this run. */
    reviews?: {
        merged: number;
        edited: number;
        closed: number;
        note?: string;
    };
}
