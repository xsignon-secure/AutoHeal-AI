/**
 * Starts the app under test for the heal job (start-command), so the AI can
 * check locators against the real page instead of only the trace.
 *
 * The app is the repository's own code, so it is treated like the tests: it
 * runs in the sandbox when there is one, with the same scrubbed environment
 * as the engine (no AI key, no runner tokens), and is stopped when the job ends.
 */
import { type Sandbox } from './sandbox.js';
export interface StartedApp {
    url: string;
    /** For the PR: what ran and how. */
    note: string;
    stop(): Promise<void>;
}
export interface StartOptions {
    command: string;
    url: string;
    cwd: string;
    timeoutMs?: number;
    sandbox?: Sandbox | null;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    /** Injected for tests. */
    fetchFn?: typeof fetch;
}
/** Only plain http(s) URLs on this machine: the app runs here. */
export declare function checkAppUrl(url: string): URL;
/** Starts the command, waits until the URL answers, and returns a handle to stop it. */
export declare function startApp(options: StartOptions): Promise<StartedApp>;
