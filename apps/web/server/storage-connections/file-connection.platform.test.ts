/**
 * A `file://` storage connection on the host's own platform (#1835 STO-506). The URL of a folder is
 * written the way the platform writes one, `pathToFileURL`: `file:///srv/acme` on POSIX and
 * `file:///C:/srv/acme` on Windows, where `file://${dir}` would put a drive letter and backslashes
 * in the host. The suite runs on Linux in `pnpm test` and on Windows in `windows-unit.yml`, over the
 * in-memory repository and secret store, so it needs no service on either.
 */
// @story US-STO-12
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import {
  StorageConnectionBrowseResponseSchema,
  StorageConnectionResourceSchema,
} from '@indx-workspace/contracts/storage-connections';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as browseRoute } from '../../app/api/storage-connections/[id]/browse/route';
import { POST as createRoute } from '../../app/api/storage-connections/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createRepositoryStorageConnectionsStoreProvider } from './store';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

// The operator root is a folder of its own under the temporary directory, so the temporary
// directory itself is outside every root.
const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aw-file-outside-')));
const fileRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'aw-file-root-')));
afterAll(() => {
  rmSync(fileRoot, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

beforeEach(() => {
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            workspaceId: WORKSPACE,
            role: 'admin',
            label: 'Platform file test',
          }),
        ),
    },
    storageConnections: {
      kind: 'serving',
      runtime: {
        store: createRepositoryStorageConnectionsStoreProvider({
          repositories: createInMemoryStorageConnectionRepositoryProvider(),
          scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'w' }]),
          secrets: createInMemorySecretsService(),
        }),
        fileRoots: [fileRoot],
        egress: { production: true, allowHosts: [] },
        isConnectionGranted: () => Promise.resolve(false),
        audit: () => Promise.resolve(),
      },
    },
  });
});

afterEach(() => {
  clearApplicationContext();
});

function post(name: string, dir: string): Promise<Response> {
  return createRoute(
    new Request('http://localhost/api/storage-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, url: pathToFileURL(dir).href, allowedPrefixes: ['reports'] }),
    }),
  );
}

describe(`a file:// storage connection on ${process.platform}`, () => {
  it('[US-STO-12][api][sdk] a folder under an operator root connects', async () => {
    const dir = path.join(fileRoot, 'acme');
    mkdirSync(dir);

    const response = await post('acme-data', dir);

    expect(response.status, await response.clone().text()).toBe(201);
    expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
      provider: 'file',
      hasCredential: false,
    });
  });

  it('[US-STO-12][api][sdk] a folder outside every operator root is refused as forbidden, not as a bad URL', async () => {
    const response = await post('outside', outside);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'storage_connection_endpoint_forbidden' },
    });
  });

  it('[US-STO-12][api][sdk] the folder lists its files with / between the segments of a key', async () => {
    const dir = path.join(fileRoot, 'listed');
    mkdirSync(path.join(dir, 'reports', '2026'), { recursive: true });
    writeFileSync(path.join(dir, 'reports', 'a.txt'), 'a');
    writeFileSync(path.join(dir, 'reports', '2026', 'b.txt'), 'b');
    const created = await post('listed', dir);
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = StorageConnectionResourceSchema.parse(await created.json());

    const response = await browseRoute(
      new Request(`http://localhost/api/storage-connections/${id}/browse?prefix=reports`),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const page = StorageConnectionBrowseResponseSchema.parse(await response.json());
    expect(page.entries.map((entry) => entry.path)).toEqual(['reports/2026', 'reports/a.txt']);
  });
});
