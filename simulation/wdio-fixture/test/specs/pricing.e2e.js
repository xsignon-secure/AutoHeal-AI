// The app raised the price to $12 without a matching change here: an app bug, not a test bug.
describe('pricing', () => {
  it('pro plan price', async () => {
    await browser.url('/pricing');
    await expect($('[data-testid="pro-price"]')).toHaveText('$10');
  });
});
