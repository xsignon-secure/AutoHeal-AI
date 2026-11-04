/**
 * Find the cause: the app commit that made a test fail.
 *
 * A fixed locator says what changed on the page ("Log in" became "Sign in",
 * #greeting became #welcome-message); an app bug says which value changed
 * ($10 became $12). AutoHeal searches the repository history for the most
 * recent commit, outside the tests, that removed the old text or added the
 * new one (git log -S), and names it in the PR or the issue. One UI change
 * that broke many tests then shows up as one commit.
 *
 * Needs history in the checkout (fetch-depth). With a shallow clone the
 * search simply finds nothing.
 */
export interface Cause {
    commit: string;
    short: string;
    subject: string;
    author?: string;
    date?: string;
    /** App files the commit changed (up to 5). */
    files: string[];
    /** What in the commit matched, e.g. `"Log in" → "Sign in" in app/login.tsx`. */
    evidence: string;
}
export interface CauseQuery {
    /** Text that disappeared from the app (the old locator text, the expected value). */
    removed: string[];
    /** Text that appeared (the new locator text, the actual value). */
    added: string[];
}
/** String literals in a locator expression, without CSS punctuation (#id → id). */
export declare function literals(expr: string): string[];
/** What a locator change removed and added, as search terms. */
export declare function termsFromLocators(changes: Array<{
    before: string;
    after: string;
}>): CauseQuery;
/** The most recent app commit that removed the old text and/or added the new one. */
export declare function findCause(root: string, query: CauseQuery, depth?: number): Promise<Cause | null>;
/** Search terms for an app bug: the expected value is gone, the actual one is new. */
export declare function termsFromValues(expected: string | undefined, actual: string | undefined): CauseQuery;
