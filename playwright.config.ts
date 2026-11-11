import { defineConfig, devices } from '@playwright/test';

import { env } from './src/config/env';

const results = `results/${env.label}`;

export default defineConfig({
  testDir: 'src/tests',
  outputDir: `${results}/test-output`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Above the sum of the per-step waits in the page checks.
  timeout: 120_000,
  reporter: [
    ['list'],
    ['json', { outputFile: `${results}/playwright.json` }],
    ['html', { outputFolder: `${results}/html`, open: 'never' }],
  ],
  use: {
    baseURL: env.baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'api', testDir: 'src/tests/api' },
    {
      name: 'pages',
      testDir: 'src/tests/pages',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
