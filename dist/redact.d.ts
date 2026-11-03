/**
 * Scrubs secrets from text before it leaves the runner: the AI prompt, PR
 * and issue bodies, comments, the job summary and summary.json. A failing
 * test can print a token in an error, a console log or the page itself;
 * none of that should land in a PR that the whole org (or the world) reads.
 *
 * Two layers: well-known credential shapes, and the literal values of every
 * secret-looking environment variable on the runner (GitHub masks its own
 * secrets in logs, but not in files AutoHeal writes).
 */
export declare const REDACTED = "[REDACTED]";
/** Literal secret values from the environment (8+ characters, longest first). */
export declare function secretValues(env?: NodeJS.ProcessEnv): string[];
export declare function makeRedactor(env?: NodeJS.ProcessEnv): (text: string) => string;
/** Redacts with the current process environment. */
export declare function redact(text: string): string;
/** Redacts every string inside a JSON-like value. */
export declare function redactDeep<T>(value: T, fn?: (text: string) => string): T;
