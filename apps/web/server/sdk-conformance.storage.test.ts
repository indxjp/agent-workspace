/**
 * SDK conformance, storage connections: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import {
  StorageConnectionBrowseResponseSchema,
  StorageConnectionListResponseSchema,
  StorageConnectionResourceSchema,
  StorageConnectionTestOutcomeSchema,
  STORAGE_CONNECTION_PROBLEM_CODES,
} from '@indx-workspace/contracts/storage-connections';
import { createInMemoryStorageConnectionRepositoryProvider } from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import {
  browseStorageConnection,
  createStorageConnection,
  deleteStorageConnection,
  getStorageConnection,
  listStorageConnections,
  rotateStorageConnectionCredential,
  testStorageConnection,
  updateStorageConnection,
} from './storage-connections/handlers';
import { createRepositoryStorageConnectionsStoreProvider } from './storage-connections/store';
import { Principal } from './rbac/principal';

const STORAGE_WORKSPACE = '99999999-9999-4999-8999-999999999999';

function storageOwner(): Principal {
  return Principal.fromApiKey({
    principalId: '77777777-7777-4777-8777-777777777777',
    apiKeyId: '66666666-6666-4666-8666-666666666666',
    workspaceId: STORAGE_WORKSPACE,
    role: 'owner',
    label: 'conformance',
  });
}

/** The storage-connections runtime over in-memory repositories and a `file://` root. */
function storageRuntime(root: string) {
  return {
    store: createRepositoryStorageConnectionsStoreProvider({
      repositories: createInMemoryStorageConnectionRepositoryProvider(),
      scopes: createInMemoryWorkspaceScopeResolver([{ id: STORAGE_WORKSPACE, slug: 'storage' }]),
      secrets: createInMemorySecretsService(),
    }),
    fileRoots: [root],
    egress: { production: true, allowHosts: [] },
    isConnectionGranted: () => Promise.resolve(false),
    audit: () => Promise.resolve(),
  };
}

type StorageRuntime = ReturnType<typeof storageRuntime>;

/** Drives every route once and parses each answer against its published schema. */
async function expectEveryStorageRouteRendered(
  runtime: StorageRuntime,
  principal: Principal,
  root: string,
): Promise<{ readonly remoteUrl: string }> {
  const created = await createStorageConnection(runtime, principal, {
    name: 'conformance',
    url: `file://${root}`,
    allowedPrefixes: ['reports'],
  });
  expect(created.status).toBe(201);
  const { id } = StorageConnectionResourceSchema.parse(created.body);
  const remote = StorageConnectionResourceSchema.parse(
    (
      await createStorageConnection(runtime, principal, {
        name: 'remote',
        url: 's3://acme-data/exports?endpoint=https://s3.eu-west-1.amazonaws.com',
        allowedPrefixes: ['reports'],
        credential: { provider: 's3', accessKeyId: 'id', secretAccessKey: 'secret' },
      })
    ).body,
  );
  StorageConnectionListResponseSchema.parse(
    (await listStorageConnections(runtime, principal)).body,
  );
  StorageConnectionResourceSchema.parse((await getStorageConnection(runtime, principal, id)).body);
  StorageConnectionResourceSchema.parse(
    (await updateStorageConnection(runtime, principal, id, { writeAllowed: true })).body,
  );
  StorageConnectionResourceSchema.parse(
    (
      await rotateStorageConnectionCredential(runtime, principal, remote.id, {
        provider: 's3',
        accessKeyId: 'id',
        secretAccessKey: 'rotated',
      })
    ).body,
  );
  StorageConnectionTestOutcomeSchema.parse(
    (await testStorageConnection(runtime, principal, id)).body,
  );
  await mkdir(path.join(root, 'reports'), { recursive: true });
  await writeFile(path.join(root, 'reports/a.txt'), 'a');
  const browsed = StorageConnectionBrowseResponseSchema.parse(
    (
      await browseStorageConnection(
        runtime,
        principal,
        id,
        'https://aw.example.com/x?prefix=reports',
      )
    ).body,
  );
  expect(browsed.entries).toContainEqual({ path: 'reports/a.txt', kind: 'file', size: 1 });
  expect((await deleteStorageConnection(runtime, principal, id)).status).toBe(204);
  return { remoteUrl: remote.url };
}

async function expectStorageRefusalsPublished(
  runtime: StorageRuntime,
  principal: Principal,
  remoteUrl: string,
): Promise<void> {
  const unknown = '55555555-5555-4555-8555-555555555555';
  for (const refused of [
    await getStorageConnection(runtime, principal, unknown),
    await createStorageConnection(runtime, principal, {
      name: 'remote',
      url: remoteUrl,
      allowedPrefixes: ['reports'],
    }),
  ]) {
    const { code } = ApiProblemSchema.parse(refused.body).error;
    expect(STORAGE_CONNECTION_PROBLEM_CODES).toHaveProperty(code, refused.status);
  }
}

describe('storage connections (issue #1691)', () => {
  it('renders every route answer into the published shape and refuses under the published status', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-conformance-storage-')));
    try {
      const runtime = storageRuntime(root);
      const principal = storageOwner();
      const { remoteUrl } = await expectEveryStorageRouteRendered(runtime, principal, root);
      await expectStorageRefusalsPublished(runtime, principal, remoteUrl);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
