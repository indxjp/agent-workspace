import { expect, test } from '@playwright/test';

// `expectBasicAccessibility` moved to `./harness.mjs` when issue #184 added a second spec that
// needs it. It stays a helper module rather than an export of this file because importing a spec
// re-registers its tests in the importer and runs them twice.
import { expectBasicAccessibility } from './harness.mjs';

test('sign-in is keyboard operable and exposes validation and error state', async ({ page }) => {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Workspace' })).toBeVisible();
  await expectBasicAccessibility(page);

  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();

  await page.getByLabel('Email').fill('nobody@example.invalid');
  await page.getByLabel('Password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'did not match' })).toBeVisible();
});

test('setup preserves landmarks and named controls at desktop and mobile sizes', async ({
  page,
}) => {
  await page.goto('/setup');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Set up Agent Workspace' }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Setup progress' })).toBeVisible();
  await expectBasicAccessibility(page);
  await expect(page.getByRole('button', { name: /continue/i })).toBeVisible();
});
