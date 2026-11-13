/**
 * `autoheal cover`: write a new end-to-end test for a user flow that has no
 * test yet. The AI explores the running app (inspect_page, validate_selector),
 * reads the existing tests for their style, and writes one new spec file.
 *
 * A new test has no "before" to compare with, so it is held to its own bar
 * (cheat.ts scanNewTest): real assertions, an action on the app, no skips,
 * fakes, fixed waits, forced clicks or foreign URLs. Then it must pass
 * `runs` times in a row. Only then is the file kept; you review it like any
 * other change before committing it.
 */
import type { Budget } from './budget.js';
import type { Framework } from './cypress.js';
import type { ToolCaller } from './mcp.js';
import type { Provider } from './providers/types.js';
export interface CoverOptions {
    projectRoot: string;
    /** The user flow, in plain words: "a shopper adds two items and checks out". */
    flow: string;
    /** Where the new test goes (relative to the project); derived from the flow when left out. */
    file?: string;
    /** The running app, for inspect_page and validate_selector. */
    appUrl?: string;
    provider: Provider;
    budget: Budget;
    mcp: ToolCaller;
    framework?: Framework;
    /** Passing runs in a row the new test needs (default 5). */
    runs?: number;
    /**
     * A signed-in session (storageState JSON, relative to the project), from
     * ensureSession. Pages open as that user and the new test must load it.
     */
    session?: string;
    log?: (line: string) => void;
}
export interface CoverResult {
    status: 'written' | 'rejected' | 'gave-up' | 'budget' | 'error';
    file: string;
    explanation: string;
    runs?: number;
    findings?: string[];
    attempts: number;
}
/** A file name from the flow: tests/autoheal-<words>.spec.ts (pytest: tests/test_autoheal_<words>.py). */
export declare function coverFile(flow: string, framework?: Framework, dir?: string): string;
export declare function cover(options: CoverOptions): Promise<CoverResult>;
