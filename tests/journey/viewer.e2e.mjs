/* global fetch, process */
/**
 * The slice-1 exit test's Viewer check (S1-19, issue #457), untimed: a Viewer key cannot save, so
 * `aw check` with it is refused with `403 forbidden`.
 *
 * The key is minted the way a person mints one on the local runtime: signed in to the workspace in
 * the browser as the bootstrap admin, with the password the launcher printed once. `aw` cannot mint
 * it, because `aw dev` signs `aw` in with the local runtime's own key, and that key may not
 * administer API keys (S1-21, `apps/web/server/cli-auth/local-runtime-key-guard.ts`: "Sign in to the
 * local workspace in the browser to do that"). The key goes to `aw check` over stdin
 * (`--api-key-stdin`) and is never printed, logged or put in an assertion message.
 *
 * `run.mjs` runs it inside the clean container with `playwright.journey.config.mjs`, after the
 * timed journey, against the `aw dev` it started.
 */
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';

import { expect, test } from '@playwright/test';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: start this test with node tests/journey/run.mjs`);
  }
  return value;
}

const BASE_URL = required('JOURNEY_BASE_URL');
const DEMO_DIR = required('JOURNEY_DEMO_DIR');
const ADMIN_EMAIL = required('JOURNEY_ADMIN_EMAIL');
const ADMIN_PASSWORD = required('JOURNEY_ADMIN_PASSWORD');

test('a Viewer key minted in the browser is refused by aw check with 403 forbidden', async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/signin`);
  const form = page.locator('form', { has: page.locator('input[name="password"]') });
  await form.locator('input[name="email"]').fill(ADMIN_EMAIL);
  await form.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((url) => new URL(url).pathname !== '/signin', { timeout: 60_000 });

  // From the page, so the request carries the session cookie and the page's own Origin, as the
  // admin screen's request does.
  const minted = await page.evaluate(async () => {
    const response = await fetch('/api/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'journey-viewer', role: 'viewer', expiresAt: null }),
    });
    /** @type {unknown} */
    const body = await response.json().catch(() => null);
    const key =
      typeof body === 'object' && body !== null && 'key' in body && typeof body.key === 'string'
        ? body.key
        : '';
    const code =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'code' in body.error &&
      typeof body.error.code === 'string'
        ? body.error.code
        : null;
    return { status: response.status, key, code };
  });
  expect(
    minted.status,
    `POST /api/api-keys answered ${String(minted.status)} (${String(minted.code)})`,
  ).toBe(201);
  expect(minted.key.startsWith('ak_live_'), 'the minted key is an ak_live_ key').toBe(true);

  const check = spawnSync('npx', ['aw', 'check', '--api-key-stdin'], {
    cwd: DEMO_DIR,
    input: minted.key,
    encoding: 'utf8',
    timeout: 180_000,
  });
  const output = `${check.stdout}${check.stderr}`.split(minted.key).join('[redacted]');
  expect(check.status, output).toBe(1);
  expect(output).toContain('403 forbidden');
});
