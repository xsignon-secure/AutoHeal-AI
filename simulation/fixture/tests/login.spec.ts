import { expect, test } from '@playwright/test';

// Written when the button said "Log in". The app now says "Sign in": a test bug.
test('user can log in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('status')).toHaveText('Signed in as ada@example.com');
});
