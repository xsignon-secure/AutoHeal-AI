// Every guard bypass found in AutoHeal's audits, as before → after edits of one spec.
// Each one must be BLOCKED. `legit` cases are real fixes that must still PASS.
// Reused by test/bypass-corpus.test.mjs; safe to show users as the guard's test set.

export const spec = `import { expect, test } from '@playwright/test';

const HOME = '/';

test('checkout total', async ({ page }) => {
  await page.goto(HOME);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByRole('checkbox', { name: 'Gift wrap' })).toBeChecked();
  await expect(page.getByText('Total $10')).toBeVisible();
  await expect(page.getByTestId('price')).toHaveText('$10');
});
`;

/** [audit, name, find, replace] — applied with String.replace on `spec`. */
export const bypasses = [
  // Audit 1 (0.1.x)
  ['audit 1', 'changed expected value', "toHaveText('$10')", "toHaveText('$12')"],
  ['audit 1', 'removed assertion', "  await expect(page.getByTestId('price')).toHaveText('$10');\n", ''],
  ['audit 1', 'commented-out assertion', "  await expect(page.getByTestId('price'))", "  // await expect(page.getByTestId('price'))"],
  ['audit 1', 'test.skip', "test('checkout total'", "test.skip('checkout total'"],
  ['audit 1', 'early return', "  await page.goto(HOME);\n", "  await page.goto(HOME);\n  return;\n"],
  ['audit 1', 'swallowed error', ".click();", ".click().catch(() => {});"],
  ['audit 1', 'trivial assertion', "  await expect(page.getByText", "  expect(true).toBe(true);\n  await expect(page.getByText"],
  ['audit 1', 'faked network answer', "  await page.goto(HOME);", "  await page.route('**/api/*', (r) => r.fulfill({ body: '$10' }));\n  await page.goto(HOME);"],
  ['audit 1', 'environment read', "  await page.goto(HOME);", "  const t = process.env.GITHUB_TOKEN;\n  await page.goto(HOME);"],
  ['audit 1', 'fake comment inside a string', "  await page.goto(HOME);", "  const a = '/*'; require('fs'); const b = '*/';\n  await page.goto(HOME);"],
  ['audit 1', 'split string', "  await page.goto(HOME);", "  await page.goto('file://' + '.gi' + 't/config');"],
  ['audit 1', 'fixed wait', "  await page.goto(HOME);", "  await page.goto(HOME);\n  await page.waitForTimeout(3000);"],
  ['audit 1', 'force: true', ".click();", ".click({ force: true });"],
  // Audit 2 (0.3.0 re-audit)
  ['audit 2', 'fake data: page', 'page.goto(HOME)', "page.goto('data:text/html,<h1>Total $10</h1>')"],
  ['audit 2', "attacker's site", 'page.goto(HOME)', "page.goto('https://evil.example/')"],
  ['audit 2', 'deleted step', "  await page.getByRole('button', { name: 'Add to cart' }).click();\n", ''],
  ["audit 2", "test['skip']", "test('checkout total'", "test['skip']('checkout total'"],
  ['audit 2', 'widened with .or()', "page.getByText('Total $10')", "page.getByText('Total $10').or(page.locator('body'))"],
  ['audit 2', 'whole-page locator', "page.getByText('Total $10')", "page.locator('body')"],
  // Audit 3 (0.3.2)
  ['audit 3', 'expected text in getByText changed', "getByText('Total $10')", "getByText('Total')"],
  ['audit 3', 'expected text swapped for a test id', "getByText('Total $10')", "getByTestId('total')"],
  ['audit 3', 'state option flipped in the matcher', '.toBeChecked()', '.toBeChecked({ checked: false })'],
  ['audit 3', 'role name inside expect changed', "{ name: 'Gift wrap' }", "{ name: 'Newsletter' }"],
  ['audit 3', 'navigation constant changed', "const HOME = '/';", "const HOME = '/thanks';"],
  ['audit 3', 'protocol-relative URL', "const HOME = '/';", "const HOME = '//evil.example/';"],
  ['audit 3', 'click neutered to hover', ".click();", ".hover();"],
  ['audit 3', 'await removed from an action', "  await page.getByRole('button', { name: 'Add to cart' }).click();", "  page.getByRole('button', { name: 'Add to cart' }).click();"],
];

export const legit = [
  ['renamed button in an action', "name: 'Add to cart'", "name: 'Add to basket'"],
  ['role locator swapped for a test id in an action', "page.getByRole('button', { name: 'Add to cart' })", "page.getByTestId('add-to-cart')"],
  ['test id inside expect changed', "getByTestId('price')", "getByTestId('order-price')"],
  ['.first() added', ".click();", ".first().click();"],
  ['readiness wait added', "  await page.getByRole('button'", "  await expect(page.getByRole('heading', { name: 'Cart' })).toBeVisible();\n  await page.getByRole('button'"],
];
