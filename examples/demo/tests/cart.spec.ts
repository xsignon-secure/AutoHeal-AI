import { expect, test } from '@playwright/test';

test('add a mug to the cart', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-mug').click();
  await expect(page.getByRole('status')).toHaveText('1 item in your cart');
});
