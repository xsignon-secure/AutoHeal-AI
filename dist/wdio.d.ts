/**
 * WebdriverIO support (Mocha or Jasmine specs). The same tool interface as
 * the Cypress adapter, backed by WebdriverIO:
 *
 *   load-report   JUnit XML from @wdio/junit-reporter, or JSON from
 *                 wdio-json-reporter, in the folder you pass
 *   run-test      runs specs through WebdriverIO's Launcher (scripts/wdio-run.mjs),
 *                 as the sandbox user, one test at a time with mochaOpts.grep
 *
 * Healing is by AI (there are no Playwright traces, so no fingerprints and no
 * runtime guard), proven by reruns and the anti-cheat scan, which knows
 * WebdriverIO's ways to fake a pass (browser.execute, browser.mock, pause).
 * Selenium (Java, Python) and Appium are not supported yet.
 */
import { CypressTools, type CypressFailure, type CypressTest } from './cypress.js';
import { type ToolResult } from './mcp.js';
export declare const WDIO_CONFIGS: string[];
/** A WebdriverIO project: a wdio config and no Playwright config. */
export declare function isWdioProject(root: string): Promise<boolean>;
export declare function wdioConfig(root: string): Promise<string | null>;
/** @wdio/junit-reporter: each testsuite names its spec in a `file` property. */
export declare function parseWdioJunit(xml: string): CypressTest[];
interface WdioJson {
    specs?: string[];
    suites?: Array<{
        name?: string;
        tests?: Array<{
            name?: string;
            fullTitle?: string;
            state?: string;
            error?: string;
            errorType?: string;
            standardError?: string;
        }>;
    }>;
}
/** wdio-json-reporter output (one file per worker). */
export declare function parseWdioJson(report: WdioJson): CypressTest[];
export declare function parseWdioReport(text: string): CypressTest[] | null;
/** The failure kind from a WebdriverIO error. */
export declare function wdioKind(message: string): string;
export declare function wdioFailure(test: CypressTest): CypressFailure;
export declare function wdioRunnerScript(): string;
export declare class WdioTools extends CypressTools {
    protected readonly label: string;
    protected validateNote(): string;
    protected inspectNote(): string;
    protected markdown(f: CypressFailure): string;
    protected loadReport(report: string): Promise<ToolResult>;
    /** Runs specs through WebdriverIO's Launcher, as the sandbox user when there is one. */
    runSpecs(specs: string[], timeoutMs: number, grep?: string): Promise<{
        tests: CypressTest[];
        error?: string;
    }>;
    call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
}
export {};
