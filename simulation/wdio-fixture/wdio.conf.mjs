// The dummy shop (simulation/fixture/app/server.mjs, copied in by the simulation) on port 4321.
const binary = process.env.WDIO_CHROME_BINARY;
export const config = {
  runner: 'local',
  specs: ['./test/specs/**/*.e2e.js'],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'], ...(binary ? { binary } : {}) },
    },
  ],
  baseUrl: 'http://127.0.0.1:4321',
  logLevel: 'error',
  waitforTimeout: 2000,
  framework: 'mocha',
  mochaOpts: { timeout: 30000 },
  reporters: [['junit', { outputDir: 'reports' }]],
};
