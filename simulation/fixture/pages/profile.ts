import type { Locator, Page } from '@playwright/test';

export class ProfilePage {
  readonly greeting: Locator;

  constructor(private readonly page: Page) {
    this.greeting = page.locator('#greeting');
  }

  async open(): Promise<void> {
    await this.page.goto('/profile');
  }
}
