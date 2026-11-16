import process from 'node:process';

import { defineConfig, devices } from '@playwright/test';

/**
 * The app kit's browser journeys (issue #1509): J3 against the desk fixture app
 * (`packages/app/fixtures/desk`), a Next.js app on the kit's published entry points with an
 * in-memory store and a scripted Agent Workspace. The default config (`playwright.config.ts`)
 * starts only the platform and ignores `tests/browser/app-kit`, because the platform never imports
 * an app; this one starts only the fixture.
 *
 * The fixture is not a pnpm workspace member (that would add a lockfile importer): `next` is the
 * app kit's own devDependency, run from `packages/app`. Its packages are read from their `dist/`,
 * so build the workspace first (`pnpm build`).
 *
 * The fixture keeps its tickets in memory for the life of the server, so the server is never
 * reused and a test is never retried: a second attempt would start from the first one's changes.
 */
const port = process.env['E2E_PORT_APP_KIT'] ?? '3220';
if (!/^\d{1,5}$/u.test(port))
  throw new Error(`E2E_PORT_APP_KIT must be a port number, got ${port}`);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser/app-kit',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  ...(process.env['CI'] ? { workers: 2 } : {}),
  // The JSON report is what scripts/ci/playwright-no-skip.mjs reads to fail a skipped test.
  reporter: process.env['CI']
    ? [
        ['line'],
        ['html', { open: 'never', outputFolder: 'playwright-report/app-kit' }],
        ['json', { outputFile: 'playwright-report/app-kit-results.json' }],
      ]
    : 'list',
  outputDir: 'test-results/app-kit',
  webServer: {
    command: `pnpm --dir packages/app exec next build fixtures/desk && pnpm --dir packages/app exec next start fixtures/desk -p ${port} -H 127.0.0.1`,
    url: `${baseURL}/tickets`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { NEXT_TELEMETRY_DISABLED: '1' },
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
