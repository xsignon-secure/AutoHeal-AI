// The Pro plan must cost $10. The app now shows $12: a real regression that
// AutoHeal must report, not "fix".
describe('pricing', () => {
  it('pro plan price', () => {
    cy.visit('/pricing');
    cy.get('[data-testid="pro-price"]').should('have.text', '$10');
  });
});
