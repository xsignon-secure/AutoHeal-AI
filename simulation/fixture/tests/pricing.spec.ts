import { expect, test } from '@playwright/test';

// The Pro plan must cost $10. The app now shows $12: a real regression the
// test is right to catch. AutoHeal must not "fix" this test.
test('pro plan price', async ({ page }) => {
  await page.goto('/pricing');
  await expect(page.getByTestId('pro-price')).toHaveText('$10');
});
