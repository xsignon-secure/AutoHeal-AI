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

const ENV_KINDS = new Set(['browser-crash', 'server-unreachable', 'config']);
const HYDRATION = /hydrat|not attached to the dom|element is detached|detached from (the )?dom|element is not stable|intercepts pointer events|element is not enabled/i;
const LOCATOR =
  /strict mode violation|resolved to 0 elements|element\(s\) not found|no element matches|waiting for (locator|getBy\w+)\(|locator\.\w+: (timeout|error)|unable to find (an )?element|getBy\w+\(.*\) (did not|resolved)/i;
const INFRA = /ECONNREFUSED|ERR_CONNECTION_REFUSED|net::ERR_|ENOTFOUND|EADDRINUSE|executable doesn't exist|browserType\.launch|out of memory|ENOSPC/i;

export function triage(input: TriageInput): Triage {
  const reasons: string[] = [];
  const message = `${input.message}\n${input.actual ?? ''}`;

  if (input.flakyVerdict === 'FLAKY') {
    return { category: 'FLAKY', rootCause: 'TIMING', confidence: 0.9, reasons: ['passes and fails on the same code (diagnose-flaky: FLAKY)'] };
  }
  if (input.flakyVerdict === 'NOT REPRODUCING') {
    return {
      category: 'FLAKY',
      rootCause: 'TIMING',
      confidence: 0.7,
      reasons: ['failed in CI but passed every rerun here (diagnose-flaky: NOT REPRODUCING)'],
    };
  }
  if (ENV_KINDS.has(input.kind) || INFRA.test(message)) {
    reasons.push(ENV_KINDS.has(input.kind) ? `failure kind is ${input.kind}` : 'the error points at the environment, not the test');
    return { category: 'ENV', rootCause: 'INFRA', confidence: 0.85, reasons };
  }
  if (input.kind === 'syntax') {
    return { category: 'ENV', rootCause: 'INFRA', confidence: 0.6, reasons: ['the test code does not compile; a person should fix it'] };
  }
  if (input.mockDrift) {
    return { category: 'TEST_BUG', rootCause: 'MOCK_DRIFT', confidence: 0.8, reasons: ['a mocked API response no longer matches the live API (check-mocks)'] };
  }
  if (HYDRATION.test(message)) {
    return {
      category: 'TEST_BUG',
      rootCause: 'HYDRATION_RACE',
      confidence: 0.7,
      reasons: ['the element was found but was detached, unstable or covered: the test acted before the page was ready'],
    };
  }
  // The element was found and showed a different value: the app changed, not the locator.
  if (input.kind === 'assertion' && input.expected !== undefined && input.actual !== undefined && !/element\(s\) not found/i.test(message)) {
    return {
      category: 'APP_BUG',
      rootCause: 'REGRESSION',
      confidence: 0.75,
      reasons: [`the element was found but showed a different value (expected ${clip(input.expected)}, got ${clip(input.actual)})`],
    };
  }
  if (input.locatorFix || LOCATOR.test(message)) {
    reasons.push(input.locatorFix ? 'the engine found a verified replacement locator in the trace' : 'the locator matched no element or too many');
    return { category: 'TEST_BUG', rootCause: 'LOCATOR_DRIFT', confidence: input.locatorFix ? 0.9 : 0.75, reasons };
  }
  if (input.kind === 'timeout') {
    return { category: 'APP_BUG', rootCause: 'UNKNOWN', confidence: 0.4, reasons: ['the test timed out without a clear locator or app signal'] };
  }
  return { category: 'APP_BUG', rootCause: 'UNKNOWN', confidence: 0.35, reasons: ['no clear signal; treated as a possible app bug so nothing is hidden'] };
}

function clip(value: string, max = 60): string {
  const one = value.replace(/\s+/g, ' ').trim();
  return JSON.stringify(one.length > max ? `${one.slice(0, max)}…` : one);
}
