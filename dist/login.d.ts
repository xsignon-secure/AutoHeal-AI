/**
 * Signed-in flows for `autoheal cover` (and KeepGreen, which calls it).
 *
 * Most important flows sit behind a login. AutoHeal reuses the engine's
 * `save-login` tool: it logs in once with steps you give, checks the session,
 * and saves it as a Playwright storageState file. The page tools then open
 * pages as that user, and the new test loads the same file.
 *
 * Secrets never reach the AI or the test file: login steps name them as
 * {{env:E2E_PASSWORD}} (and {{totp}} for an authenticator code), and the
 * engine fills them in at the moment they are typed. The engine only reads
 * variables named E2E_*, TEST_*, PW_*, PLAYWRIGHT_* or LOGIN_*.
 *
 * Without steps, AutoHeal uses a session file you already create (for
 * example with a Playwright setup project) and only checks that it exists.
 */
import type { ToolCaller } from './mcp.js';
export interface LoginConfig {
    /** The storageState file, relative to the project (default playwright/.auth/user.json). */
    session: string;
    /** Login page: a path such as /login, or a full URL on the app. */
    url?: string;
    /** Login steps, one per line: `fill getByLabel('Email') = {{env:E2E_USER}}`. */
    steps?: string[];
    /** A locator only a signed-in user sees, to check the session. */
    check?: string;
    /** Environment variable with the authenticator secret, for {{totp}}. */
    totpEnv?: string;
}
export interface LoginStep {
    type: 'goto' | 'click' | 'dblclick' | 'hover' | 'fill' | 'press' | 'check' | 'uncheck' | 'select' | 'wait';
    locator?: string;
    value?: string;
    url?: string;
    ms?: number;
}
export declare const DEFAULT_SESSION = "playwright/.auth/user.json";
export declare class LoginError extends Error {
    constructor(message: string);
}
/**
 * One step, written the way a person would:
 *   goto /login
 *   fill getByLabel('Email') = {{env:E2E_USER}}
 *   press getByLabel('Password') = Enter
 *   click getByRole('button', { name: 'Sign in' })
 *   wait getByRole('button', { name: 'Sign out' })     (or: wait 500)
 * The value comes after the last " = ", so locators may contain "=".
 */
export declare function parseLoginStep(line: string): LoginStep;
/** The session path: a .json file inside the project, written with forward slashes. */
export declare function checkSessionPath(session: string): string;
/** Steps parsed and checked, before any browser starts. */
export declare function checkLogin(login: LoginConfig): {
    session: string;
    steps: LoginStep[];
};
/**
 * Make sure a working session file exists before anything opens a page.
 * With steps: the engine logs in (or keeps a saved session that still passes
 * the check). Without steps: the file must already be there.
 */
export declare function ensureSession(mcp: ToolCaller, login: LoginConfig, options: {
    projectRoot: string;
    appUrl?: string;
    log?: (line: string) => void;
}): Promise<string>;
/** Where the new test should load the session: Playwright test.use, or pytest's browser_context_args. */
export declare function sessionPrompt(session: string, framework: string): string;
/** The only session a new test may load is the configured one. */
export declare function sessionFindings(content: string, session: string | undefined): string[];
