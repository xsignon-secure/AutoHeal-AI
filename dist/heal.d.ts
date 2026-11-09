/**
 * The heal job: load the failed run, triage every failure, fix only test
 * bugs, prove each fix, and write nothing that did not pass every check.
 *
 *   1. load-report (local report or a CI run URL) and read each failure
 *   2. ask the engine for a deterministic fix (suggest-fix, diff only)
 *   3. per failure: mock drift check, flaky verdict, triage (+ AI refinement)
 *   4. TEST_BUG: rules fix first (no tokens), then the AI agent
 *      every proposal: local anti-cheat scan + engine heal guard, write,
 *      stability rerun (repeat-each), file rerun (no new failures), else revert
 *   5. FLAKY: quarantine with an expiry; APP_BUG: issue; ENV: report
 *   6. whole-tree heal guard on the result, repo memory, summary
 */
import { type BudgetLimits } from './budget.js';
import { type ToolCaller } from './mcp.js';
import { type Framework } from './cypress.js';
import type { Provider } from './providers/types.js';
import { type FailureInfo, type FailureResult, type HealSummary, type Mode, type Outcome } from './types.js';
import type { Sandbox } from './sandbox.js';
import { type ReviewHistory } from './reviews.js';
import { type Policy } from './policy.js';
import { type History } from './history.js';
export interface HealOptions {
    projectRoot: string;
    /** JSON report, blob-report folder, or a GitHub Actions / GitLab run URL. */
    report: string;
    traceDirs?: string[];
    mode: Mode;
    maxFailures: number;
    repeatEach: number;
    quarantineDays: number;
    allowWarn: boolean;
    checkFlaky: boolean;
    flakyRuns: number;
    mocksBaseUrl?: string;
    appUrl?: string;
    /** Who owns quarantined tests (e.g. the author of the failing commit). */
    owner?: string;
    budget: BudgetLimits;
    provider: Provider | null;
    run?: HealSummary['run'];
    /** Injected engine (tests); default: start playwright-e2e-mcp (or the Cypress tools for a Cypress project). */
    mcp?: ToolCaller;
    /** Folders of fingerprints learned from green runs (`autoheal learn`), read as hints. */
    learnedDirs?: string[];
    /** playwright, pytest or cypress; detected from the project when left out or 'auto'. */
    framework?: Framework | 'auto';
    log?: (line: string) => void;
    /** Run the engine (tests and every proposed fix) as this user; see sandbox.ts. */
    sandbox?: Sandbox | null;
    /** What the PR says about the sandbox. */
    sandboxNote?: string;
    /** Where to save before/after screenshots of kept fixes (the CLI uses <out>/evidence). */
    evidenceDir?: string;
    /** What happened to earlier AutoHeal PRs (see reviews.ts). */
    reviews?: ReviewHistory;
    /** Why reviews could not be read, for the PR. */
    reviewNote?: string;
    /** The repository's .autoheal.yml (see policy.ts); its limits are already applied to the options above. */
    policy?: Policy | null;
    /** The project folder inside the repository ('' at the root), for matching policy paths. */
    repoPrefix?: string;
    /** What the policy changed, for the PR. */
    policyNote?: string;
    /** Folders holding heals recorded during the run (autoheal-healed/), turned into code fixes. */
    healedDirs?: string[];
    /** Earlier runs' results per test (see history.ts), shown with flaky tests. */
    history?: History;
    /** Try an AI fix for flaky tests before quarantining them (default true; needs a provider). */
    fixFlaky?: boolean;
}
export declare function escapeRegex(text: string): string;
/** Spec files that import `rel` (relative imports, or Python module imports). */
export declare function findImporters(root: string, rel: string, maxFiles?: number): Promise<string[]>;
/** Where the engine stores a downloaded CI run (playwright-e2e-mcp 0.15). */
export declare function ciDownloadDir(root: string, url: string): string | null;
export declare function isPytestProject(root: string): Promise<boolean>;
/**
 * The part of the engine's failure report that describes this failure
 * (error, stack, call log, DOM), without the generic advice and run list
 * that follow it, so triage patterns only see real evidence.
 */
export declare function evidenceText(detail: string): string;
/** A Playwright screenshot comparison failure (toHaveScreenshot / toMatchSnapshot on an image). */
export declare function isVisualFailure(f: Pick<FailureInfo, 'message'>): boolean;
/** Did app files change since the baseline was last committed? Then the visual change was intended. */
export declare function visualIntent(root: string, snapDir: string): Promise<{
    intended: boolean;
    commits: string[];
    note: string;
}>;
/** The folders that may hold heals from the run: next to the report, the project, and any given. */
export declare function healedFolders(root: string, report: string, extra?: string[]): string[];
/** What makes two failures one problem: the same broken locator, or the same wrong value. */
export declare function failureGroup(f: Pick<FailureInfo, 'index' | 'expected' | 'actual' | 'kind'>, brokenSelector?: string): string;
export declare function heal(options: HealOptions): Promise<HealSummary>;
export declare function outcomeOf(results: FailureResult[]): Outcome;
