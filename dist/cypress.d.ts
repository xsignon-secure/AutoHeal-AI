/**
 * Cypress support. Healing a Cypress test needs the same steps as a
 * Playwright one (read the failed run, triage, propose, guard, rerun until it
 * is stable), so this module gives heal() the same tool interface as the
 * playwright-e2e-mcp engine, backed by Cypress:
 *
 *   load-report        a Cypress JUnit XML report (the built-in junit reporter),
 *                      mochawesome JSON, or the results of `cypress.run()`
 *   get-failure        one failure, with its kind, expected and actual values
 *   run-test           runs specs through Cypress's module API, as the sandbox
 *                      user, and reports the tests that match `grep`
 *   diagnose-flaky     reruns the spec and compares the outcomes
 *   check-test-change  the whole-tree check against git HEAD (per-file checks
 *                      fall back to the strict local scan)
 *   inspect-page       the engine's page inspector, started on demand
 *
 * Trace-based steps (fingerprints, the runtime guard, engine locator fixes,
 * quarantine) are Playwright features and are reported as unavailable.
 */
import { type ToolCaller, type ToolResult } from './mcp.js';
import { type Sandbox } from './sandbox.js';
export type Framework = 'playwright' | 'pytest' | 'cypress';
/** A Cypress project: a Cypress config and no Playwright config. */
export declare function isCypressProject(root: string): Promise<boolean>;
/** AUTOHEAL_FRAMEWORK / --framework: auto, playwright, pytest or cypress. */
export declare function frameworkSetting(value: string | undefined): Framework | 'auto';
/** One test in a Cypress run. `title` is the full title: describe and it titles joined by spaces, as Cypress prints it. */
export interface CypressTest {
    file: string;
    title: string;
    state: 'passed' | 'failed' | 'pending' | 'skipped';
    message?: string;
    stack?: string;
    screenshot?: string;
}
export interface CypressFailure {
    file: string;
    title: string;
    kind: string;
    message: string;
    stack: string;
    line?: number;
    expected?: string;
    actual?: string;
    screenshotPath?: string;
}
/**
 * Cypress's built-in junit reporter (mocha-junit-reporter). The spec file is
 * on the "Root Suite" testsuite; each testcase's name is the full title.
 */
export declare function parseJunit(xml: string): CypressTest[];
interface MochawesomeSuite {
    file?: string;
    fullFile?: string;
    tests?: Array<{
        title?: string;
        fullTitle?: string;
        state?: string;
        pass?: boolean;
        fail?: boolean;
        pending?: boolean;
        skipped?: boolean;
        err?: {
            message?: string;
            estack?: string;
        };
    }>;
    suites?: MochawesomeSuite[];
}
/** mochawesome JSON (also after mochawesome-merge). */
export declare function parseMochawesome(report: {
    results?: MochawesomeSuite[];
}): CypressTest[];
interface ModuleRun {
    spec?: string | {
        relative?: string;
        absolute?: string;
    };
    tests?: Array<{
        title?: string[] | string;
        state?: string;
        displayError?: string | null;
        error?: string | null;
    }>;
    screenshots?: Array<{
        path?: string;
    }>;
}
/** The results of `cypress.run()` (the module API), or AutoHeal's slim copy of them. */
export declare function parseModuleResults(report: {
    runs?: ModuleRun[];
}): CypressTest[];
/** Any of the three formats, by content. Returns null when this is not a Cypress result. */
export declare function parseCypressReport(text: string): CypressTest[] | null;
/** Expected and actual values from Cypress and chai assertion messages. */
export declare function cypressValues(message: string): {
    expected?: string;
    actual?: string;
};
/** The engine's failure kinds, from a Cypress error. */
export declare function cypressKind(message: string): string;
export declare function toFailure(test: CypressTest): CypressFailure;
export declare function failureMarkdown(f: CypressFailure): string;
/** A spec path from a report, as a path relative to the project. */
export declare function specPath(root: string, file: string): string;
/** Cypress's failure screenshot for a test: "<describe> -- <it> (failed).png" under a screenshots folder. */
export declare function matchScreenshot(pngs: string[], test: CypressTest): string | undefined;
export interface CypressToolsOptions {
    sandbox?: Sandbox | null;
    env?: NodeJS.ProcessEnv;
    /** The runner script (tests can point this at their own). */
    runner?: string;
    log?: (line: string) => void;
}
interface RunOutcome {
    tests: CypressTest[];
    error?: string;
}
export declare function runnerScript(): string;
export declare class CypressTools implements ToolCaller {
    private readonly root;
    private readonly options;
    private failures;
    private engine;
    private readonly env;
    constructor(root: string, options?: CypressToolsOptions);
    call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
    /**
     * Adds a quarantine entry to playwright-quarantine.json (the same file and
     * format as Playwright projects). The xsignon-autoheal/cypress plugin reads it:
     * the test still runs, but its failures do not fail the build until `until`.
     */
    private quarantine;
    close(): Promise<void>;
    private loadReport;
    private getFailure;
    /** Runs specs through the runner script (as the sandbox user when there is one). */
    runSpecs(specs: string[], timeoutMs: number): Promise<RunOutcome>;
    private runTest;
    private diagnoseFlaky;
    /** Per-file checks are the strict local scan's job; the whole-tree check compares each file with git HEAD. */
    private checkChange;
    private inspect;
}
export {};
