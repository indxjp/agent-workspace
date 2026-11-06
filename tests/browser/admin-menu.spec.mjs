/* global fetch */

/**
 * The Administration menu by role — UX-12 in #2086.
 *
 * A Builder saw every Administration entry; Models, Storage, Users, API Keys and Runtimes answered
 * `403`, and Settings printed its subsystem probes' `403`s. A
 * Builder is provisioned through `POST /api/users` and signed in with `newMemberContext`; the
 * Owner's own sidebar is the control.
 */
import { expect, test } from '@playwright/test';

import { bootstrapAdminCredentials, newMemberContext, signInAsBootstrapAdmin } from './harness.mjs';

const credentials = bootstrapAdminCredentials();

test.skip(
  credentials === null,
  'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD are not configured, so no account can sign in.',
);

const MANAGERS_ONLY = ['Models', 'Storage', 'Users', 'API Keys', 'Runtimes'];

test('a Builder sees only the Administration entries it may use', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const sidebar = page.getByRole('navigation').first();
  for (const label of [...MANAGERS_ONLY, 'Shared links', 'Settings']) {
    await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
  }

  const email = `builder-${testInfo.project.name}-${String(Date.now())}@example.invalid`;
  const created = await page.evaluate(async (address) => {
    const response = await fetch('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: address, name: 'Builder', role: 'builder' }),
    });
    return response.status;
  }, email);
  expect(created).toBe(201);

  const member = await newMemberContext(browser, page, email, { baseURL });
  try {
    const builder = await member.newPage();
    await builder.goto('/');
    const nav = builder.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Agents', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Shared links', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    for (const label of MANAGERS_ONLY) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0);
    }
    // The runtime chip still names the driver, but does not lead to the Runtimes screen.
    await expect(builder.locator('a[href="/admin/runtimes"]')).toHaveCount(0);

    // Settings: the Features card, and no subsystem probe answering 403.
    await builder.goto('/admin/settings');
    await expect(builder.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(builder.locator('#features')).toBeVisible();
    await expect(builder.getByText('/api/users')).toHaveCount(0);
  } finally {
    await member.close();
  }
});
