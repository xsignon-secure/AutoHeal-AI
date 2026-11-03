import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PORT ?? 4310);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15_000,
  expect: { timeout: 2_000 },
  reporter: [['list'], ['json', { outputFile: 'playwright-report/results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node app/server.mjs',
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: true,
    env: { PORT: String(port) },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
