import process from 'node:process';

import { defineConfig, devices } from '@playwright/test';

/**
 * The apps lane's journeys (`tests/apps/lane.mjs`, issue #1531): each example app's
 * `examples/<id>/e2e/*.e2e.mjs`, against that app under `aw dev`. It starts no server of its own:
 * the lane installs and starts the app, signs a person in, and runs this config with the app's
 * `APPS_E2E_*` variables, one app at a time. Running it directly fails on the first missing one.
 */
export default defineConfig({
  testDir: './examples',
  testMatch: '*/e2e/*.e2e.mjs',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    // The lane reads which journeys passed from this report (APPS_E2E_REPORT names it per app).
    ['json', { outputFile: process.env['APPS_E2E_REPORT'] ?? 'test-results/apps/report.json' }],
    ['html', { open: 'never', outputFolder: 'playwright-report/apps' }],
  ],
  // One app's journeys stay inside 15 minutes, so the lane reports its own failure well inside
  // the CI job's timeout.
  globalTimeout: 15 * 60_000,
  timeout: 3 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: 'test-results/apps',
  use: {
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
    // A trace would record the person token the lane signs in with; a throwaway, but an artifact.
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
