/**
 * Running your tests the way AutoHeal needs them, for `autoheal fix` (on your
 * machine) and `autoheal learn` (fingerprints from a green run): the right
 * reporter, traces on, results in one folder inside the project.
 */
import type { Framework } from './cypress.js';
import { type FingerprintEntry } from './fingerprints.js';
export interface TestRun {
    command: string;
    args: string[];
    env: Record<string, string>;
}
/** The command that runs the tests into `dir` (relative to the project). */
export declare function testRun(framework: Framework, purpose: 'fix' | 'learn', dir: string): TestRun;
/** Runs the tests in the project; returns the exit code. */
export declare function runTests(root: string, run: TestRun, extra?: string[]): number;
/** Fingerprints from every trace.zip under `dir` (a run with traces on). */
export declare function fingerprintsFromTraces(dir: string): Promise<{
    entries: FingerprintEntry[];
    traces: number;
}>;
/** Fingerprints from what the Cypress plugin saved under `dir`. */
export declare function fingerprintsFromCypress(root: string, dir: string): Promise<{
    entries: FingerprintEntry[];
    tests: number;
}>;
/** Writes entries as <id>.json files into a flat folder (the learned folder). */
export declare function writeLearned(dir: string, entries: FingerprintEntry[]): Promise<number>;
