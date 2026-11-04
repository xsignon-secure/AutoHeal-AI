/**
 * Local anti-cheat scan. It runs next to the engine's heal guard
 * (check-test-change) as a second, independent line: a fix is only kept when
 * both agree it does not make the test pass by checking less.
 *
 * BLOCK: fewer assertions, fewer tests, new skip/only/fixme/xfail, an early
 * return, an empty catch that swallows failures.
 *        New code that reaches outside the browser test (environment
 *        variables, child processes, the file system, raw network calls,
 *        eval): a fix runs on the CI runner, so this is how a prompt-injected
 *        AI could leak secrets.
 *        A changed expected value, an assertion that cannot fail, faked
 *        network answers, injected scripts or DOM edits, and dynamic or
 *        obfuscated access that could hide any of the above.
 * WARN:  raised timeouts, waitForTimeout, force: true, weaker matchers,
 * flipped .not, retries. AutoHeal treats WARN as blocking unless
 * AUTOHEAL_ALLOW_WARN=1.
 */
export type Verdict = 'PASS' | 'WARN' | 'BLOCK';
export interface CheatFinding {
    severity: 'BLOCK' | 'WARN';
    rule: string;
    message: string;
}
export interface CheatReport {
    verdict: Verdict;
    findings: CheatFinding[];
}
/** Strip comments so commented-out code neither counts nor hides. */
export declare function stripComments(source: string): string;
export declare function expectations(source: string): string[];
export declare function assertionSubjects(source: string): string[];
export declare function scanChange(before: string, after: string, file?: string): CheatReport;
