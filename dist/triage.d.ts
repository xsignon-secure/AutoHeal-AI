/**
 * Triage: decide what kind of failure this is before anyone touches code.
 * Only TEST_BUG is ever "healed". A real regression (APP_BUG) gets an issue
 * with evidence, never a patch that makes the test agree with the bug.
 *
 * Deterministic signals come first; the AI model only refines low-confidence
 * calls (see agent.ts), and can never move a failure into TEST_BUG on its own
 * when the signals say APP_BUG with high confidence.
 */
export type Category = 'TEST_BUG' | 'APP_BUG' | 'FLAKY' | 'ENV';
export type RootCause = 'LOCATOR_DRIFT' | 'HYDRATION_RACE' | 'MOCK_DRIFT' | 'REGRESSION' | 'TIMING' | 'INFRA' | 'UNKNOWN';
export interface TriageInput {
    /** Engine failure kind: assertion, timeout, browser-crash, syntax, config, server-unreachable, unknown. */
    kind: string;
    message: string;
    expected?: string;
    actual?: string;
    /** diagnose-flaky verdict on the unchanged code. */
    flakyVerdict?: string;
    /** check-mocks found a mock that no longer matches the live API. */
    mockDrift?: boolean;
    /** The engine proposed a verified locator replacement. */
    locatorFix?: boolean;
}
export interface Triage {
    category: Category;
    rootCause: RootCause;
    /** 0..1 */
    confidence: number;
    reasons: string[];
}
export declare function triage(input: TriageInput): Triage;
