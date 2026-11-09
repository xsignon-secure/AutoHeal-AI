/**
 * Healing during the run, for Playwright Test. In your fixtures file:
 *
 *   import { test as base } from '@playwright/test';
 *   import { withAutoHeal } from 'xsignon-autoheal/playwright';
 *   export const test = withAutoHeal(base);
 *
 * (or `import { test, expect } from 'xsignon-autoheal/playwright'`).
 *
 * When an action (click, fill, check…) is about to wait on an element that
 * is not on the page, and AutoHeal has a fingerprint of what that locator
 * found before, it looks for that element on the current page. A clear match
 * is used for this one action, the test goes on, and the heal is written to
 * `autoheal-healed/` and the test's annotations. The AutoHeal job then turns
 * it into a proven code fix (stability rerun, anti-cheat guard) in a PR.
 *
 * Never healed: assertions (`expect(...)`, so checked values never move),
 * weak or unclear matches, frames other than the main one, and anything when
 * AUTOHEAL_RUNTIME=off (AutoHeal's own reruns always set that) or `report`
 * (records what it would have done, then lets the action fail as usual).
 */
import { type FingerprintEntry } from './fingerprints.js';
import { type ParsedLocator } from './locators.js';
import { type El } from './snapshot.js';
export declare const HEALED_DIR = "autoheal-healed";
export type RuntimeMode = 'heal' | 'report' | 'off';
export interface HealedEntry {
    version: 1;
    /** Spec file, relative to the project root, forward slashes. */
    file: string;
    /** Full title (describe titles and the test title joined by " › "). */
    title: string;
    /** Playwright's selector for the locator that found nothing. */
    selector: string;
    /** The locator used instead. */
    locator: ParsedLocator;
    /** The same, as code. */
    code: string;
    page?: string;
    score: number;
    signals: string[];
    /** What the test did with it. */
    action: string;
    /** heal: the action used the new locator; report: it only recorded it. */
    mode: 'heal' | 'report';
    at: string;
}
export interface AutoHealOptions {
    /** heal (default), report or off; AUTOHEAL_RUNTIME wins when set. */
    mode?: RuntimeMode;
    /** How long an element may be missing before AutoHeal looks for it (ms, default 3000). */
    waitMs?: number;
    /** Project root, for fingerprints and file names (default: the current folder). */
    root?: string;
    /** Where heals are written (default autoheal-healed/, or AUTOHEAL_HEALED_DIR). */
    outDir?: string;
    /** Test id attribute your config uses (default data-testid). */
    testIdAttribute?: string;
}
export declare function runtimeMode(env: NodeJS.ProcessEnv, fallback?: RuntimeMode): RuntimeMode;
/** The page as AutoHeal's element tree. Runs in the browser; keep it self-contained. */
export declare function serializeDom(): unknown;
/** A clear, unique replacement for the selector on this page, or null. */
export declare function healOnPage(entry: FingerprintEntry, root: El, testIdAttribute?: string): {
    locator: ParsedLocator;
    score: number;
    signals: string[];
} | null;
interface PwLocator {
    _selector?: string;
    _frame?: unknown;
    page(): PwPage;
    count(): Promise<number>;
    first(): PwLocator;
    waitFor(o: {
        state: string;
        timeout: number;
    }): Promise<void>;
    [k: string]: unknown;
}
interface PwPage {
    url(): string;
    mainFrame(): unknown;
    evaluate<T>(fn: () => T): Promise<T>;
    locator(s: string): PwLocator;
    getByRole(role: string, o?: {
        name?: string;
        exact?: boolean;
    }): PwLocator;
    getByLabel(t: string, o?: {
        exact?: boolean;
    }): PwLocator;
    getByPlaceholder(t: string, o?: {
        exact?: boolean;
    }): PwLocator;
    getByText(t: string, o?: {
        exact?: boolean;
    }): PwLocator;
    getByAltText(t: string, o?: {
        exact?: boolean;
    }): PwLocator;
    getByTitle(t: string, o?: {
        exact?: boolean;
    }): PwLocator;
    getByTestId(t: string): PwLocator;
}
export declare function toLocator(page: PwPage, loc: ParsedLocator): PwLocator;
/**
 * Your Playwright `test` with healing during the run. Pass options, or set
 * AUTOHEAL_RUNTIME=heal|report|off and AUTOHEAL_HEAL_AFTER_MS.
 */
export declare function withAutoHeal<T>(test: T, options?: AutoHealOptions): T;
/** Every heal recorded under these folders (any `autoheal-healed/` inside them, or the folder itself). */
export declare function loadHealed(dirs: string[]): Promise<HealedEntry[]>;
export {};
