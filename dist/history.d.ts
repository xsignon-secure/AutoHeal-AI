/**
 * Failure history: how often each test failed across AutoHeal's runs. Kept
 * outside the repository, as the newest `autoheal-history` artifact on GitHub
 * (or a file you pass with AUTOHEAL_HISTORY_FILE, e.g. a CI cache). Each heal
 * run reads it, adds this run's results, and saves it again, so a flaky test's
 * PR and issue say how long it has been flaky.
 */
import type { CiInfo } from './ci.js';
import type { FailureResult } from './types.js';
export declare const HISTORY_ARTIFACT = "autoheal-history";
export declare const HISTORY_FILE = "history.json";
export interface HistoryRun {
    at: string;
    status: string;
}
export interface History {
    version: 1;
    tests: Record<string, {
        file: string;
        title: string;
        runs: HistoryRun[];
    }>;
}
export declare const emptyHistory: () => History;
/** Parses history JSON, keeping only well-formed entries. */
export declare function parseHistory(text: string): History;
/** Adds this run's results; drops the tests seen least recently past the cap. */
export declare function recordRun(history: History, results: FailureResult[], at: string): History;
/** How often this test failed before this run. */
export declare function historyOf(history: History | null | undefined, file: string, title: string): {
    failures: number;
    flaky: number;
    since: string;
} | null;
/** The newest history: a local file, or the newest autoheal-history artifact on GitHub. */
export declare function fetchHistory(ci: CiInfo, env: NodeJS.ProcessEnv): Promise<{
    history: History;
    note: string;
}>;
