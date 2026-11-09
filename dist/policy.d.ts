/**
 * The policy file: `.autoheal.yml` at the root of the repository.
 *
 * It lets a team say, in the repo, what AutoHeal may do: which folders it
 * must never change, which tests it leaves alone, which kinds of fixes it may
 * propose, and tighter limits. It is read from the commit being healed,
 * before any test runs, by both the heal job and the publish job.
 *
 * A policy can only make AutoHeal stricter than the workflow: limits take the
 * lower (or, for repeat-each and min-confidence, the higher) of the two, and
 * a switch the workflow turned off stays off. A broken policy file stops the
 * job instead of being ignored, so a typo never silently loosens anything.
 *
 * The parser reads a small, safe part of YAML: maps, lists of plain values,
 * inline lists, quoted strings, numbers, booleans and comments. No anchors,
 * tags, multi-line strings or documents.
 */
export declare const POLICY_FILE = ".autoheal.yml";
export type FixSource = 'rules' | 'fingerprint' | 'same-change' | 'ai' | 'baseline';
export declare const FIX_SOURCES: FixSource[];
export type StrengthName = 'strong' | 'good' | 'fair' | 'weak';
export interface Policy {
    /** Repo-relative globs AutoHeal never changes. */
    protect: string[];
    /** Tests AutoHeal leaves alone: by file glob, or by text in the title. */
    skip: {
        files: string[];
        titles: string[];
    };
    fixes: {
        allow: FixSource[];
        minStrength?: StrengthName;
        maxPerPr?: number;
    };
    quarantine: {
        enabled: boolean;
        maxDays?: number;
    };
    limits: {
        maxUsd?: number;
        maxFailures?: number;
        repeatEach?: number;
    };
    issues: {
        enabled: boolean;
        minConfidence?: number;
    };
}
export declare class PolicyError extends Error {
}
export declare function defaultPolicy(): Policy;
type Value = string | number | boolean | Value[] | {
    [k: string]: Value;
};
/** Parses the YAML subset described above. */
export declare function parsePolicyYaml(text: string): Record<string, Value>;
/** Checks a parsed policy and fills in defaults. Unknown settings are errors. */
export declare function readPolicy(raw: Record<string, unknown>): Policy;
/**
 * Loads `.autoheal.yml` from the repository root. Null when there is none.
 * Throws PolicyError when it exists but is not valid.
 */
export declare function loadPolicy(repoRoot: string): Policy | null;
/** A path glob (`**`, `*`, `?`) as a matcher, without building a regex from the text. */
export declare function globMatcher(pattern: string): (file: string) => boolean;
export declare function isProtected(policy: Policy | null | undefined, repoPath: string): boolean;
/** The skip rule that matches this test, if any. */
export declare function skipRule(policy: Policy | null | undefined, repoPath: string, title: string): string | undefined;
/** True when a locator of this strength is below the policy's minimum. */
export declare function tooWeak(policy: Policy | null | undefined, strength: StrengthName): boolean;
/** The workflow's limits, made stricter by the policy (never looser). */
export declare function tighten<T extends {
    maxFailures: number;
    repeatEach: number;
    quarantineDays: number;
    maxUsd: number;
}>(workflow: T, policy: Policy | null | undefined): T & {
    changed: string[];
};
/** One line for the PR saying what the policy changed. */
export declare function policyText(policy: Policy, changed?: string[]): string;
export {};
