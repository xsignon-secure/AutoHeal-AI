/**
 * Guard v2, the runtime half: compare what the test actually did before and
 * after a fix, from Playwright traces. The code scan sees only text; this
 * sees which assertions ran, against which values, on which page, and where
 * on the page each action landed.
 *
 * Before = the failed CI run's trace (it stops at the failure).
 * After  = one extra traced run of the fixed test.
 *
 * BLOCK when the fixed run
 *   - skips an assertion the failed run made, or checks another value
 *     (fewer or different checks);
 *   - makes a shared step on another page (origin + path);
 *   - acts on an element somewhere else on the page than the failed run did,
 *     for the steps both runs got through (same app, same commit, so the same
 *     element sits in the same place).
 */
export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface RunStep {
    kind: 'expect' | 'action' | 'navigate';
    /** "Expect \"toHaveText\"", "Click", "Navigate"… */
    title: string;
    /** What Playwright shows as the target, e.g. getByTestId('price'). */
    target?: string;
    expected?: string;
    /** origin + path of the page the step ran on. */
    page?: string;
    box?: Box;
    /** When the step's browser call ended (trace clock), for picking its screenshot. */
    end?: number;
    failed: boolean;
}
export interface RunRecord {
    steps: RunStep[];
    /** The step that failed, if any. */
    failedAt?: number;
}
export interface RuntimeFinding {
    rule: 'runtime-fewer-checks' | 'runtime-other-page' | 'runtime-other-element' | 'runtime-no-checks';
    message: string;
}
/** Reads the steps of one test from a trace.zip's entries. */
export declare function recordFromTrace(entries: Map<string, Buffer>): RunRecord;
/** Reads a regular file through one handle (no symlinks, size checked on the open file), or null. */
export declare function readTrace(file: string): Promise<Buffer | null>;
export declare function recordFromFile(file: string): Promise<RunRecord | null>;
/** Compares the failed run with the fixed run. Empty = nothing suspicious. */
export declare function compareRuns(before: RunRecord, after: RunRecord): RuntimeFinding[];
/** The newest trace.zip under `dir` written after `since` whose title ends with `title`. */
export declare function findTrace(root: string, dirs: string[], since: number, title: string): Promise<string | null>;
