import { expect, test } from '@playwright/test';
import { ProfilePage } from '../pages/profile';

// The page object still uses #greeting; the app renamed it to #welcome-message.
test('profile greets the user', async ({ page }) => {
  const profile = new ProfilePage(page);
  await profile.open();
  await expect(profile.greeting).toHaveText('Hello, Ada');
});
