/**
 * Learn from reviews: what happened to earlier AutoHeal PRs in this repo.
 *
 * Each AutoHeal PR body carries a hidden list of its fixes. The heal job
 * reads the last closed AutoHeal PRs (read-only token, pull-requests: read)
 * and sorts each fix into:
 *   merged  kept as AutoHeal wrote it
 *   edited  merged after someone pushed changes on top (their edit is read)
 *   closed  closed without merging: the fix was not wanted
 * The AI sees this as repo memory, and a deterministic fix that reviewers
 * already closed once is not proposed again.
 */
export type ReviewOutcome = 'merged' | 'edited' | 'closed';
/** One fix as written into the PR body marker. */
export interface MarkedFix {
    file: string;
    test: string;
    by: string;
    before?: string;
    after?: string;
}
export interface ReviewedFix extends MarkedFix {
    pr: number;
    outcome: ReviewOutcome;
    at: string;
    /** For edited PRs: what the reviewer changed in this file (short patch). */
    edit?: string;
}
export interface ReviewHistory {
    fixes: ReviewedFix[];
    prs: Record<ReviewOutcome, number>;
}
/** The hidden marker for a PR body. */
export declare function fixesMarker(fixes: MarkedFix[]): string;
export declare function readMarker(body: string | null | undefined): MarkedFix[];
export interface ReviewOptions {
    repo: string;
    token: string;
    apiUrl?: string;
    fetchFn?: typeof fetch;
    max?: number;
}
/** Reads the last closed AutoHeal PRs. Throws on an API error (the caller reports it). */
export declare function reviewHistory(options: ReviewOptions): Promise<ReviewHistory>;
/** Lines for the AI's repo memory. */
export declare function reviewText(history: ReviewHistory, file?: string, limit?: number): string;
/** A deterministic change reviewers already closed once. */
export declare function rejected(history: ReviewHistory | undefined, file: string, before: string | undefined, after: string | undefined): ReviewedFix | undefined;
