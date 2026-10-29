/**
 * Browsing a `file` storage connection through `next start`, not through the bare route handler.
 *
 * Next rebuilds a route's query string before the handler sees it (a space the client sent as
 * `%20` arrives as `+`), so a folder whose name holds a space listed as empty here while every
 * handler-level test passed. This spec sends the prefix the way the SDK does
 * (`encodeURIComponent`) and checks the real server's answer. One test per Playwright project; the
 * connection name is unique per project and run because both projects share one server.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { TextEncoder } from 'node:util';

import { openConnectionStore } from '@agent-workspace/core/storage';
import { expect, test } from '@playwright/test';

import { bootstrapAdminCredentials, signInAsBootstrapAdmin } from './harness.mjs';
import { storageConnectionFileRoot } from './storage-file-root.mjs';

/**
 * Write `keys` into the `file://` connection at `folder` through the store the product opens, so
 * the seed lands wherever that store reads, whatever its on-disk layout.
 */
async function writeObjects(folder, keys) {
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
  for (const key of keys) await store.write(key, new TextEncoder().encode(key), {});
}

test('[US-STO-12][api][sdk] a folder named with a space, an accent, a plus or an ampersand lists through next start', async ({
  page,
  baseURL,
}, testInfo) => {
  // @story US-STO-12
  const credentials = bootstrapAdminCredentials();
  expect(
    credentials,
    'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD must be configured so the spec can sign in.',
  ).not.toBeNull();
  const name = `browse-${testInfo.project.name}-${String(Date.now())}`;
  const folder = path.join(storageConnectionFileRoot(), name);
  const listed = {
    'reports/Q3 drafts': 'reports/Q3 drafts/z.txt',
    'reports/Q3+drafts': 'reports/Q3+drafts/plus.txt',
    'reports/café': 'reports/café/e.txt',
    'reports/a&b': 'reports/a&b/amp.txt',
  };
  await writeObjects(folder, [...Object.values(listed), 'secret/d.txt']);

  await signInAsBootstrapAdmin(page, credentials);
  const created = await page.request.post('/api/storage-connections', {
    headers: { origin: baseURL ?? '' },
    data: { name, url: `file://${folder}`, allowedPrefixes: ['reports'] },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json();
  const browse = (query) => page.request.get(`/api/storage-connections/${id}/browse?${query}`);

  for (const [prefix, file] of Object.entries(listed)) {
    const response = await browse(`prefix=${encodeURIComponent(prefix)}`);
    expect(response.status(), prefix).toBe(200);
    expect((await response.json()).entries, prefix).toEqual([
      expect.objectContaining({ path: file, kind: 'file' }),
    ]);
  }
  // A form-encoded `+` is a space too.
  const plus = await browse('prefix=reports%2FQ3+drafts');
  expect((await plus.json()).entries).toEqual([
    expect.objectContaining({ path: 'reports/Q3 drafts/z.txt' }),
  ]);

  for (const prefix of ['%2e%2e', 'reports/%2e%2e/secret', '%252e%252e', 'reports/%E0%A4%A']) {
    const response = await browse(`prefix=${prefix}`);
    expect(response.status(), prefix).toBe(403);
    expect(await response.json(), prefix).toMatchObject({
      error: { code: 'storage_connection_prefix_not_allowed' },
    });
  }
});
