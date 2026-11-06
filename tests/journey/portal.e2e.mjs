/* global console, fetch, process, setTimeout */
/**
 * J1 (issue #1510): a portal from one `npm create … --template portal`, signed in under `aw dev`.
 * `run.mjs` runs it inside the clean container against the portal's `aw dev`, one test per call,
 * picked with `--grep`:
 *
 * - `portal signs in`, the last step of J1's timed block: once the app's `GET /api/sign-in`
 *   redirects to the issuer (`aw dev` restarts the app with its sign-in after the first sync), `/`
 *   asks to sign in, its link leads to `/sign-in` and on to `aw dev`'s development OIDC issuer, the
 *   bootstrap admin's email and the local console password land back on `/` signed in (the
 *   Sign out button, the app's `HttpOnly` `awo_live_` cookie), and the portal's navigation lists
 *   the entries of the features chosen.
 * - `console shows only the chosen features`, untimed: signed in to the console, the sidebar shows
 *   the entry of every chosen feature and none of a feature left out (ADR-0160 D8).
 *
 * The password reaches it through that one `docker exec`'s environment and is never printed. Named
 * `.e2e.mjs`, not `.spec.mjs`, so the `tests` Vitest project never loads it.
 */
import { URL } from 'node:url';

import { expect, test } from '@playwright/test';

import { consoleEntriesFor } from './harness.mjs';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: start this test with node tests/journey/run.mjs`);
  }
  return value;
}

const APP_URL = new URL(required('JOURNEY_APP_URL')).origin;
const BASE_URL = new URL(required('JOURNEY_BASE_URL')).origin;
const ADMIN_EMAIL = required('JOURNEY_ADMIN_EMAIL');
const ADMIN_PASSWORD = required('JOURNEY_ADMIN_PASSWORD');
const FEATURES = required('JOURNEY_FEATURES').split(',');
/** The portal's own navigation entry of each feature it has a page for (`app-presets.ts`). */
const PORTAL_ENTRIES = /** @type {const} */ ({ chat: 'Chat', files: 'Files', runs: 'Runs' });
/** How long `aw dev` may take to give the app its sign-in after the first sync. */
const SIGN_IN_READY_MS = 180_000;

/** Until the app's `GET /api/sign-in` answers `303` to the issuer, or {@link SIGN_IN_READY_MS}. */
async function untilSignInConfigured() {
  const deadline = Date.now() + SIGN_IN_READY_MS;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const answered = await fetch(`${APP_URL}/api/sign-in`, {
        redirect: 'manual',
        headers: { accept: 'application/json' },
      });
      if (answered.status === 303) return;
      last = String(answered.status);
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`the portal's sign-in was not configured in time (last answer: ${last})`);
}

test('portal signs in', async ({ page, context }) => {
  test.setTimeout(SIGN_IN_READY_MS + 120_000);
  await untilSignInConfigured();

  await page.goto(`${APP_URL}/`);
  await page.getByRole('heading', { name: 'Sign in required' }).waitFor();
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL((url) => new URL(url).pathname === '/sign-in');
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL((url) => new URL(url).pathname === '/authorize');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Local console password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => new URL(url).origin === APP_URL && new URL(url).pathname === '/');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const cookie = (await context.cookies(APP_URL)).find(({ name }) => name === 'aw_user_token');
  expect(cookie?.httpOnly, "the app's person cookie is HttpOnly").toBe(true);
  expect(cookie?.value.startsWith('awo_live_'), 'the cookie holds an awo_live_ token').toBe(true);

  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  for (const feature of FEATURES) {
    const label = Object.hasOwn(PORTAL_ENTRIES, feature)
      ? PORTAL_ENTRIES[/** @type {keyof typeof PORTAL_ENTRIES} */ (feature)]
      : undefined;
    if (label !== undefined) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
  }
  console.log('journey: the portal signed the bootstrap admin in under aw dev');
});

test('console shows only the chosen features', async ({ page }) => {
  const { shown, hidden } = consoleEntriesFor(FEATURES);
  await page.goto(`${BASE_URL}/signin`);
  const form = page.locator('form', { has: page.locator('input[name="password"]') });
  await form.locator('input[name="email"]').fill(ADMIN_EMAIL);
  await form.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((url) => new URL(url).pathname !== '/signin', { timeout: 60_000 });
  const sidebar = page.locator('aside');
  for (const label of shown) {
    await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  for (const label of hidden) {
    await expect(sidebar.getByRole('link', { name: label, exact: true })).toHaveCount(0);
  }
  console.log(`journey: the console shows ${shown.join(', ')} and none of ${hidden.join(', ')}`);
});
