/**
 * The structural guard: a fix may change how an element is found or waited
 * for, and nothing else.
 *
 * Both versions of the file are split into tokens (comments dropped,
 * strings kept whole, so a fake comment inside a string cannot hide code),
 * the token streams are diffed, and every changed region must be made only
 * of an allowlisted vocabulary: string and number literals, simple
 * punctuation, locator and wait method names, and identifiers the file
 * already used. A small set of names (process, require, request, route,
 * evaluate, eval, globalThis, os, subprocess...) is never allowed in a
 * change, even if the file already uses it. String concatenation,
 * template expressions, arrow functions and new declarations are not in the
 * vocabulary, so built-up names like '.gi' + 't/config' cannot be written.
 *
 * This is an allowlist: anything it does not know is blocked.
 */
export type Lang = 'js' | 'py';
export interface Token {
    kind: 'str' | 'tmplexpr' | 'num' | 'ident' | 'punct' | 'regex';
    value: string;
}
export declare function tokenizeJs(src: string): Token[];
export declare function tokenizePy(src: string): Token[];
export declare function detectLang(file: string | undefined, source: string): Lang;
export interface AllowlistResult {
    ok: boolean;
    problems: string[];
}
/**
 * Checks that `after` differs from `before` only in locators, waits and
 * literals. Returns the problems found (empty when the change is allowed).
 */
export declare function checkAllowlist(before: string, after: string, file?: string): AllowlistResult;
