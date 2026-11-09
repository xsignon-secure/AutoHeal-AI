/**
 * What the xsignon-autoheal/cypress plugin saw during a run: for each test, the
 * elements its cy.get / .find calls found (as fingerprints) and, when a query
 * found nothing and the test failed, the page at that moment. AutoHeal reads
 * these the way it reads Playwright traces, so Cypress gets fingerprint fixes
 * with no AI tokens too.
 */
import { type El } from './snapshot.js';
import type { TraceDom } from './fingerprints.js';
export declare const CYPRESS_DOM_DIR = "cypress/autoheal";
export interface CypressDom {
    spec: string;
    title: string;
    dom: TraceDom;
}
/** Puts parent links back into a tree that came through JSON (non-enumerable, like the browser side). */
export declare function restoreTree(raw: unknown, parent?: El, depth?: number): El | null;
/** One saved file, checked field by field. */
export declare function parseCypressDom(text: string): CypressDom | null;
/** Every saved file under the given folders (inside the project only). */
export declare function loadCypressDoms(root: string, dirs: string[]): Promise<CypressDom[]>;
/** The saved run of one failing test (same spec, same full title). */
export declare function domFor(doms: CypressDom[], file: string, title: string): TraceDom | undefined;
/**
 * The strongest CSS selector that picks exactly this element, in the order
 * Cypress recommends: data-cy / data-test / data-testid first, then a stable
 * id, then name or aria-label with the tag. Null when none is unique.
 */
export declare function cypressSelectorFor(target: El, root: El): string | null;
/** Matches a selector as the first argument of cy.get(...) or .find(...), in any quote style. */
export declare function cypressPattern(selector: string): RegExp;
/** The source with every cy.get / .find of the old selector changed to the new one. */
export declare function replaceCypressSelector(source: string, old: string, next: string): {
    next: string;
    before: string;
    after: string;
} | null;
/** The `it(...)` titles in a spec, for quarantine entries (Cypress reports the full title). */
export declare function itTitles(source: string): string[];
/** The own title of a test from its full title (describe titles joined by spaces). */
export declare function ownTitle(fullTitle: string, source: string): string | undefined;
