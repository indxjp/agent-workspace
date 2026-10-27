/**
 * The Files screen journey (storage design, §07 "Browser tests", journey 1): upload, list, rename,
 * download and delete one file through the real UI.
 *
 * The screen is client-rendered, so the Web cell of each story below can only be covered by a real
 * browser. The steps are one serial test per Playwright project because each depends on the last;
 * names are unique per project and run because both projects share one server and one workspace.
 * A missing prerequisite fails the test rather than skipping it.
 */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  bootstrapAdminCredentials,
  expectBasicAccessibility,
  signInAsBootstrapAdmin,
} from './harness.mjs';

function uniqueSuffix(testInfo) {
  return `${testInfo.project.name}-${String(Date.now())}-${String(Math.floor(Math.random() * 10000))}`;
}

test('uploads, lists, renames, downloads and deletes a file on /files', async ({
  page,
}, testInfo) => {
  const credentials = bootstrapAdminCredentials();
  expect(
    credentials,
    'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD must be configured so the journey can sign in.',
  ).not.toBeNull();

  const folder = `journey-${uniqueSuffix(testInfo)}`;
  const moved = `moved-${uniqueSuffix(testInfo)}`;
  const bytes = Buffer.from(`q3 ${folder}\n`);

  const folderButton = (name) => page.getByRole('button', { name: `${name}/`, exact: true });
  const fileRow = () => page.getByRole('row', { name: /q3\.txt/u });

  await signInAsBootstrapAdmin(page, credentials);
  await page.goto('/files');
  await page.getByRole('textbox', { name: 'New folder name' }).fill(folder);
  await page.getByRole('button', { name: 'Create folder here' }).click();
  await folderButton(folder).click();

  await test.step('[US-STO-01][browser][web] journey: upload q3.txt into a new folder and list it', async () => {
    // @story US-STO-01
    await page
      .getByLabel('Upload a file to this folder')
      .setInputFiles({ name: 'q3.txt', mimeType: 'text/plain', buffer: bytes });
    await page.getByRole('button', { name: 'Upload here' }).click();
    await expect(fileRow()).toBeVisible();
  });

  await test.step('[US-STO-03][browser][web] journey: rename the folder', async () => {
    // @story US-STO-03
    await page
      .getByRole('navigation', { name: 'Folder breadcrumb' })
      .getByRole('button', { name: 'Home', exact: true })
      .click();
    await expect(folderButton(folder)).toBeVisible();
    const folderRow = page.getByRole('row').filter({ has: folderButton(folder) });
    await folderRow.getByRole('button', { name: 'Rename' }).click();
    const newPath = page.getByRole('textbox', { name: `New path for ${folder}` });
    await newPath.fill(moved);
    await page
      .getByRole('row')
      .filter({ has: newPath })
      .getByRole('button', { name: 'Save' })
      .click();
    await expect(folderButton(moved)).toBeVisible();
    await expect(folderButton(folder)).toHaveCount(0);
    await folderButton(moved).click();
    await expect(fileRow()).toBeVisible();
  });

  await test.step('[US-STO-05][browser][web] journey: download q3.txt', async () => {
    // @story US-STO-05
    const link = fileRow().getByRole('link', { name: 'Download' });
    const href = await link.getAttribute('href');
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe('q3.txt');
    expect(await readFile(await download.path())).toEqual(bytes);

    // A download navigation's response is not reliably observable, so the headers are read from the
    // same link with the page's own session.
    const response = await page.request.get(href);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-disposition']).toMatch(/^attachment/u);
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(await response.body()).toEqual(bytes);
  });

  await test.step('[US-STO-04][browser][web] journey: delete q3.txt', async () => {
    // @story US-STO-04
    page.once('dialog', (dialog) => void dialog.accept());
    await fileRow().getByRole('button', { name: 'Delete' }).click();
    await expect(fileRow()).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('This folder is empty.')).toBeVisible();
    await expect(fileRow()).toHaveCount(0);
  });

  await expectBasicAccessibility(page);
});
