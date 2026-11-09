import type { test as base } from '@playwright/test';
export { expect } from '@playwright/test';
export type { AutoHealOptions, HealedEntry, RuntimeMode } from '../dist/runtime-heal.js';
import type { AutoHealOptions } from '../dist/runtime-heal.js';
/** Playwright's `test` with AutoHeal's healing during the run. */
export declare const test: typeof base;
/** Adds healing during the run to your own `test` (from @playwright/test or your fixtures). */
export declare function withAutoHeal<T>(test: T, options?: AutoHealOptions): T;
