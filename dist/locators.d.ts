/**
 * Locators as Playwright sees them (internal selectors in traces) and as the
 * test source writes them (getByRole(...), get_by_role(...)), plus a strength
 * ranking that follows Playwright's own advice: role and accessible name
 * first, then label, placeholder, text, alt, title, test id, and CSS last.
 */
import { type El } from './snapshot.js';
export type LocatorKind = 'role' | 'label' | 'placeholder' | 'text' | 'alt' | 'title' | 'testid' | 'css';
export interface ParsedLocator {
    kind: LocatorKind;
    /** Role for kind role; the text, label or test id otherwise; the CSS for kind css. */
    value: string;
    name?: string;
    exact?: boolean;
}
export type Strength = 'strong' | 'good' | 'fair' | 'weak';
/** The last part of a Playwright selector (after the final >>), parsed. Null for chains it cannot express. */
export declare function parseSelector(selector: string): ParsedLocator | null;
/** A regex that finds this locator call in source code (JS/TS or Python). */
export declare function sourcePattern(loc: ParsedLocator, python: boolean): RegExp;
/** Source code for a locator, in the file's language and quote style. */
export declare function renderLocator(loc: ParsedLocator, python: boolean, quote?: string): string;
/**
 * The strongest locator that picks exactly this element on the page, in
 * Playwright's order of preference. Null when nothing is unique.
 */
export declare function locatorFor(target: El, root: El, testIdAttr?: string): ParsedLocator | null;
/** Rank of a locator written in source (lower is stronger). */
export declare function rankOf(expr: string): number;
export declare function strengthOf(expr: string): Strength;
/** Locator calls in a piece of source. */
export declare function locatorCalls(source: string): string[];
export interface LocatorChange {
    before: string;
    after: string;
    from: Strength;
    to: Strength;
    /** -1 weaker, 0 same, 1 stronger. */
    direction: -1 | 0 | 1;
}
/** Locators that a change replaced, by comparing removed and added lines. */
export declare function locatorChanges(before: string, after: string): LocatorChange[];
