import { defineConfig, devices } from '@playwright/test';

/**
 * The slice-1 exit test's browser step (`tests/journey/run.mjs`, S1-19, issue #457). It runs inside
 * the clean container, from `/runner`, against the `aw dev` the journey started. `run.mjs` names
 * one spec per call: `widget.e2e.mjs` opens `/p/s/main/try`, checks the launcher's colour and asks a
 * question the fake provider answers; `viewer.e2e.mjs`, untimed, signs in as the bootstrap admin,
 * mints a Viewer key and checks `aw check` refuses it; `tools.e2e.mjs` (S2-08, issue #550), picked
 * with `--grep`, times B2's look change and asks the widget for the orders tool's data;
 * `origins.e2e.mjs` (80-15, issue #622), untimed, embeds the widget on an allowed and a refused
 * origin; `pinned.e2e.mjs` (80-07, issue #612), untimed, pushes v2 while a conversation on v1 is
 * open and checks its next turn still runs v1; `release.e2e.mjs` (80-08, issue #615), untimed,
 * promotes the demo agent, rolls it back and reads the pointers with `aw versions`;
 * `feedback.e2e.mjs` (80-13, issue #620), untimed, rates an answer down in the widget and turns it
 * into an eval case that `aw eval` fails; `files.e2e.mjs` (STO-407, issue #1687), untimed, uploads
 * a file in Files, grants it to the demo agent, runs the agent from the console and finds its output
 * in Files; `first-hour.e2e.mjs` (FH-13, issue #700), run by
 * `run.mjs --first-hour` in place of the journey, times the first hour. Running it directly fails on the first missing
 * `JOURNEY_*` variable.
 */
export default defineConfig({
  testDir: './tests/journey',
  testMatch: [
    'widget.e2e.mjs',
    'viewer.e2e.mjs',
    'tools.e2e.mjs',
    'origins.e2e.mjs',
    'pinned.e2e.mjs',
    'release.e2e.mjs',
    'feedback.e2e.mjs',
    'files.e2e.mjs',
    'first-hour.e2e.mjs',
  ],
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/journey' }]],
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: 'test-results/journey',
  use: {
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
    // The page carries nothing secret, but a trace is an artifact; the screenshot and the video
    // show what failed without one.
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
