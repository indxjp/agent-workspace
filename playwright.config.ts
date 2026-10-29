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
// The Builder journey's run stack (`builder-chat.spec.mjs`): its own web server, database, runner,
// gateway and scripted upstream, on ports of their own. Nothing here is shared with the two servers
// above, whose runs must keep being refused.
const builderPorts = {
  web: process.env['E2E_PORT_BUILDER'] ?? '3212',
  runner: process.env['E2E_PORT_RUNNER'] ?? '3213',
  gateway: process.env['E2E_PORT_GATEWAY'] ?? '3214',
  upstream: process.env['E2E_PORT_UPSTREAM'] ?? '3215',
};
for (const [name, value] of Object.entries(builderPorts)) {
  if (!/^\d{1,5}$/u.test(value))
    throw new Error(`The ${name} port must be a port number, got ${value}`);
}
const baseURL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${port}`;
const baseURL2 = process.env['E2E_BASE_URL_2'] ?? `http://127.0.0.1:${port2}`;

// A database of its own, named after the suite's, so the journey's rows never reach the seeded one.
const builderDatabaseURL = process.env['DATABASE_URL']
  ? (() => {
      const url = new URL(process.env['DATABASE_URL']);
      url.pathname = `${url.pathname}_builder`;
      return url.href;
    })()
  : '';
process.env['E2E_PORT_UPSTREAM'] ??= builderPorts.upstream;
const loopback = (value: string) => `http://127.0.0.1:${value}`;

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

// Test-only secrets of the Builder stack; the processes listen on loopback and keep no real data.
const builderSecret = 'builder-browser-stack-secret-at-least-32-bytes';
const builderStack = {
  AW_DEPLOYMENT_POSTURE: 'local',
  HOST: '127.0.0.1',
  DATABASE_URL: builderDatabaseURL,
  GATEWAY_TOKEN_SECRET: builderSecret,
};
const builderWorkspaceRoot = path.join(tmpdir(), 'agent-workspace-browser-builder');

// The sequence is the order they start in: the support process makes the database and the upstream
// that the gateway and the web server need, and the web server comes last because it asks the others.
const builderServers = [
  {
    command: 'node tests/browser/builder-stack.mjs',
    port: Number(builderPorts.upstream),
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // The gateway's provider registry replays the script only in the local posture.
      AW_DEPLOYMENT_POSTURE: 'local',
      HOST: '127.0.0.1',
      AW_SCRIPTED_MODELS_DIR: path.resolve('tests/builder/scripted/browser'),
      BUILDER_DATABASE_URL: builderDatabaseURL,
      BUILDER_UPSTREAM_PORT: builderPorts.upstream,
    },
  },
  {
    command: 'node apps/runner/dist/index.js',
    url: `${loopback(builderPorts.runner)}/healthz`,
    reuseExistingServer: false,
    env: {
      ...builderStack,
      PORT: builderPorts.runner,
      RUNTIME_DRIVER: 'local',
      RUNNER_WORKSPACE_ROOT: builderWorkspaceRoot,
    },
  },
  {
    command: 'node packages/gateway/dist/index.js',
    port: Number(builderPorts.gateway),
    reuseExistingServer: false,
    env: {
      ...builderStack,
      PORT: builderPorts.gateway,
      GATEWAY_CONTROL_PLANE_ORIGIN: loopback(builderPorts.web),
      GATEWAY_PRICING_JSON: JSON.stringify({
        version: 'builder-browser',
        models: {
          'anthropic:claude-sonnet-5-5': { inputUsdPerMillion: '0', outputUsdPerMillion: '0' },
        },
      }),
    },
  },
  {
    command: `pnpm --filter @agent-workspace/web exec next start -p ${builderPorts.web}`,
    url: `${loopback(builderPorts.web)}/signin`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...builderStack,
      RUNNER_URL: loopback(builderPorts.runner),
      MODEL_GATEWAY_URL: loopback(builderPorts.gateway),
      RUNNER_WORKSPACE_ROOT: builderWorkspaceRoot,
    },
  },
];

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
  webServer: [webServer(port, baseURL), webServer(port2, baseURL2), ...builderServers],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: projectIgnore, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-chromium',
      // The Builder journey changes its stack's state and runs once, in the desktop project.
      testIgnore: [...projectIgnore, /builder-chat\.spec\.mjs/u],
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'two-server',
      testMatch: /two-server\.spec\.mjs/u,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
