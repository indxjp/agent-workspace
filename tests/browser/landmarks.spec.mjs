/* global document, getComputedStyle */

/**
 * Every console screen has one `<main>` landmark, its heading inside it and a page margin — UX-24
 * in #2086. Files, Skills, Connectors, API Keys and Settings had none and sat flush against the
 * sidebar. Signed in as the Owner, so every Administration screen is reachable.
 */
import { expect, test } from '@playwright/test';

import { bootstrapAdminCredentials, signInAsBootstrapAdmin } from './harness.mjs';

const credentials = bootstrapAdminCredentials();

test.skip(
  credentials === null,
  'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD are not configured, so no account can sign in.',
);

const SCREENS = [
  '/',
  '/projects',
  '/agents',
  '/agents/new',
  // The Builder chat when the Builder is on, the form when it is off: both draw one <main> (UX-23).
  '/agents/new?mode=chat',
  '/files',
  '/skills',
  '/skills/landmarks-spec-missing',
  '/connectors',
  '/connectors/new',
  '/runs',
  '/admin/models',
  '/admin/storage',
  '/admin/users',
  '/admin/api-keys',
  '/admin/runtimes',
  '/admin/shares',
  '/admin/settings',
];

test('every console screen has one main landmark with its heading and a margin', async ({
  page,
}) => {
  await signInAsBootstrapAdmin(page, credentials);
  for (const screen of SCREENS) {
    await page.goto(screen);
    const main = page.locator('main');
    await expect(main, screen).toHaveCount(1);
    await expect(main.locator('h1'), screen).toHaveCount(1);
    // Polled: `/agents/new?mode=chat` draws the form's <main>, then swaps in the Builder chat's
    // once `/api/me` answers, and a <main> read as it is removed has no computed style (NaN).
    await expect
      .poll(
        () => main.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft)),
        { message: `${screen} left padding` },
      )
      .toBeGreaterThan(0);
  }
});

test('no console screen scrolls sideways at phone width (390 px)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsBootstrapAdmin(page, credentials);
  const wider = [];
  for (const screen of SCREENS) {
    await page.goto(screen);
    await expect(page.locator('main h1'), screen).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) wider.push(`${screen} by ${String(overflow)} px`);
  }
  expect(wider).toEqual([]);
});
