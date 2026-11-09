/**
 * AutoHeal AI for Playwright Test: healing during the run.
 *
 *   import { test, expect } from 'xsignon-autoheal/playwright';
 *
 * or, in your own fixtures file:
 *
 *   import { test as base } from '@playwright/test';
 *   import { withAutoHeal } from 'xsignon-autoheal/playwright';
 *   export const test = withAutoHeal(base);
 *
 * See dist/runtime-heal.js for what is healed and what never is.
 */
import { test as base, expect } from '@playwright/test';
import { withAutoHeal } from '../dist/runtime-heal.js';

export const test = withAutoHeal(base);
export { expect, withAutoHeal };
