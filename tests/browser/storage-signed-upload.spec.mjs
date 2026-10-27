/* global fetch, URL */

/**
 * US-STO-02 on the Web entry point (the storage design, §07): a file above the relay limit goes
 * from the browser straight to the object store through a signed link, then appears in the list
 * and downloads intact.
 *
 * The shared browser harness serves files from a local folder, which cannot sign, so this spec
 * brings its own S3-compatible store (the pinned native SeaweedFS the test services use) and its
 * own `next start` pointed at it. The store gets bucket CORS for this server's origin only. The
 * uploader is the SDK's `client.files.upload`; nothing here adds a second `PUT` path.
 *
 * Needs a built web app, `DATABASE_URL` and `BOOTSTRAP_ADMIN*`, exactly as the other browser specs
 * do. A missing prerequisite fails the test; it never skips.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import process from 'node:process';

import { CreateBucketCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { expect, test as base } from '@playwright/test';

import { createCleanup } from '../../scripts/test-services/cleanup.mjs';
import { freePort, stopProcessGroup, waitUntil } from '../../scripts/test-services/process.mjs';
import { sha256File, startNativeSeaweedfs } from '../../scripts/test-services/seaweedfs.mjs';
import {
  bootstrapAdminCredentials,
  expectBasicAccessibility,
  signInAsBootstrapAdmin,
} from './harness.mjs';

const MIB = 1024 * 1024;
const FILE_MIB = 70;
// The identity `startNativeSeaweedfs` creates for its store.
const STORE_IDENTITY = 'agent_workspace';

/** Write `mib` MiB of random bytes to `file` as a stream and answer its SHA-256. */
async function writeRandomFile(file, mib) {
  const hash = createHash('sha256');
  const out = createWriteStream(file);
  for (let written = 0; written < mib; written += 1) {
    const chunk = randomBytes(MIB);
    hash.update(chunk);
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  return hash.digest('hex');
}

/** The store, its bucket with CORS for `origin` only, and a `next start` that signs against it. */
async function startSignedUploadStack(browserName) {
  const cleanup = createCleanup();
  try {
    const { endpoint } = await startNativeSeaweedfs(cleanup, process.env);
    const port = await freePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const bucket = `signed-upload-${browserName}`;

    const s3 = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: STORE_IDENTITY, secretAccessKey: STORE_IDENTITY },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [origin],
              AllowedMethods: ['PUT'],
              // The two headers the signed `PUT` carries (s3-store.ts `createSignedUrl`).
              AllowedHeaders: ['content-type', 'x-amz-meta-aw-content-type-known'],
              MaxAgeSeconds: 600,
            },
          ],
        },
      }),
    );
    s3.destroy();

    const web = spawn(
      'pnpm',
      ['--filter', '@agent-workspace/web', 'exec', 'next', 'start', '-p', String(port)],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          RUNNER_URL: process.env['RUNNER_URL'] ?? 'http://127.0.0.1:9',
          AW_STORAGE_URL: `s3://${bucket}?endpoint=${encodeURIComponent(endpoint)}&pathStyle=true`,
          AWS_REGION: 'us-east-1',
          AWS_ACCESS_KEY_ID: STORE_IDENTITY,
          AWS_SECRET_ACCESS_KEY: STORE_IDENTITY,
        },
      },
    );
    cleanup.add(`stop the web server on port ${String(port)}`, () => stopProcessGroup(web));
    await waitUntil(
      'The web server',
      async () => {
        try {
          return (await fetch(`${origin}/signin`)).ok;
        } catch {
          return false;
        }
      },
      120_000,
    );
    return { origin, storeOrigin: new URL(endpoint).origin, stop: () => cleanup.run() };
  } catch (error) {
    await cleanup.run();
    throw error;
  }
}

const test = base.extend({
  stack: [
    async ({ browserName }, use) => {
      const stack = await startSignedUploadStack(browserName);
      await use(stack);
      const failures = await stack.stop();
      expect(failures.map(({ label }) => label)).toEqual([]);
    },
    { scope: 'worker', timeout: 240_000 },
  ],
  baseURL: async ({ stack }, use) => {
    await use(stack.origin);
  },
});

test('[US-STO-02][browser][web] a 70 MiB upload appears in the list', async ({
  page,
  stack,
}, testInfo) => {
  // @story US-STO-02
  test.setTimeout(240_000);
  const credentials = bootstrapAdminCredentials();
  expect(
    credentials,
    'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD must be configured so the spec can sign in.',
  ).not.toBeNull();

  const folder = `signed-${testInfo.project.name}-${String(Date.now())}`;
  const bigFile = testInfo.outputPath('big.bin');
  const digest = await writeRandomFile(bigFile, FILE_MIB);

  await signInAsBootstrapAdmin(page, credentials);
  await page.goto('/files');
  await page.getByRole('textbox', { name: 'New folder name' }).fill(folder);
  await page.getByRole('button', { name: 'Create folder here' }).click();
  await page.getByRole('button', { name: `${folder}/`, exact: true }).click();

  const signedPut = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().startsWith(`${stack.storeOrigin}/`),
    { timeout: 200_000 },
  );
  // Hold the store PUT so the in-flight status cannot finish before it is observed.
  let releasePut = () => {};
  const putHeld = new Promise((resolve) => {
    releasePut = resolve;
  });
  await page.route(`${stack.storeOrigin}/**`, async (route) => {
    if (route.request().method() === 'PUT') await putHeld;
    await route.continue();
  });
  await page.getByLabel('Upload a file to this folder').setInputFiles(bigFile);
  await page.getByRole('button', { name: 'Upload here' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Uploading big.bin' })).toBeVisible();
  releasePut();

  // The signed link carries its own authority: no session cookie and no bearer token.
  // allHeaders(), unlike headers(), includes the cookie header.
  const headers = await (await signedPut).allHeaders();
  expect(headers['authorization']).toBeUndefined();
  expect(headers['cookie']).toBeUndefined();

  const row = page.getByRole('row', { name: /big\.bin/u });
  await expect(row).toBeVisible({ timeout: 200_000 });
  await expect(row).toContainText(`${String(FILE_MIB)} MB`);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('link', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('big.bin');
  expect(await sha256File(await download.path())).toBe(digest);

  await expectBasicAccessibility(page);
});
