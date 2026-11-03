import { expect, test } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Fails on the first run of a fresh checkout, passes afterwards: a flaky test.
const marker = path.join(process.cwd(), '.flaky-marker');

test('status badge', async ({ page }) => {
  await page.goto('/status');
  // Creating the marker with 'wx' is atomic: only the very first run succeeds.
  let firstRun = true;
  try {
    writeFileSync(marker, 'seen', { flag: 'wx' });
  } catch {
    firstRun = false;
  }
  await expect(page.getByTestId('status')).toHaveText(firstRun ? 'Degraded' : 'All systems normal');
});

test.afterAll(() => {
  if (process.env.AUTOHEAL_RESET_FLAKY === '1') rmSync(marker, { force: true });
});
