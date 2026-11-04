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
import type { Provider } from './providers/types.js';
import { type FailureResult, type HealSummary, type Mode, type Outcome } from './types.js';
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
    /** Injected engine (tests); default: start playwright-e2e-mcp. */
    mcp?: ToolCaller;
    log?: (line: string) => void;
    /** Where to save before/after screenshots of kept fixes (the CLI uses <out>/evidence). */
    evidenceDir?: string;
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
export declare function heal(options: HealOptions): Promise<HealSummary>;
export declare function outcomeOf(results: FailureResult[]): Outcome;
