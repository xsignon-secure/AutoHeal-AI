/**
 * Reads the DOM snapshots inside a Playwright trace (the ones the trace
 * viewer shows), so AutoHeal can see which element each step acted on and
 * what the page looked like when a locator stopped matching.
 *
 * Snapshots are stored incrementally: a node can be a reference
 * [[snapshotsAgo, nodeIndex]] to a node of an earlier snapshot of the same
 * frame, where nodeIndex counts that snapshot's nodes in post-order. This
 * module resolves those references the same way the trace viewer does.
 */
export interface El {
    tag: string;
    attrs: Record<string, string>;
    children: Array<El | string>;
    parent?: El;
}
/** One resolved DOM snapshot of a frame, taken for one call. */
export interface DomSnapshot {
    callId: string;
    /** before, action, after (or the older before@/input@/after@ names). */
    phase: string;
    frameUrl?: string;
    root: El;
}
interface RawSnapshot {
    callId?: string;
    phase?: string;
    snapshotName?: string;
    frameId?: string;
    pageId?: string;
    frameUrl?: string;
    html?: unknown;
}
/**
 * Resolves every frame snapshot in the trace lines. `wanted` limits which
 * calls get a resolved tree (resolving is the expensive part).
 */
export declare function readSnapshots(lines: Array<{
    type?: string;
    snapshot?: RawSnapshot;
}>, wanted?: (callId: string, phase: string) => boolean): DomSnapshot[];
export declare function elements(root: El): El[];
export declare function textOf(e: El, max?: number): string;
/** The element a call acted on: marked __playwright_target__ in that call's snapshot. */
export declare function targetOf(snapshot: DomSnapshot): El | null;
export declare function roleOf(e: El): string;
/** The text of the <label> for a form control. */
export declare function labelOf(e: El): string;
/** A close approximation of the accessible name. */
export declare function nameOf(e: El, role?: string): string;
/** What identifies an element, saved so it can be found again after the app changes. */
export interface Fingerprint {
    tag: string;
    role?: string;
    name?: string;
    text?: string;
    testId?: string;
    id?: string;
    nameAttr?: string;
    type?: string;
    label?: string;
    placeholder?: string;
    href?: string;
    /** The nearest heading, legend or labelled landmark around it. */
    near?: string;
}
export declare function fingerprintOf(e: El): Fingerprint;
/** 0..1 word overlap. */
export declare function similarity(a: string | undefined, b: string | undefined): number;
export interface Match {
    element: El;
    fingerprint: Fingerprint;
    /** 0..1, share of the saved fingerprint that the element still has. */
    score: number;
    /** How far ahead of the next best element it is. */
    margin: number;
    /** Signals that matched, for the PR. */
    signals: string[];
}
export interface MatchOptions {
    /**
     * The value an assertion checks. Text equal to it never counts toward a
     * match, so a fingerprint cannot steer a check onto another element that
     * happens to show the expected value.
     */
    expected?: string;
    /** The failing step is an action (click, fill…), not an assertion. */
    action?: boolean;
}
/** Finds the element that best matches a saved fingerprint, or null when no match is clear. */
export declare function bestMatch(saved: Fingerprint, candidates: El[], options?: MatchOptions): Match | null;
export {};
