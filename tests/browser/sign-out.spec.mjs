/**
 * Sign out (refactoring part 06, step 4): the sidebar's "Sign out" expires the session cookie and
 * lands on the sign-in screen, and the old session no longer opens the console or the API. Before
 * this, nothing ended a session: a shared computer stayed signed in until the cookie expired.
 */
import { expect, test } from '@playwright/test';

import { bootstrapAdminCredentials, signInAsBootstrapAdmin } from './harness.mjs';

test('Sign out ends the session in this browser', async ({ page, context }) => {
  const credentials = bootstrapAdminCredentials();
  expect(
    credentials,
    'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD must be configured so the journey can sign in.',
  ).not.toBeNull();

  await signInAsBootstrapAdmin(page, credentials);
  const sessionCookie = async () =>
    (await context.cookies()).find((cookie) => cookie.name.startsWith('__Host-aw_session'));
  expect(await sessionCookie()).toBeDefined();
  expect((await page.request.get('/api/me')).status()).toBe(200);

  // At phone width the navigation sits behind the Menu button.
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page).toHaveURL(/\/signin$/u);
  expect(await sessionCookie()).toBeUndefined();
  expect((await page.request.get('/api/me')).status()).toBe(401);

  await page.goto('/');
  await expect(page).toHaveURL(/\/signin/u);
});
