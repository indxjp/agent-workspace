/* global fetch */

/**
 * The agent screen's Versions tab through the real UI — issue #617 (80-10): list → diff → promote
 * → roll back.
 *
 * A console edit is a version (issue #616), so plain `PATCH`es of an agent's instructions make v1,
 * v2 and v3, and the tab is then driven the way a content owner would. The deployment under test
 * sets no promotion bar, so every dry run is open; the gate's verdicts are asserted by
 * `apps/web/components/agents/versions.test.ts` against the same `details` the server sends.
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

/** A same-origin JSON call from the page, so it carries the session cookie and the `Origin`. */
function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    { method, path, body },
  );
}

async function expectOk(answer) {
  expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(300);
  return answer.body;
}

/** Create an agent through the legacy route; it has no version until its first console edit. */
async function createAgent(page, name) {
  const created = await expectOk(
    await api(page, 'POST', '/api/agents', {
      name,
      instructions: 'Seed',
      modelConnectionId: null,
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    }),
  );
  return created.id;
}

test('lists, diffs, promotes and rolls back versions from the console', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);

  const name = `W80-10 ${testInfo.project.name} ${String(Date.now())}-${String(
    Math.floor(Math.random() * 10000),
  )}`;
  const id = await createAgent(page, name);
  const edit = async (instructions) =>
    expectOk(await api(page, 'PATCH', `/api/agents/${id}`, { instructions }));
  await edit('Alpha');
  await edit('Beta');

  // List: v2 is the working draft, v1 is older, nothing is in production yet.
  await page.goto(`/agents/${id}?tab=versions`);
  await expect(page.getByRole('heading', { level: 1, name: 'Versions' })).toBeVisible();
  const row = (number) => page.locator(`tr[data-version="${String(number)}"]`);
  await expect(row(2)).toContainText('local');
  await expect(row(2)).not.toContainText('production');
  await expect(row(1)).toContainText('Console');

  // Score (#714): the deployment has no evaluation runner, so nothing is scored yet; the scored
  // rendering is `versions.test.ts`'s. The column, the dash and the line next to Promote show.
  await expect(page.getByRole('columnheader', { name: 'Score' })).toBeVisible();
  await expect(row(2).locator('[data-score]')).toHaveText('—');
  await expect(page.locator('[data-evaluation]')).toHaveText('v2 has not been evaluated.');
  const listed = await expectOk(await api(page, 'GET', `/api/agents/${id}/versions`));
  expect(listed.evaluations).toEqual([]);

  // Diff: two selected versions show the instructions as lines and the other fields as a table.
  await page.getByLabel('Compare version 1').check();
  await page.getByLabel('Compare version 2').check();
  await expect(page.getByRole('heading', { name: 'Version 1 to version 2' })).toBeVisible();
  await expect(page.getByText('− Alpha')).toBeVisible();
  await expect(page.getByText('+ Beta')).toBeVisible();

  // Promote: the confirmation repeats the plan `aw promote` prints, then moves production.
  const promote = page.getByRole('button', { name: 'Promote', exact: true });
  await promote.click();
  const promoting = page.getByRole('group', { name: 'Confirm promote' });
  await expect(promoting).toContainText('production: none -> 2');
  await promoting.getByRole('button', { name: 'Confirm promote' }).click();
  await expect(row(2)).toContainText('production');
  await expect(page.getByRole('status')).toContainText('production: none -> 2');

  // A third version, then promote it: the plan now names both ends.
  await edit('Gamma');
  await page.reload();
  await expect(row(3)).toContainText('local');
  await promote.click();
  await expect(page.getByRole('group', { name: 'Confirm promote' })).toContainText(
    'production: 2 -> 3',
  );
  await page
    .getByRole('group', { name: 'Confirm promote' })
    .getByRole('button', { name: 'Confirm promote' })
    .click();
  await expect(row(3)).toContainText('production');
  await expect(row(2)).not.toContainText('production');

  // Roll back: production returns to v2, and the screen says what it did.
  await page.getByRole('button', { name: 'Roll back', exact: true }).click();
  const rollingBack = page.getByRole('group', { name: 'Confirm roll back' });
  await expect(rollingBack).toContainText('production: 3 -> 2');
  await rollingBack.getByRole('button', { name: 'Confirm roll back' }).click();
  await expect(row(2)).toContainText('production');
  await expect(row(3)).not.toContainText('production');

  const { pointers } = await expectOk(await api(page, 'GET', `/api/agents/${id}/versions`));
  expect(
    Object.fromEntries(pointers.map((pointer) => [pointer.environment, pointer.number])),
  ).toEqual({
    local: 3,
    production: 2,
  });

  await expectBasicAccessibility(page);
});

test('keeps the configuration tab as it was', async ({ page }, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = `W80-10 tabs ${testInfo.project.name} ${String(Date.now())}`;
  const id = await createAgent(page, name);
  await page.goto(`/agents/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Configuration' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('link', { name: 'Versions' }).click();
  await expect(page).toHaveURL(/tab=versions/u);
  await expect(page.getByRole('heading', { level: 1, name: 'Versions' })).toBeVisible();
});
