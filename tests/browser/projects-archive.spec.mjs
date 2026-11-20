/* global fetch */

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
import {
  answerFirstRunStart,
  attachFileThroughComposer,
  composerProjectOptions,
  createProject,
  FILE_NOT_FOUND_ANSWER,
  jsonCaller,
  projectName,
  seedAttachmentSession,
  uploadWithConsoleCookie,
  uploadWithToken,
} from './projects-archive-support.mjs';

const credentials = bootstrapAdminCredentials();

test.skip(
  credentials === null,
  'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD are not configured, so no account can sign in.',
);

const projectLink = (page, name) => page.getByRole('link', { name: new RegExp(name, 'u') });

/**
 * Keyboard operation, and the focus contract the hand-written dialog owes: Enter opens it, Cancel
 * takes focus (the safe answer is where a stray Enter lands), Escape closes it and gives focus
 * back to the control that opened it.
 */
async function expectDialogFocusContract(page, archive) {
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
}

/** Reopen the confirmation and confirm it, still without the mouse. */
async function confirmArchiveByKeyboard(page) {
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Archive project' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
}

/** The screen says the project is archived, and offers the inverse transition instead. */
async function expectArchivedScreen(page) {
  await expect(page.getByRole('button', { name: 'Restore project' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Archived on' })).toBeVisible();
  // An archived project's settings are read-only — `PATCH` would still succeed, so this is the UI's
  // own decision and is recorded in the task ADR.
  await expect(page.getByLabel('Name')).toBeDisabled();
}

/** Gone from the default project list, reachable through the explicit history filter. */
async function expectOnlyInArchivedList(page, name) {
  await page.goto('/projects');
  await expect(projectLink(page, name)).toHaveCount(0);
  await page.goto('/projects?archived=archived');
  const archivedRow = projectLink(page, name);
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow).toContainText('Archived');
}

/**
 * History keeps the project's name rather than calling it deleted — the `?archived=all` catalogue
 * in `components/run/history-screen.tsx`. Asserted as "the catalogue was read and this project is
 * in it", which is what the screen resolves run attribution against.
 */
async function expectHistoryCatalogueNamesProject(page, name) {
  const catalogue = await page.evaluate(async () => {
    const response = await fetch('/api/projects?archived=all', {
      headers: { accept: 'application/json' },
    });
    return response.ok ? await response.json() : { projects: [] };
  });
  expect(catalogue.projects.map((project) => project.name)).toContain(name);
}

/** Restore returns it to both places. */
async function restoreByClick(page, id, name) {
  await page.goto(`/projects/${id}`);
  await page.getByRole('button', { name: 'Restore project' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore project' }).click();
  await expect(page.getByRole('button', { name: 'Archive project' })).toBeVisible();
  await expect(page.getByLabel('Name')).toBeEnabled();
  expect(await composerProjectOptions(page)).toContain(name);
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

  await expectDialogFocusContract(page, archive);
  await confirmArchiveByKeyboard(page);
  await expectArchivedScreen(page);

  // Picker exclusion. This is the assertion that makes the *absence* of `?archived=` in
  // `components/composer/home-chat.tsx` load-bearing: adding one fails here.
  expect(await composerProjectOptions(page)).not.toContain(name);

  await expectOnlyInArchivedList(page, name);
  await expectHistoryCatalogueNamesProject(page, name);
  await restoreByClick(page, id, name);
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

// @story US-STO-11
test('[US-STO-11][browser][chat] an archived project refuses attachments', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = projectName(testInfo);
  const id = await createProject(page, name);
  const call = jsonCaller(page);
  const seeded = await seedAttachmentSession(call, {
    name,
    projectId: id,
    projectKind: testInfo.project.name,
  });
  const upload = { sessionId: seeded.sessionId, token: seeded.token };

  // Before the archive the credential works, so the refusal below is the gate and nothing else.
  const accepted = await uploadWithToken(page, upload);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

  const attached = page.getByRole('list', { name: 'Attached files' });
  const scan = await attachInActiveProject(page, seeded, attached);
  await expectFollowUpCarriesFile(page, seeded.sessionId, scan.fileId);
  await expect(attached).toHaveCount(0);

  const archived = await call('POST', `/api/projects/${id}/archive`);
  expect(archived.status, JSON.stringify(archived.body)).toBeLessThan(300);

  await expectAttachRefusedAfterArchive(page, seeded.sessionId, attached);

  // The project screen is the page that lists the session.
  await page.goto(`/projects/${id}`);
  await expect(page.getByRole('button', { name: 'Restore project' })).toBeVisible();

  const refused = await uploadWithToken(page, upload);
  expect(refused.status).toBe(404);
  expect(refused.body).toEqual(FILE_NOT_FOUND_ANSWER);

  const restored = await call('POST', `/api/projects/${id}/restore`);
  expect(restored.status, JSON.stringify(restored.body)).toBeLessThan(300);
  const again = await uploadWithToken(page, upload);
  expect(again.status, JSON.stringify(again.body)).toBe(201);
});

/**
 * The console: the composer's own Attach file control and the console cookie, no token. The run
 * start is answered for this project's session (see `startedRunBody`), so the screen holds it. In an
 * active project the file is attached and listed where the composer shows attachments; answers with
 * the saved file's description.
 */
async function attachInActiveProject(page, seeded, attached) {
  await answerFirstRunStart(page, seeded);
  await page.goto('/');
  await page.getByTestId('composer-input').fill('Look at the attached file');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Attach file' })).toHaveAttribute(
    'aria-disabled',
    'false',
  );

  const saved = page.waitForResponse(
    (response) => response.url().includes('/attachments') && response.request().method() === 'POST',
  );
  await attachFileThroughComposer(page, 'scan.txt');
  const scan = await (await saved).json();
  await expect(attached).toContainText('scan.txt');
  const direct = await uploadWithConsoleCookie(page, {
    sessionId: seeded.sessionId,
    name: 'direct.txt',
  });
  expect(direct.status).toBe(201);
  return scan;
}

/**
 * The follow-up hands the listed file to its run. The real route rules on the file before anything
 * else can refuse the start, so any answer but `file_not_found` is the console's file admitted; this
 * environment has no model, so the run itself cannot launch.
 */
async function expectFollowUpCarriesFile(page, sessionId, fileId) {
  const followUp = page.waitForRequest(
    (request) => request.url().includes('/runs') && request.method() === 'POST',
  );
  await page.getByRole('textbox', { name: 'Ask a follow-up' }).fill('Read the file');
  await page.getByRole('button', { name: 'Send' }).click();
  const request = await followUp;
  expect(request.postDataJSON()).toMatchObject({ sessionId, attachments: [{ fileId }] });
  const answer = await (await request.response()).json();
  expect(answer.error?.code, JSON.stringify(answer)).not.toBe('file_not_found');
}

/**
 * The open screen learns of the archive on the next attempt: the server refuses, and the control
 * becomes disabled with a reason the screen reader reads, and nothing more is listed. The same
 * cookie, straight at the route, gets the concealed answer, not a different refusal.
 */
async function expectAttachRefusedAfterArchive(page, sessionId, attached) {
  const attach = page.getByRole('button', { name: 'Attach file' });
  await attachFileThroughComposer(page, 'late.txt');
  await expect(attach).toHaveAttribute('aria-disabled', 'true');
  const reason = page.getByText('This project is archived, so files can no longer be attached.');
  await expect(reason).toBeVisible();
  await expect(attach).toHaveAttribute('aria-describedby', await reason.getAttribute('id'));
  await expect(attached).toHaveCount(0);
  const direct = await uploadWithConsoleCookie(page, { sessionId, name: 'late.txt' });
  expect(direct.status).toBe(404);
  expect(direct.body).toEqual(FILE_NOT_FOUND_ANSWER);
}
