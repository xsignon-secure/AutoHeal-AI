// Written when the button said "Log in". The app now says "Sign in": a test bug.
describe('login', () => {
  it('user can log in', () => {
    cy.visit('/login');
    cy.get('#email').type('ada@example.com');
    cy.contains('button', 'Log in').click();
    cy.get('#msg').should('have.text', 'Signed in as ada@example.com');
  });
});
