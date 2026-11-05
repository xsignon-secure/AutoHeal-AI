// The dummy shop (simulation/fixture/app/server.mjs, copied in by the simulation) on port 4320.
module.exports = {
  e2e: {
    baseUrl: 'http://127.0.0.1:4320',
    supportFile: false,
    specPattern: 'cypress/e2e/**/*.cy.js',
    defaultCommandTimeout: 2000,
  },
  video: false,
  screenshotOnRunFailure: true,
};
