/* global fetch */

/**
 * Journey J4 through the real UI (06 §2, ADR-0160 D8, issue #1497): an Owner switches a feature off
 * on the Settings screen's Features card, sees its sidebar entry go and its deep link explain, and
 * switches it back on.
 *
 * Every test works in a scratch workspace of its own, created through `POST /api/workspaces` (the
 * caller becomes its sole Owner) and opened through the sidebar's switcher. One `next start`
 * serves every spec in parallel, and switching Files off in the shared workspace would break
 * whichever spec is reading `/files` at that moment; switches are per workspace, so a scratch one
 * keeps the journey to itself. `afterEach` still switches everything back on, so a failed run
 * leaves nothing off behind it.
 */
import { expect, test } from '@playwright/test';

import {
  bootstrapAdminCredentials,
  expectBasicAccessibility,
  signInAsBootstrapAdmin,
} from './harness.mjs';

const credentials = bootstrapAdminCredentials();

test.skip(
  credentials === null,
  'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD are not configured, so no account can sign in.',
);

/** The scratch workspace of the running test, restored by `afterEach`. */
let scratch = null;

function runTag(testInfo) {
  return `${testInfo.project.name}-${String(Date.now())}-${String(
    Math.floor(Math.random() * 10000),
  )}`.toLowerCase();
}

/** Sign in, create a scratch workspace, open it, and land on Settings. */
async function openScratchSettings(page, testInfo) {
  await signInAsBootstrapAdmin(page, credentials);
  const tag = runTag(testInfo);
  const workspace = await page.evaluate(
    async ({ name, slug }) => {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name, slug }),
      });
      return { status: response.status, body: await response.json() };
    },
    { name: `J4 features ${tag}`, slug: `j4-features-${tag}` },
  );
  expect(workspace.status).toBe(201);
  scratch = workspace.body.workspace;

  await page.locator('button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: scratch.name }).click();
  await expect(page.locator('button[aria-haspopup="menu"]')).toContainText(scratch.name);

  await page.goto('/admin/settings');
  await expect(card(page).locator('[data-feature-row]')).toHaveCount(11);
}

function card(page) {
  return page.locator('#features');
}

function toggle(page, label) {
  return card(page).getByRole('switch', { name: label, exact: true });
}

function sidebarLink(page, label) {
  return page.locator('aside').getByRole('link', { name: label, exact: true });
}

test.afterEach(async ({ page }) => {
  if (scratch === null) return;
  const id = scratch.id;
  scratch = null;
  // Everything the deployment installs back on: a feature it does not install stays in the set.
  // A same-origin call from the page, so it carries the session cookie and the `Origin` the write
  // gate checks.
  const restored = await page.evaluate(async (workspaceId) => {
    const path = `/api/workspaces/${workspaceId}/features`;
    const listed = await fetch(path, { headers: { accept: 'application/json' } });
    const disabled = (await listed.json()).features
      .filter((row) => !row.installed)
      .map((row) => row.id);
    const response = await fetch(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ disabled }),
    });
    return response.status;
  }, id);
  expect(restored).toBe(200);
});

test('lists every feature, accessibly, with the switches the server would refuse disabled', async ({
  page,
}, testInfo) => {
  await openScratchSettings(page, testInfo);
  await expectBasicAccessibility(page);

  const runs = toggle(page, 'Runs');
  await expect(runs).toHaveAttribute('aria-disabled', 'true');
  await expect(runs).toHaveAccessibleDescription('Needed by Evaluations, Triggers');

  const chat = toggle(page, 'Chat');
  await expect(chat).toHaveAttribute('aria-disabled', 'true');
  await expect(chat).toHaveAccessibleDescription('Needed by Surfaces');
  // An inert switch stays focusable and does nothing when pressed. (Playwright's `click` waits for
  // an `aria-disabled` element to become enabled, so the press is a key, as a person's would be.)
  await chat.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(chat).toHaveAttribute('aria-checked', 'true');
});

test('switching Files off hides its entry and explains its page; switching it on restores both', async ({
  page,
}, testInfo) => {
  await openScratchSettings(page, testInfo);
  await expect(sidebarLink(page, 'Files')).toHaveCount(1);

  await toggle(page, 'Files').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Switch Files off?');
  await expect(dialog).toContainText('disappear for everyone in this workspace: Files.');
  await expect(dialog).toContainText('Data is kept.');
  await expectBasicAccessibility(page);
  await dialog.getByRole('button', { name: 'Switch Files off' }).click();
  await expect(dialog).toBeHidden();
  await expect(toggle(page, 'Files')).toHaveAttribute('aria-checked', 'false');
  await expect(sidebarLink(page, 'Files')).toHaveCount(0);

  await page.goto('/files');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Files is switched off for this workspace.',
  );
  await expectBasicAccessibility(page);
  await expect(page.getByRole('link', { name: 'Settings → Features' })).toHaveAttribute(
    'href',
    '/admin/settings#features',
  );
  const refused = await page.request.get('/api/files');
  expect(refused.status()).toBe(404);
  expect((await refused.json()).error.code).toBe('feature_disabled');

  await page.goto('/admin/settings');
  await toggle(page, 'Files').click();
  await expect(toggle(page, 'Files')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sidebarLink(page, 'Files')).toHaveCount(1);
  await page.goto('/files');
  await expect(page.getByRole('heading', { level: 1, name: 'Files' })).toBeVisible();
});

test('works from the keyboard alone, and Escape keeps the feature on', async ({
  page,
}, testInfo) => {
  await openScratchSettings(page, testInfo);

  // Projects' switch sits just before Files' in the card's tab order.
  await toggle(page, 'Projects').focus();
  await page.keyboard.press('Tab');
  await expect(toggle(page, 'Files')).toBeFocused();

  await page.keyboard.press('Space');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(toggle(page, 'Files')).toBeFocused();
  await expect(toggle(page, 'Files')).toHaveAttribute('aria-checked', 'true');

  await page.keyboard.press('Space');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Switch Files off' })).toBeFocused();
  // Tab stays inside the dialog while it is open.
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(toggle(page, 'Files')).toHaveAttribute('aria-checked', 'false');
  await expect(toggle(page, 'Files')).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(toggle(page, 'Files')).toHaveAttribute('aria-checked', 'true');
});
