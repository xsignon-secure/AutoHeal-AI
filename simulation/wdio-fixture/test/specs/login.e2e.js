// Written when the button said "Log in". The app now says "Sign in": a test bug.
describe('login', () => {
  it('user can log in', async () => {
    await browser.url('/login');
    await $('#email').setValue('ada@example.com');
    await $('button=Log in').click();
    await expect($('#msg')).toHaveText('Signed in as ada@example.com');
  });
});
