/**
 * Builds the Markdown people see: the pull request body, the issue for an
 * app bug, the comment in comment mode, and the job summary. Every claim in
 * them comes from a check that ran (triage signals, both anti-cheat scans,
 * the stability rerun, the spend counters).
 */
import type { FailureResult, HealSummary } from './types.js';
export declare function prBody(summary: HealSummary): string;
/** GitHub rejects bodies over 65,536 characters. */
export declare function fitGithub(text: string, max?: number): string;
export declare function issueTitle(r: FailureResult): string;
export declare function issueBody(summary: HealSummary, r: FailureResult): string;
export declare function commentBody(summary: HealSummary): string;
/** Makes text safe inside a Markdown table cell: backslashes first, then pipes and line breaks. */
export declare function cell(text: string): string;
export declare function jobSummary(summary: HealSummary): string;
/** A short diff excerpt of two versions of a file (changed lines with a little context). */
export declare function shortDiff(file: string, before: string, after: string, context?: number, maxLines?: number): string;
