/* global URL, fetch */

/**
 * Project archive and restore through the real UI — issue #184.
 *
 * Everything here is a behaviour a component test cannot reach: this repository has no jsdom, so
 * effects never run in a Vitest render and no fetch, focus move or navigation is observable there.
 * The five acceptance criteria this file owns are exactly the five that need a browser —
 * **archive**, **picker exclusion**, **history visibility**, **restore**, and **keyboard
 * operation** — plus the concealed refusal, asserted against a real session cookie.
 *
 * ## What this file deliberately does not do
 *
 * #184 asks for the server-refusal regression to be driven "with the same cookie as an unauthorized
 * UI user". This build has no way to produce one: `apps/web/server/auth/session.ts` implements a
 * single credential path (the bootstrap administrator), and `POST /api/users` writes no credential,
 * so a provisioned Viewer cannot sign in. The equivalent regression is PostgreSQL-backed instead,
 * in `apps/web/app/api/projects/[id]/archive/lifecycle.test.ts` (#183), which drives every role ×
 * ownership pair through the real route handlers and compares the refusal byte for byte against the
 * answer a nonexistent id gets; `apps/web/server/projects/archive-capability.test.ts` then proves
 * the UI's show/hide answer is the same `decide()` those routes consult. What *is* asserted below
 * with a real cookie is the shape of that concealed answer.
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

/** Unique per run and per Playwright project, so parallel workers never race over one row. */
function projectName(testInfo) {
  return `W9-184 ${testInfo.project.name} ${String(Date.now())}-${String(
    Math.floor(Math.random() * 10000),
  )}`;
}

/** Create a project through the UI and answer with its id, read from the row's own link. */
async function createProject(page, name) {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  const row = page.getByRole('link', { name: new RegExp(name, 'u') });
  await expect(row).toBeVisible();
  const href = await row.getAttribute('href');
  return href.slice(href.lastIndexOf('/') + 1);
}

/**
 * What the composer offers as a destination for new work, or `[]` when it offers nothing.
 *
 * `components/composer/home-chat.tsx` drops the project `<select>` entirely when no active project
 * is left, so an absent picker **is** exclusion rather than a missing control — and that is exactly
 * the state this file creates when it archives the workspace's only project. The catalogue response
 * is what the read is synchronised on: it arrives in an effect, so a picker read taken before it
 * lands cannot tell "not fetched yet" from "nothing to offer".
 */
async function composerProjectOptions(page) {
  const catalogue = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'GET',
  );
  await page.goto('/');
  const body = await (await catalogue).json().catch(() => ({}));
  const offered = Array.isArray(body.projects) ? body.projects : [];
  const picker = page.getByLabel('Project');
  if (offered.length === 0) {
    await expect(picker).toHaveCount(0);
    return [];
  }
  // One `<option>` per project plus the "No project" entry. Waiting for the rendered count keeps
  // the read from landing between the response and React applying it.
  await expect(picker.locator('option')).toHaveCount(offered.length + 1);
  return picker.locator('option').allTextContents();
}

test('archives a project by keyboard, removes it from new-work pickers, and restores it', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = projectName(testInfo);
  const id = await createProject(page, name);

  // Before: the composer offers it as a destination for new work.
  expect(await composerProjectOptions(page)).toContain(name);

  await page.goto(`/projects/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const archive = page.getByRole('button', { name: 'Archive project' });
  await expect(archive).toBeVisible();

  // Keyboard operation, and the focus contract the hand-written dialog owes: Enter opens it, Cancel
  // takes focus (the safe answer is where a stray Enter lands), Escape closes it and gives focus
  // back to the control that opened it.
  await archive.focus();
  await expect(archive).toBeFocused();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog).toContainText(/become read-only|are affected|could not be counted/u);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(archive).toBeFocused();

  // Reopen and confirm, still without the mouse.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Archive project' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');

  // After: the screen says so, and offers the inverse transition instead.
  await expect(page.getByRole('button', { name: 'Restore project' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Archived on' })).toBeVisible();
  // An archived project's settings are read-only — `PATCH` would still succeed, so this is the UI's
  // own decision and is recorded in the task ADR.
  await expect(page.getByLabel('Name')).toBeDisabled();

  // Picker exclusion. This is the assertion that makes the *absence* of `?archived=` in
  // `components/composer/home-chat.tsx` load-bearing: adding one fails here.
  const options = await composerProjectOptions(page);
  expect(options).not.toContain(name);

  // Gone from the default project list, reachable through the explicit history filter.
  await page.goto('/projects');
  await expect(page.getByRole('link', { name: new RegExp(name, 'u') })).toHaveCount(0);
  await page.goto('/projects?archived=archived');
  const archivedRow = page.getByRole('link', { name: new RegExp(name, 'u') });
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow).toContainText('Archived');

  // History keeps the project's name rather than calling it deleted — the `?archived=all` catalogue
  // in `components/run/history-screen.tsx`. Asserted as "the catalogue was read and this project is
  // in it", which is what the screen resolves run attribution against.
  const catalogue = await page.evaluate(async () => {
    const response = await fetch('/api/projects?archived=all', {
      headers: { accept: 'application/json' },
    });
    return response.ok ? await response.json() : { projects: [] };
  });
  expect(catalogue.projects.map((project) => project.name)).toContain(name);

  // Restore returns it to both places.
  await page.goto(`/projects/${id}`);
  await page.getByRole('button', { name: 'Restore project' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore project' }).click();
  await expect(page.getByRole('button', { name: 'Archive project' })).toBeVisible();
  await expect(page.getByLabel('Name')).toBeEnabled();
  expect(await composerProjectOptions(page)).toContain(name);
});

test('keeps the confirmation keyboard-operable after a failed archive', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = projectName(testInfo);
  const id = await createProject(page, name);

  // The `failed` branch is the one where the focus contract is load-bearing: the panel stays open,
  // so a dialog that dropped focus when the browser disabled its buttons leaves Escape and the Tab
  // cycle dead. The success path hides that, because the dialog unmounts and restores focus anyway.
  await page.route('**/api/projects/*/archive', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'service_unavailable', message: 'Archiving is unavailable.' },
      }),
    }),
  );

  await page.goto(`/projects/${id}`);
  const trigger = page.getByRole('button', { name: 'Archive project' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Archive project' }).click();

  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('conceals a refused or missing project behind one indistinguishable answer', async ({
  page,
}) => {
  await signInAsBootstrapAdmin(page, credentials);
  // Issue #183's concealment, seen from a real browser session: an id that names nothing answers
  // exactly what a refused caller is answered, and the UI never claims to tell them apart.
  const answer = await page.evaluate(async () => {
    const response = await fetch('/api/projects/11111111-1111-4111-8111-111111111111/archive', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    return { status: response.status, body: await response.json() };
  });
  expect(answer.status).toBe(404);
  expect(answer.body).toEqual({
    error: { code: 'project_not_found', message: 'Project not found.' },
  });
});

test('keeps the project screens accessible, including while the confirmation is open', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = projectName(testInfo);
  const id = await createProject(page, name);

  await page.goto('/projects');
  await expectBasicAccessibility(page);
  await page.goto('/projects?archived=archived');
  await expectBasicAccessibility(page);

  await page.goto(`/projects/${id}`);
  await expectBasicAccessibility(page);

  await page.getByRole('button', { name: 'Archive project' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // The dialog is named by its own heading rather than by a duplicated `aria-label`.
  const labelledBy = await dialog.getAttribute('aria-labelledby');
  await expect(page.locator(`#${labelledBy}`)).toBeVisible();
  await expectBasicAccessibility(page);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
