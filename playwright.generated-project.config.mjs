import { defineConfig, devices } from '@playwright/test';

/**
 * The generated-project E2E (`tests/generated-project/run.mjs`, issue #398). It starts no server of
 * its own: the suite generates and starts a project, and every test drives that project in order.
 * `run.mjs` prepares the packages and images and starts this config; running it directly fails on
 * the first missing `GP_*` variable.
 */
export default defineConfig({
  testDir: './tests/generated-project',
  testMatch: '*.e2e.mjs',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report/generated-project' }],
  ],
  // The whole suite stays inside 20 minutes, so that with run.mjs's 30-minute preparation cap it
  // fails with its own report well inside the CI job's `timeout-minutes: 60`. A step that needs
  // longer than the default 5 minutes raises its own cap (`pnpm start`).
  globalTimeout: 20 * 60_000,
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: 'test-results/generated-project',
  use: {
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
    // The traces would record the one-time administrator password; it is a throwaway, but a trace
    // is an artifact, and the screenshot and video show what failed without it.
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
