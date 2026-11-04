/**
 * Element fingerprints, kept with the repo (.autoheal/fingerprints/<id>.json,
 * one small file per locator so two AutoHeal PRs never conflict).
 *
 * Every trace AutoHeal reads teaches it what each locator pointed at: the
 * element's role, accessible name, test id, id, label and nearby heading.
 * When that locator stops matching, AutoHeal looks for the element with the
 * same fingerprint on the failed page and writes the strongest locator for
 * it, without AI tokens. Only short labels are stored, never page content
 * beyond an element's own name and text (cut at 120 characters).
 */
import { type DomSnapshot, type Fingerprint } from './snapshot.js';
export declare const FINGERPRINT_DIR = ".autoheal/fingerprints";
export interface FingerprintEntry {
    at: string;
    /** Playwright's selector for the locator, as in the trace. */
    selector: string;
    /** origin-free path of the page it was seen on. */
    page?: string;
    /** Spec file that used it. */
    file?: string;
    fingerprint: Fingerprint;
}
export declare function fingerprintPath(selector: string, page: string | undefined): string;
export declare function loadFingerprints(projectRoot: string): Promise<FingerprintEntry[]>;
/** The saved fingerprint for a selector, preferring the same page. */
export declare function lookup(entries: FingerprintEntry[], selector: string, page?: string): FingerprintEntry | undefined;
export interface TraceCall {
    callId: string;
    method: string;
    selector?: string;
    failed: boolean;
    /** The element it acted on (from the action snapshot), when it found one. */
    target?: Fingerprint;
    page?: string;
}
export interface TraceDom {
    calls: TraceCall[];
    /** The page at the failing call (its "before" snapshot), when a call failed. */
    failedPage?: DomSnapshot;
    failedCall?: TraceCall;
}
/** Reads each library call's selector and target element from a trace.zip's entries. */
export declare function domFromTrace(entries: Map<string, Buffer>): TraceDom;
export declare function domFromZip(buf: Buffer): TraceDom;
/** Entries learned from a trace: one per selector that found its element. */
export declare function learn(dom: TraceDom, file?: string, at?: string): FingerprintEntry[];
/** Writes entries; returns the paths written (relative, forward slashes). */
export declare function saveFingerprints(projectRoot: string, entries: FingerprintEntry[]): Promise<string[]>;
