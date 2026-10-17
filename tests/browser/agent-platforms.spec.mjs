/* global fetch, navigator */

/**
 * The agent screen's Platforms tab through the real UI — issue #973: the capability matrix, a
 * Check with its verdict table, the bundle download and the copyable publish command.
 *
 * A console edit is a version (issue #616), so one `PATCH` of an agent's instructions makes v1, and
 * the tab exports exactly that stored version. The agent's name is lower-case kebab and its model a
 * Claude id, which Claude Managed Agents requires of a portable agent.
 */
import { readFile } from 'node:fs/promises';

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

test('checks a platform, downloads its bundle and copies the publish command', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signInAsBootstrapAdmin(page, credentials);

  const name = `w973-${testInfo.project.name}-${String(Date.now())}-${String(
    Math.floor(Math.random() * 10000),
  )}`;
  const created = await expectOk(
    await api(page, 'POST', '/api/agents', {
      name,
      instructions: 'Seed',
      modelConnectionId: null,
      model: 'claude-sonnet-4-5',
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    }),
  );
  await expectOk(await api(page, 'PATCH', `/api/agents/${created.id}`, { instructions: 'Alpha' }));

  await page.goto(`/agents/${created.id}?tab=platforms`);
  await expect(page.getByRole('heading', { level: 1, name: 'Platforms' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Platforms' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const listed = await expectOk(await api(page, 'GET', '/api/platforms'));
  for (const platform of listed.platforms) {
    await expect(page.locator(`tr[data-platform="${platform.id}"]`)).toContainText(
      platform.displayName,
    );
  }

  await page.getByRole('button', { name: 'Check Claude Managed Agents' }).click();
  const verdicts = page.getByRole('table', { name: 'What happens to each field on this platform' });
  await expect(verdicts).toBeVisible();
  await expect(verdicts.getByRole('columnheader', { name: 'Verdict' })).toBeVisible();
  await expect(page.getByText(/\d+ native · \d+ mapped · \d+ dropped/u)).toBeVisible();

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download bundle' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`${name}-claude-managed-agents-v1.tar`);
  const saved = await download.path();
  expect((await readFile(saved)).byteLength).toBeGreaterThan(0);

  const command = `aw platforms publish --platform claude-managed-agents --agent ${name}`;
  await page.getByRole('button', { name: 'Copy Publish command' }).click();
  await expect(page.getByText('Copied.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);

  await expectBasicAccessibility(page);
});
