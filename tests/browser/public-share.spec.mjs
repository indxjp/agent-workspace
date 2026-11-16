/* global fetch */

/**
 * A public agent share opened by a visitor who is not signed in — issue #2087.
 *
 * The console's Share dialog publishes an agent share with no snapshot, and the share page showed
 * the visitor a box with only `null` in it. The share is published with the exact command the
 * dialog sends (`sharePublishCommand`), then opened in a fresh browser context with no cookies.
 */
import { expect, test } from '@playwright/test';

import { sharePublishCommand } from '../../apps/web/components/shares/share-dialog-model.ts';
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
async function api(page, method, path, body) {
  const answer = await page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    },
    { method, path, body },
  );
  expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(300);
  return answer.body;
}

test('a signed-out visitor sees a public agent share in words, not null', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = `#2087 ${testInfo.project.name} ${String(Date.now())}`;
  const agent = await api(page, 'POST', '/api/agents', {
    name,
    instructions: 'Answer billing questions.',
    modelConnectionId: null,
    model: null,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  });
  const share = await api(
    page,
    'POST',
    '/api/shares',
    sharePublishCommand({ type: 'agent', id: agent.id, label: name }, 'public', '24 h', ''),
  );
  expect(share.url).toMatch(/^\/p\//u);

  const visitor = await browser.newContext({ baseURL });
  try {
    const visit = await visitor.newPage();
    await visit.goto(share.url);
    await expect(visit.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(visit.getByText('Only the name was shared with this link.')).toBeVisible();
    await expect(visit.getByText('null', { exact: true })).toHaveCount(0);
    await expect(visit.locator('main pre')).toHaveCount(0);
    await expectBasicAccessibility(visit);
  } finally {
    await visitor.close();
    // Leave nothing behind on a shared environment: the share first, then its agent.
    await api(page, 'DELETE', `/api/shares/${share.id}`);
    await api(page, 'DELETE', `/api/agents/${agent.id}`);
  }
});
