/**
 * The Files screen journey (storage design, §07 "Browser tests", journey 1): upload, list, rename,
 * download and delete one file through the real UI, and find it with the search box (UX-17).
 *
 * The screen is client-rendered, so the Web cell of each story below can only be covered by a real
 * browser. The steps are one serial test per Playwright project because each depends on the last;
 * names are unique per project and run because both projects share one server and one workspace.
 * A missing prerequisite fails the test rather than skipping it.
 */
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
      .getByLabel('Upload files to this folder')
      .setInputFiles({ name: 'q3.txt', mimeType: 'text/plain', buffer: bytes });
    await page.getByRole('button', { name: 'Upload here' }).click();
    await expect(fileRow()).toBeVisible();
  });

  await test.step('search finds q3.txt by its words and opens its folder (UX-17, #2090)', async () => {
    const box = page.getByRole('searchbox', { name: 'Search inside files' });
    const hit = page.getByRole('listitem').filter({ hasText: `${folder}/q3.txt` });
    await box.fill(folder);
    await box.press('Enter');
    // Text is read on demand, a bounded number of files per request, so a busy shared workspace
    // may answer in parts; "Search again" continues it.
    await expect(async () => {
      const again = page.getByRole('button', { name: 'Search again' });
      if (await again.isVisible()) await again.click();
      await expect(hit).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole('table')).toHaveCount(0);
    await hit.getByRole('button', { name: 'Open folder' }).click();
    await expect(fileRow()).toBeVisible();
    await expect(box).toHaveValue('');
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

  await test.step('uploads two picked files at once, one with a Japanese name (UX-16 in #2086)', async () => {
    await page.getByLabel('Upload files to this folder').setInputFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
      { name: '議事録.txt', mimeType: 'text/plain', buffer: Buffer.from('議事録') },
    ]);
    await page.getByRole('button', { name: 'Upload here' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Finished: 2 of 2 files uploaded.' }),
    ).toBeVisible();
    await expect(page.getByRole('row', { name: /notes\.txt/u })).toBeVisible();
    await expect(page.getByRole('row', { name: /議事録\.txt/u })).toBeVisible();
  });

  await test.step('uploads a picked folder with its subfolders (#2086 Upload)', async () => {
    // A real folder on disk: Playwright hands a directory to a `webkitdirectory` input the way a
    // browser's folder picker does, each file with its path inside the folder.
    const local = await mkdtemp(path.join(tmpdir(), 'aw-folder-upload-'));
    await mkdir(path.join(local, 'photos', '2026'), { recursive: true });
    await writeFile(path.join(local, 'photos', 'a.txt'), 'a');
    await writeFile(path.join(local, 'photos', '2026', '議事録.txt'), '議事録');
    await page
      .getByLabel('Upload a folder and everything in it')
      .setInputFiles(path.join(local, 'photos'));
    await page.getByRole('button', { name: 'Upload folder here' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Finished: 2 of 2 files uploaded.' }),
    ).toBeVisible();
    await folderButton('photos').click();
    await expect(page.getByRole('row', { name: /a\.txt/u })).toBeVisible();
    await folderButton('2026').click();
    await expect(page.getByRole('row', { name: /議事録\.txt/u })).toBeVisible();
  });

  await expectBasicAccessibility(page);
});
