import { defineConfig, devices } from '@playwright/test';

// Not 3000: that is the local dev stack, and with `reuseExistingServer` the suite would attach to
// it and create invitations, archive projects and change members in the developer's own data.
const port = process.env['E2E_PORT'] ?? '3210';
if (!/^\d{1,5}$/u.test(port)) throw new Error(`E2E_PORT must be a port number, got ${port}`);
const baseURL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  ...(process.env['CI'] ? { workers: 2 } : {}),
  reporter: process.env['CI'] ? [['line'], ['html', { open: 'never' }]] : 'list',
  webServer: {
    command: `pnpm --filter @agent-workspace/web exec next start -p ${port}`,
    url: `${baseURL}/signin`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    // The composition root installs the run API, and the surface page and widget loader on top
    // of it, only when a runtime is configured; without one `/p/s/<name>/widget.js` is a 404 and
    // `surface-origins.spec.mjs` has no launcher to press. Nothing listens on the discard port,
    // so no run ever reaches a runtime; the run preflight refuses first (no model connection).
    env: { RUNNER_URL: process.env['RUNNER_URL'] ?? 'http://127.0.0.1:9' },
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
});
