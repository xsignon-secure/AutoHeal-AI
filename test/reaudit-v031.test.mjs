// The four cheats from the 0.3.0 re-audit, plus legitimate fixes that must still pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanChange } from '../dist/index.js';

const spec = `import { expect, test } from '@playwright/test';

test('checkout total', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('Total $10')).toBeVisible();
});
`;

const rules = (after) => scanChange(spec, after, 'tests/checkout.spec.ts');
const blocked = (after, rule) => {
  const r = rules(after);
  assert.equal(r.verdict, 'BLOCK', JSON.stringify(r.findings));
  if (rule) assert.ok(r.findings.some((f) => f.rule === rule), `${rule} not in ${JSON.stringify(r.findings.map((f) => f.rule))}`);
};

test('a fake page (data: URL) is blocked', () => {
  blocked(spec.replace("page.goto('/')", "page.goto('data:text/html,<h1>Total $10</h1><button>Add to cart</button>')"), 'navigation-changed');
});

test("an attacker's site is blocked", () => {
  blocked(spec.replace("page.goto('/')", "page.goto('https://evil.example/')"), 'navigation-changed');
});

test('a deleted step is blocked', () => {
  blocked(spec.replace("  await page.getByRole('button', { name: 'Add to cart' }).click();\n", ''), 'step-removed');
});

test("test['skip'] is blocked", () => {
  blocked(spec.replace("test('checkout total'", "test['skip']('checkout total'"), 'skip-added');
  blocked(spec.replace("test('checkout total'", 'test["only"](\'checkout total\''), 'skip-added');
});

test('a widened locator is blocked', () => {
  blocked(spec.replace("page.getByText('Total $10')", "page.getByText('Total $10').or(page.locator('body'))"), 'locator-widened');
  blocked(spec.replace("page.getByText('Total $10')", "page.locator('body')"), 'locator-widened');
});

test('real locator fixes still pass', () => {
  assert.equal(rules(spec.replace("name: 'Add to cart'", "name: 'Add to basket'")).verdict, 'PASS');
  assert.equal(rules(spec.replace("page.getByRole('button', { name: 'Add to cart' })", "page.getByTestId('add-to-cart')")).verdict, 'PASS');
  assert.equal(rules(spec.replace(".click();", ".first().click();")).verdict, 'PASS');
});
