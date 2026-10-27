/* global Buffer, document, fetch, localStorage, process, TextEncoder */

/**
 * Storage connections in the console (the storage design, §07 "Browser tests", US-STO-12): an
 * Owner connects a local folder, grants one of its folders to an agent without the CLI, and the
 * credential of a connection never comes back into the page. The same Owner edits, rotates and
 * deletes a connection, removes a grant again, and does all of it from the keyboard. Builders and
 * Viewers are refused every storage page.
 *
 * A missing prerequisite fails the test rather than skipping it. Names are unique per project and
 * run because both Playwright projects share one server and one workspace.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { openConnectionStore } from '@agent-workspace/core/storage';
import { expect, test } from '@playwright/test';

import {
  bootstrapAdminCredentials,
  expectBasicAccessibility,
  signInAsBootstrapAdmin,
} from './harness.mjs';
import { storageConnectionFileRoot } from './storage-file-root.mjs';

function uniqueSuffix(testInfo) {
  return `${testInfo.project.name}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

async function signIn(page) {
  const credentials = bootstrapAdminCredentials();
  expect(
    credentials,
    'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD must be configured so the journey can sign in.',
  ).not.toBeNull();
  await signInAsBootstrapAdmin(page, credentials);
}

/**
 * Write `files` into the `file://` connection at `folder` through the store the product opens, so
 * the seed lands wherever that store reads, whatever its on-disk layout.
 */
async function seedConnection(folder, files) {
  await mkdir(folder, { recursive: true });
  const store = await openConnectionStore(
    `file://${folder}`,
    { provider: 'file' },
    {
      writable: true,
      fileRoots: [storageConnectionFileRoot()],
      // A `file` connection dials nothing, so the egress policy is never consulted.
      egress: { production: false, allowHosts: [] },
    },
  );
  for (const [key, text] of Object.entries(files)) {
    await store.put(key, { body: new TextEncoder().encode(text) });
  }
}

/** A same-origin JSON call from the page, so it carries the session cookie and the `Origin`. */
function api(page, method, apiPath, body) {
  return page.evaluate(
    async ({ method, apiPath, body }) => {
      const response = await fetch(apiPath, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text === '' ? null : JSON.parse(text) };
    },
    { method, apiPath, body },
  );
}

async function createAgent(page, suffix) {
  await page.goto('/agents');
  const created = await api(page, 'POST', '/api/agents', {
    name: `Storage ${suffix}`,
    instructions: 'Seed',
    modelConnectionId: null,
    model: null,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  return created.body.id;
}

/** A connection created through the API, so a test about editing does not repeat the create form. */
async function createConnection(page, input) {
  const created = await api(page, 'POST', '/api/storage-connections', {
    allowedPrefixes: ['reports'],
    writeAllowed: false,
    ...input,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body;
}

async function createFileConnection(page, name, folder) {
  await seedConnection(folder, { 'reports/a.txt': 'a\n' });
  return createConnection(page, { name, url: `file://${folder}` });
}

async function grantReports(page, agentId, connection) {
  await page.goto(`/agents/${agentId}`);
  await page.getByRole('button', { name: 'Add files or folders' }).click();
  await page.getByRole('button', { name: 'Connected storage' }).click();
  await page.getByLabel('Storage connection').selectOption({ label: connection });
  await page.getByRole('button', { name: 'Open reports/', exact: true }).click();
  await page.getByRole('button', { name: 'Grant this folder' }).click();
  await expect(page.getByRole('list', { name: 'Connected storage grants' })).toContainText(
    `${connection}/reports/`,
  );
}

/** The files of the version `local` points at: what the agent runs with now. */
async function currentVersionFiles(page, agentId) {
  const versions = await api(page, 'GET', `/api/agents/${agentId}/versions`);
  const local = versions.body.pointers.find((pointer) => pointer.environment === 'local');
  const current = versions.body.items.find((version) => version.number === local.number);
  return current.body.definition.resources.files.map((file) => file.path);
}

test('[US-STO-12][browser][web] connect a bucket and grant one folder', async ({
  page,
}, testInfo) => {
  // @story US-STO-12
  const suffix = uniqueSuffix(testInfo);
  const connection = `sto-${suffix}`;
  const folder = path.join(storageConnectionFileRoot(), suffix);
  await seedConnection(folder, {
    'reports/2026/a.txt': 'a\n',
    'reports/Q3 drafts/b.txt': 'b\n',
  });

  await signIn(page);
  const agentId = await createAgent(page, suffix);

  await test.step('connect a local folder', async () => {
    await page.goto('/admin/storage/new');
    await expectBasicAccessibility(page);
    await page.getByLabel('Name', { exact: true }).fill(connection);
    await page.getByLabel('Provider').selectOption('file');
    await page.getByLabel('URL').fill(`file://${folder}`);
    await page.getByLabel('Allowed folders').fill('reports');
    await expect(page.getByLabel('Allow writing')).not.toBeChecked();
    await page.getByRole('button', { name: 'Save connection' }).click();
    await expect(page).toHaveURL(/\/admin\/storage$/u);
    await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
    await expectBasicAccessibility(page);
  });

  await test.step('test the connection', async () => {
    await page.getByRole('button', { name: `Test ${connection}`, exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Connection OK');
  });

  await test.step('grant reports/ to the agent', async () => {
    await page.goto(`/agents/${agentId}`);
    await expectBasicAccessibility(page);
    await page.getByRole('button', { name: 'Add files or folders' }).click();
    await page.getByRole('button', { name: 'Connected storage' }).click();
    await page.getByLabel('Storage connection').selectOption({ label: connection });
    await page.getByRole('button', { name: 'Open reports/', exact: true }).click();
    await expect(page.getByText('Current folder: reports/')).toBeVisible();

    // The seeded files are where the connection reads.
    await page.getByRole('button', { name: 'Open 2026/', exact: true }).click();
    await expect(page.getByText('Current folder: reports/2026/')).toBeVisible();
    await expect(page.getByText('a.txt')).toBeVisible();
    await page.getByRole('button', { name: 'Up one folder' }).click();
    await expect(page.getByText('Current folder: reports/', { exact: true })).toBeVisible();

    // A folder whose name has a space opens, and "Up one folder" goes back.
    await page.getByRole('button', { name: 'Open Q3 drafts/', exact: true }).click();
    await expect(page.getByText('Current folder: reports/Q3 drafts/')).toBeVisible();
    await expect(page.getByText('b.txt')).toBeVisible();
    await page.getByRole('button', { name: 'Up one folder' }).click();
    await expect(page.getByText('Current folder: reports/', { exact: true })).toBeVisible();

    const readWrite = page.getByRole('option', { name: /^Read\/write/u });
    await expect(readWrite).toBeDisabled();
    await expect(page.getByText(/needs a connection that allows writing/u)).toBeVisible();

    await page.getByRole('button', { name: 'Grant this folder' }).click();
    const grants = page.getByRole('list', { name: 'Connected storage grants' });
    await expect(grants).toContainText(`${connection}/reports/`);
    await page.reload();
    await expect(page.getByRole('list', { name: 'Connected storage grants' })).toContainText(
      `${connection}/reports/`,
    );
  });
});

test('[US-STO-12][browser][web] credentials are never rendered back', async ({
  page,
}, testInfo) => {
  // @story US-STO-12
  const suffix = uniqueSuffix(testInfo);
  const secret = randomBytes(24).toString('base64url');
  const rotatedSecret = randomBytes(24).toString('base64url');
  const slices = [secret, rotatedSecret].flatMap((value) =>
    Array.from({ length: value.length - 5 }, (_, index) => value.slice(index, index + 6)),
  );
  const consoleText = [];
  page.on('console', (message) => consoleText.push(message.text()));

  await signIn(page);

  async function expectNoSecret() {
    for (const input of await page.locator('input[type="password"]').all()) {
      await expect(input).toHaveValue('');
    }
    const surfaces = [
      await page.content(),
      page.url(),
      await page.evaluate(() => JSON.stringify({ ...localStorage })),
      consoleText.join('\n'),
    ].join('\n');
    expect(slices.filter((slice) => surfaces.includes(slice))).toEqual([]);
  }

  async function fillS3(name, url) {
    await page.goto('/admin/storage/new');
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Provider').selectOption('s3');
    await page.getByLabel('URL').fill(url);
    await page.getByLabel('Allowed folders').fill('reports');
    await page.getByLabel('Access key ID').fill(`id-${suffix}`);
    await page.getByLabel('Secret access key').fill(secret);
    await page.getByRole('button', { name: 'Save connection' }).click();
  }

  await test.step('after a failed save', async () => {
    await fillS3(`sto-bad-${suffix}`, 'not-a-storage-url');
    await expect(
      page.getByRole('alert').filter({ hasText: 'not a valid storage URL' }),
    ).toBeVisible();
    await expectNoSecret();
  });

  await test.step('after a successful save', async () => {
    await fillS3(`sto-ok-${suffix}`, 's3://reports-bucket?endpoint=https://s3.example.com');
    await expect(page).toHaveURL(/\/admin\/storage$/u);
    await expect(page.getByText(`sto-ok-${suffix}`)).toBeVisible();
    await expectNoSecret();
  });

  async function rotateOnEditPage() {
    await page.getByLabel('Access key ID').fill(`id-${suffix}`);
    await page.getByLabel('Secret access key').fill(rotatedSecret);
    await page.getByRole('button', { name: 'Rotate credential' }).click();
  }

  await test.step('after a rotate and after reloading the edit page', async () => {
    await page.getByRole('link', { name: `Edit sto-ok-${suffix}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit storage connection' })).toBeVisible();
    await expectBasicAccessibility(page);
    await rotateOnEditPage();
    await expect(page.getByRole('status')).toContainText('Credential rotated');
    await expectNoSecret();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Edit storage connection' })).toBeVisible();
    await expect(page.getByLabel('URL')).toHaveValue(/reports-bucket/u);
    await expectNoSecret();
  });

  await test.step('after a failed rotate', async () => {
    const id = page.url().split('/').pop();
    expect((await api(page, 'DELETE', `/api/storage-connections/${id}`)).status).toBe(204);
    await rotateOnEditPage();
    await expect(page.getByRole('alert').filter({ hasText: 'no longer exists' })).toBeVisible();
    await expectNoSecret();
  });
});

test('[US-STO-12][browser][web] edit a connection: folders, write, and a moved endpoint needs a credential', async ({
  page,
}, testInfo) => {
  // @story US-STO-12
  const suffix = uniqueSuffix(testInfo);
  const endpoint = 'endpoint=https://s3.example.com';
  await signIn(page);
  await page.goto('/admin/storage');
  const connection = await createConnection(page, {
    name: `sto-edit-${suffix}`,
    url: `s3://edit-bucket?${endpoint}`,
    credential: {
      provider: 's3',
      accessKeyId: `id-${suffix}`,
      secretAccessKey: randomBytes(24).toString('base64url'),
    },
  });
  await page.goto(`/admin/storage/${connection.id}`);
  await expectBasicAccessibility(page);
  await expect(page.getByLabel('URL')).toHaveValue(`s3://edit-bucket?${endpoint}`);
  await expect(page.getByLabel('Allowed folders')).toHaveValue('reports');
  await expect(page.getByLabel('Allow writing')).not.toBeChecked();
  await expect(
    page.getByText('Off by default. Grants stay read-only until write-back ships.'),
  ).toBeVisible();

  await test.step('change the folders and the write switch', async () => {
    await page.getByLabel('Allowed folders').fill('reports\nsigned');
    await page.getByLabel('Allow writing').check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Changes saved.');
    await page.reload();
    await expect(page.getByLabel('Allowed folders')).toHaveValue('reports\nsigned');
    await expect(page.getByLabel('Allow writing')).toBeChecked();
  });

  await test.step('a moved bucket needs a new credential and keeps what was typed', async () => {
    const moved = `s3://moved-bucket?${endpoint}`;
    await page.getByLabel('URL').fill(moved);
    await page.getByLabel('Allowed folders').fill('reports');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'needs a new credential' }),
    ).toBeVisible();
    await expect(page.getByLabel('URL')).toHaveValue(moved);
    await expect(page.getByLabel('Allowed folders')).toHaveValue('reports');

    await page.getByLabel('Access key ID').fill(`id-${suffix}`);
    await page.getByLabel('Secret access key').fill(randomBytes(24).toString('base64url'));
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Changes saved.');
    await expect(page.getByLabel('Access key ID')).toHaveValue('');
    await page.reload();
    await expect(page.getByLabel('URL')).toHaveValue(moved);
  });
});

test('[US-STO-12][browser][web] remove a grant: gone after a reload and from the current version', async ({
  page,
}, testInfo) => {
  // @story US-STO-12
  const suffix = uniqueSuffix(testInfo);
  const name = `sto-rm-${suffix}`;
  await signIn(page);
  const agentId = await createAgent(page, suffix);
  await createFileConnection(page, name, path.join(storageConnectionFileRoot(), suffix));

  await grantReports(page, agentId, name);
  expect(await currentVersionFiles(page, agentId)).toContain(`storage://${name}/reports`);

  await page.getByRole('button', { name: 'Close browser' }).click();
  await page.getByRole('button', { name: `Remove ${name}/reports/`, exact: true }).click();
  await expect(page.getByRole('list', { name: 'Connected storage grants' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add files or folders' })).toBeFocused();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Add files or folders' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Connected storage grants' })).toHaveCount(0);
  expect(await currentVersionFiles(page, agentId)).not.toContain(`storage://${name}/reports`);
});

test('[US-STO-12][browser][web] delete: asks first, refuses a granted connection, then deletes it', async ({
  page,
}, testInfo) => {
  // @story US-STO-12
  const suffix = uniqueSuffix(testInfo);
  const name = `sto-del-${suffix}`;
  await signIn(page);
  const agentId = await createAgent(page, suffix);
  const connection = await createFileConnection(
    page,
    name,
    path.join(storageConnectionFileRoot(), suffix),
  );
  await grantReports(page, agentId, name);

  await page.goto(`/admin/storage/${connection.id}`);
  await page.getByRole('button', { name: 'Delete this connection' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete ${name}?` });
  await expect(dialog).toBeVisible();

  await test.step('cancelling keeps the connection and returns focus to the button', async () => {
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Delete this connection' })).toBeFocused();
    expect((await api(page, 'GET', `/api/storage-connections/${connection.id}`)).status).toBe(200);
  });

  await test.step('a granted connection is refused with a message', async () => {
    await page.getByRole('button', { name: 'Delete this connection' }).click();
    await dialog.getByRole('button', { name: 'Delete connection' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Agents still grant this connection' }),
    ).toBeVisible();
    expect((await api(page, 'GET', `/api/storage-connections/${connection.id}`)).status).toBe(200);
  });

  await test.step('once the grant is removed the connection can be deleted', async () => {
    await page.goto(`/agents/${agentId}`);
    await page.getByRole('button', { name: `Remove ${name}/reports/`, exact: true }).click();
    await expect(page.getByRole('list', { name: 'Connected storage grants' })).toHaveCount(0);

    await page.goto(`/admin/storage/${connection.id}`);
    await page.getByRole('button', { name: 'Delete this connection' }).click();
    await dialog.getByRole('button', { name: 'Delete connection' }).click();
    await expect(page).toHaveURL(/\/admin\/storage$/u);
    await expect(page.getByRole('link', { name: `Edit ${name}`, exact: true })).toHaveCount(0);
    expect((await api(page, 'GET', `/api/storage-connections/${connection.id}`)).status).toBe(404);
  });
});

/**
 * The session cookie of `email` in the Owner's workspace. This build signs in only the bootstrap
 * Owner (see `harness.mjs`), but the role of a session is read from the directory on every request,
 * so a member provisioned through `POST /api/users` is signed in by minting the cookie the server
 * would have issued, with the deployment's own `SESSION_SECRET`.
 */
async function sessionCookieFor(ownerPage, email) {
  const secret = process.env['SESSION_SECRET'];
  expect(secret, 'SESSION_SECRET must be set so a member session can be minted.').toBeTruthy();
  const owner = (await ownerPage.context().cookies()).find((cookie) =>
    cookie.name.startsWith('__Host-aw_session'),
  );
  const claims = JSON.parse(Buffer.from(owner.value.split('.')[1], 'base64url').toString());
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: email,
      ws: claims.ws,
      role: 'owner',
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  ).toString('base64url');
  const signed = `aw1.${payload}`;
  const signature = createHmac('sha256', secret).update(signed).digest('base64url');
  return { ...owner, value: `${signed}.${signature}` };
}

const NOT_ALLOWED = 'Only workspace Owners and Admins can manage storage connections.';

test('[US-STO-12][browser][web] only Owners and Admins manage storage', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  // @story US-STO-12
  const suffix = uniqueSuffix(testInfo);
  await signIn(page);
  await page.goto('/admin/storage');
  const connection = await createFileConnection(
    page,
    `sto-role-${suffix}`,
    path.join(storageConnectionFileRoot(), suffix),
  );
  const pages = ['/admin/storage', '/admin/storage/new', `/admin/storage/${connection.id}`];
  const navLink = (target) => target.getByRole('link', { name: 'Storage', exact: true });

  async function asRole(role, check) {
    const email = `sto-${role}-${suffix}@example.test`;
    const created = await api(page, 'POST', '/api/users', { email, name: `Sto ${role}`, role });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const context = await browser.newContext({ baseURL });
    try {
      await context.addCookies([await sessionCookieFor(page, email)]);
      await check(await context.newPage());
    } finally {
      await context.close();
    }
  }

  for (const role of ['builder', 'viewer']) {
    await test.step(`${role}: every storage page is the not-allowed state`, async () => {
      await asRole(role, async (member) => {
        for (const target of pages) {
          await member.goto(target);
          await expect(member.getByText(NOT_ALLOWED)).toBeVisible();
          await expect(
            member.getByRole('button', {
              name: /^(Save connection|Save changes|Rotate credential|Delete this connection)$/u,
            }),
          ).toHaveCount(0);
          await expect(member.getByRole('link', { name: /Connect storage|^Edit /u })).toHaveCount(
            0,
          );
        }
        await member.goto('/agents');
        await expect(navLink(member)).toHaveCount(0);
      });
    });
  }

  await test.step('admin: sees the pages and the navigation entry', async () => {
    await asRole('admin', async (member) => {
      await member.goto('/agents');
      await expect(navLink(member)).toBeVisible();
      await member.goto('/admin/storage');
      await expect(member.getByRole('heading', { name: 'Storage' })).toBeVisible();
      await member.goto('/admin/storage/new');
      await expect(member.getByRole('heading', { name: 'Connect storage' })).toBeVisible();
      await member.goto(`/admin/storage/${connection.id}`);
      await expect(member.getByRole('heading', { name: 'Edit storage connection' })).toBeVisible();
    });
  });

  await test.step('owner: sees the pages and the navigation entry', async () => {
    await page.goto('/agents');
    await expect(navLink(page)).toBeVisible();
    await navLink(page).click();
    await expect(page).toHaveURL(/\/admin\/storage$/u);
    await expect(page.getByText(NOT_ALLOWED)).toHaveCount(0);
  });
});

/** Tab until `locator` has focus, so a keyboard-only test never moves focus any other way. */
async function tabTo(page, locator) {
  for (let presses = 0; presses < 150; presses += 1) {
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab never reached the control.');
}

test('[US-STO-12][browser][web] keyboard only: connect, grant, edit, delete', async ({
  page,
}, testInfo) => {
  // @story US-STO-12
  const suffix = uniqueSuffix(testInfo);
  const bucket = `kb-${suffix}`;
  const folderConnection = `kbf-${suffix}`;
  const secret = randomBytes(24).toString('base64url');
  const rotated = randomBytes(24).toString('base64url');
  await signIn(page);
  const agentId = await createAgent(page, suffix);
  const granted = await createFileConnection(
    page,
    folderConnection,
    path.join(storageConnectionFileRoot(), suffix),
  );

  async function press(name, role = 'button') {
    const control = page.getByRole(role, { name, exact: true });
    await tabTo(page, control);
    await page.keyboard.press('Enter');
  }
  async function type(label, text) {
    await tabTo(page, page.getByLabel(label, { exact: true }));
    await page.keyboard.insertText(text);
  }

  await test.step('connect a bucket', async () => {
    await page.goto('/admin/storage');
    await expectBasicAccessibility(page);
    await press('+ Connect storage', 'link');
    await expect(page).toHaveURL(/\/admin\/storage\/new$/u);
    await expectBasicAccessibility(page);
    await type('Name', bucket);
    await expect(page.getByLabel('Provider')).toHaveValue('s3');
    await type('URL', 's3://kb-bucket?endpoint=https://s3.example.com');
    await type('Allowed folders', 'reports');
    await type('Access key ID', `id-${suffix}`);
    await type('Secret access key', secret);
    await press('Save connection');
    await expect(page).toHaveURL(/\/admin\/storage$/u);
    await expect(page.getByText(bucket, { exact: true })).toBeVisible();
  });

  await test.step('grant a folder in the picker', async () => {
    await page.goto(`/agents/${agentId}`);
    await expectBasicAccessibility(page);
    await press('Add files or folders');
    await press('Connected storage');
    await tabTo(page, page.getByLabel('Storage connection'));
    await page.keyboard.type(folderConnection);
    await expect(page.getByLabel('Storage connection')).toHaveValue(granted.id);
    await press('Open reports/');
    await expect(page.getByText('Current folder: reports/', { exact: true })).toBeVisible();
    await press('Grant this folder');
    const grants = page.getByRole('list', { name: 'Connected storage grants' });
    await expect(grants).toContainText(`${folderConnection}/reports/`);
    await expect(grants.getByRole('listitem')).toBeFocused();
  });

  await test.step('open the edit page and rotate the credential', async () => {
    await page.goto('/admin/storage');
    await press(`Edit ${bucket}`, 'link');
    await expect(page.getByRole('heading', { name: 'Edit storage connection' })).toBeVisible();
    await expectBasicAccessibility(page);
    await type('Access key ID', `id-${suffix}`);
    await type('Secret access key', rotated);
    await press('Rotate credential');
    await expect(page.getByRole('status')).toContainText('Credential rotated');
    await expect(page.getByLabel('Secret access key')).toHaveValue('');
  });

  await test.step('the dialog keeps focus and gives it back', async () => {
    const trigger = page.getByRole('button', { name: 'Delete this connection' });
    await press('Delete this connection');
    const dialog = page.getByRole('dialog', { name: `Delete ${bucket}?` });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Delete connection' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Delete connection' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/storage$/u);
    await expect(page.getByRole('link', { name: `Edit ${bucket}`, exact: true })).toHaveCount(0);
  });

  await test.step('a granted connection stays, and the message takes focus', async () => {
    await page.goto(`/admin/storage/${granted.id}`);
    await expectBasicAccessibility(page);
    await press('Delete this connection');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Agents still grant this connection' }),
    ).toBeFocused();
  });
});
