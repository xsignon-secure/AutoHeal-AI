import { expect, test } from '@playwright/test';

// The Pro plan costs $10. If the app ever shows something else, this test is
// right to fail, and AutoHeal must open an issue instead of "fixing" it.
test('pro plan price', async ({ page }) => {
  await page.goto('/pricing');
  await expect(page.getByTestId('pro-price')).toHaveText('$10 a month');
});
