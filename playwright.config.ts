import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

// Not 3000: that is the local dev stack, and with `reuseExistingServer` the suite would attach to
// it and create invitations, archive projects and change members in the developer's own data.
// The second port serves the two-server project (the storage design, §07) and has the same rule.
const port = process.env['E2E_PORT'] ?? '3210';
if (!/^\d{1,5}$/u.test(port)) throw new Error(`E2E_PORT must be a port number, got ${port}`);
const port2 = process.env['E2E_PORT_2'] ?? '3211';
if (!/^\d{1,5}$/u.test(port2)) throw new Error(`E2E_PORT_2 must be a port number, got ${port2}`);
const baseURL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${port}`;
const baseURL2 = process.env['E2E_BASE_URL_2'] ?? `http://127.0.0.1:${port2}`;

// A project's `testIgnore` replaces the top-level one, so the live-deployment spec is repeated here.
// The two-server spec runs only in its own project; ignoring it elsewhere keeps it from being
// collected (and skipped) twice, which the no-skip gate would reject.
const projectIgnore = [
  /two-server\.spec\.mjs/u,
  ...(process.env['CI'] ? ['**/azure-preview-live.spec.mjs'] : []),
];

// The one folder a `file` storage connection may name. Set here, before the servers start, so the
// servers and every worker (which evaluates this file again) agree on it;
// `storage-connections-browse.spec.mjs` writes its folders under it.
process.env['AW_STORAGE_CONNECTION_FILE_ROOTS'] ??= path.join(
  tmpdir(),
  'agent-workspace-browser-connections',
);
mkdirSync(process.env['AW_STORAGE_CONNECTION_FILE_ROOTS'], { recursive: true });

const webServer = (serverPort: string, serverURL: string) => ({
  command: `pnpm --filter @agent-workspace/web exec next start -p ${serverPort}`,
  url: `${serverURL}/signin`,
  reuseExistingServer: !process.env['CI'],
  timeout: 120_000,
  // The composition root installs the run API, and the surface page and widget loader on top
  // of it, only when a runtime is configured; without one `/p/s/<name>/widget.js` is a 404 and
  // `surface-origins.spec.mjs` has no launcher to press. Nothing listens on the discard port,
  // so no run ever reaches a runtime; the run preflight refuses first (no model connection).
  env: { RUNNER_URL: process.env['RUNNER_URL'] ?? 'http://127.0.0.1:9' },
});

export default defineConfig({
  testDir: './tests/browser',
  // Opt-in live-deployment spec: it skips without AZURE_LIVE_*, and it has its own config
  // (playwright.azure-live.config.mjs) and workflow, so it stays out of the gated PR lane.
  ...(process.env['CI'] ? { testIgnore: '**/azure-preview-live.spec.mjs' } : {}),
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  ...(process.env['CI'] ? { workers: 2 } : {}),
  // The JSON report is what scripts/ci/playwright-no-skip.mjs reads to fail a skipped or flaky test.
  reporter: process.env['CI']
    ? [
        ['line'],
        ['html', { open: 'never' }],
        ['json', { outputFile: 'playwright-report/results.json' }],
      ]
    : 'list',
  webServer: [webServer(port, baseURL), webServer(port2, baseURL2)],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: projectIgnore, use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', testIgnore: projectIgnore, use: { ...devices['Pixel 7'] } },
    {
      name: 'two-server',
      testMatch: /two-server\.spec\.mjs/u,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
