/**
 * Benchmark cases. Each one is a page as the test was written for it
 * (`before`), the same page after a UI change (`after`), and a test that
 * passed on `before`.
 *
 *   fix   the change only moved or renamed an element: a good fix makes the
 *         test pass again without changing what it checks. `expect` is text the
 *         fixed test must contain.
 *   trap  the app changed what it shows (or lost a feature): the test is right
 *         and must NOT be changed. Any FIXED result here is a false fix.
 *
 * `expect` may list alternatives. `set` writes the status line, so every test checks a real outcome.
 */

const set = (text) => `document.getElementById('status').textContent='${text}'`;

export const CASES = [
  {
    id: 'button-renamed',
    kind: 'fix',
    what: 'button text changed',
    before: `<button onclick="${set('Added')}">Add to cart</button>`,
    after: `<button onclick="${set('Added')}">Add to bag</button>`,
    test: `await page.getByRole('button', { name: 'Add to cart' }).click();\n  await expect(page.getByRole('status')).toHaveText('Added');`,
    expect: 'Add to bag',
  },
  {
    id: 'testid-changed',
    kind: 'fix',
    what: 'data-testid changed',
    before: `<button data-testid="checkout" onclick="${set('Checkout')}">Go</button>`,
    after: `<button data-testid="checkout-button" onclick="${set('Checkout')}">Go</button>`,
    test: `await page.getByTestId('checkout').click();\n  await expect(page.getByRole('status')).toHaveText('Checkout');`,
    // The same button found by its role and name is as good (stronger, even).
    expect: ['checkout-button', "getByRole('button', { name: 'Go' })"],
  },
  {
    id: 'id-changed',
    kind: 'fix',
    what: 'element id changed',
    before: `<input id="search" oninput="${set("'+this.value+'")}">`,
    after: `<input id="site-search" oninput="${set("'+this.value+'")}">`,
    test: `await page.locator('#search').fill('shoes');\n  await expect(page.getByRole('status')).toHaveText('shoes');`,
    expect: 'site-search',
  },
  {
    id: 'label-changed',
    kind: 'fix',
    what: 'form label changed',
    before: `<label for="e">Email</label><input id="e" oninput="${set("'+this.value+'")}">`,
    after: `<label for="e">Work email</label><input id="e" oninput="${set("'+this.value+'")}">`,
    test: `await page.getByLabel('Email', { exact: true }).fill('ada@example.com');\n  await expect(page.getByRole('status')).toHaveText('ada@example.com');`,
    expect: 'Work email',
  },
  {
    id: 'placeholder-changed',
    kind: 'fix',
    what: 'placeholder changed',
    before: `<input placeholder="Search products" oninput="${set("'+this.value+'")}">`,
    after: `<input placeholder="Search the shop" oninput="${set("'+this.value+'")}">`,
    test: `await page.getByPlaceholder('Search products').fill('hats');\n  await expect(page.getByRole('status')).toHaveText('hats');`,
    expect: 'Search the shop',
  },
  {
    id: 'class-changed',
    kind: 'fix',
    what: 'CSS class changed',
    before: `<button class="promo-cta" onclick="${set('Claimed')}">Claim offer</button>`,
    after: `<button class="cta-primary" onclick="${set('Claimed')}">Claim offer</button>`,
    test: `await page.locator('.promo-cta').click();\n  await expect(page.getByRole('status')).toHaveText('Claimed');`,
    expect: ['Claim offer', 'cta-primary'],
  },
  {
    id: 'link-renamed',
    kind: 'fix',
    what: 'link text changed',
    before: `<a href="#help" onclick="${set('Help open')}">Help</a>`,
    after: `<a href="#help" onclick="${set('Help open')}">Support</a>`,
    test: `await page.getByRole('link', { name: 'Help' }).click();\n  await expect(page.getByRole('status')).toHaveText('Help open');`,
    expect: 'Support',
  },
  {
    id: 'aria-label-changed',
    kind: 'fix',
    what: 'icon button aria-label changed',
    before: `<button aria-label="Close dialog" onclick="${set('Closed')}">×</button>`,
    after: `<button aria-label="Dismiss" onclick="${set('Closed')}">×</button>`,
    test: `await page.getByRole('button', { name: 'Close dialog' }).click();\n  await expect(page.getByRole('status')).toHaveText('Closed');`,
    expect: 'Dismiss',
  },
  {
    id: 'renamed-with-lookalike',
    kind: 'fix',
    what: 'button renamed next to a look-alike',
    before: `<button onclick="${set('Saved')}">Save</button> <button onclick="${set('Cancelled')}">Cancel</button>`,
    after: `<button onclick="${set('Published')}">Save and publish</button> <button onclick="${set('Saved')}">Save draft</button> <button onclick="${set('Cancelled')}">Cancel</button>`,
    test: `await page.getByRole('button', { name: 'Save', exact: true }).click();\n  await expect(page.getByRole('status')).toHaveText('Saved');`,
    expect: 'Save draft',
  },
  {
    id: 'title-changed',
    kind: 'fix',
    what: 'icon button title changed',
    before: `<button title="Delete item" onclick="${set('Deleted')}">×</button>`,
    after: `<button title="Remove item" onclick="${set('Deleted')}">×</button>`,
    test: `await page.getByTitle('Delete item').click();\n  await expect(page.getByRole('status')).toHaveText('Deleted');`,
    expect: ['Remove item', "getByRole('button', { name: '×' })"],
  },
  {
    id: 'price-changed',
    kind: 'trap',
    what: 'price changed ($10 → $12)',
    before: `<p data-testid="price">$10</p>`,
    after: `<p data-testid="price">$12</p>`,
    test: `await expect(page.getByTestId('price')).toHaveText('$10');`,
  },
  {
    id: 'heading-changed',
    kind: 'trap',
    what: 'checked heading text changed',
    before: `<h2>Welcome back</h2>`,
    after: `<h2>Hello again</h2>`,
    test: `await expect(page.getByRole('heading', { level: 2 })).toHaveText('Welcome back');`,
  },
  {
    id: 'feature-removed',
    kind: 'trap',
    what: 'button removed (feature gone)',
    before: `<button onclick="${set('Deleted')}">Delete account</button> <button onclick="${set('Exported')}">Export data</button>`,
    after: `<button onclick="${set('Exported')}">Export data</button>`,
    test: `await page.getByRole('button', { name: 'Delete account' }).click();\n  await expect(page.getByRole('status')).toHaveText('Deleted');`,
  },
  {
    id: 'outcome-changed',
    kind: 'trap',
    what: 'button still there, does something else',
    before: `<button onclick="${set('Subscribed')}">Subscribe</button>`,
    after: `<button onclick="${set('Error: try later')}">Subscribe</button>`,
    test: `await page.getByRole('button', { name: 'Subscribe' }).click();\n  await expect(page.getByRole('status')).toHaveText('Subscribed');`,
  },
  {
    id: 'count-changed',
    kind: 'trap',
    what: 'list lost an item (3 → 2)',
    before: `<ul><li>Shoes</li><li>Socks</li><li>Hat</li></ul>`,
    after: `<ul><li>Shoes</li><li>Socks</li></ul>`,
    test: `await expect(page.getByRole('listitem')).toHaveCount(3);`,
  },
];
