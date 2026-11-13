/* global process */

import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['GCP_LIVE_BASE_URL'] ?? 'https://gcp-live-not-configured.invalid';

/** Opt-in browser validation for an already-deployed Google Cloud Run stack; it never starts a local app. */
export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'gcp-cloudrun-live.spec.mjs',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'line',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
    // A trace records input values, so live bootstrap credentials must never enter an artifact.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'gcp-live-chromium', use: { ...devices['Desktop Chrome'] } }],
});
