/**
 * How a run opens a granted storage connection (US-STO-12): the credential is read from the secret
 * store for this run, and every expected failure is `run_storage_grant_unavailable` with no
 * credential text in its message.
 */
// @story US-STO-12
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
  type StorageConnectionRepositoryProvider,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseStorageConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import { openConnectionStore } from '@agent-workspace/core/storage';
import type { StorageConnectionResource } from '@indx-workspace/contracts/storage-connections';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  boundCredential,
  createRepositoryStorageConnectionsStoreProvider,
} from '../../storage-connections/store';
import { log } from '../../telemetry/logger';
import { createRunStorageConnections } from './run-resources';

// Pass-through, so a test can read the credential a run opens the store with.
vi.mock('@agent-workspace/core/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-workspace/core/storage')>();
  return { ...actual, openConnectionStore: vi.fn(actual.openConnectionStore) };
});

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
// Built at run time: a literal key-shaped string would trip the secret scanner.
const SECRET_TEXT = ['wJalrX', 'UtnFEMI', 'K7MDENG'].join('');

let root: string;
let isolated: IsolatedTestDatabase | undefined;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aw-run-storage-'));
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL case is never skipped.
  isolated = await createIsolatedTestDatabase('aw_run_storage_connections');
}, 180_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await isolated?.close();
});
afterEach(() => vi.mocked(openConnectionStore).mockClear());

function connections(
  connection: Partial<StorageConnectionResource>,
  secret: string | null = null,
  fileRoots: readonly string[] = [root],
) {
  const row: StorageConnectionResource = {
    id: CONNECTION,
    name: 'acme-data',
    provider: 'file',
    url: `file://${root}`,
    allowedPrefixes: ['reports'],
    writeAllowed: false,
    hasCredential: secret !== null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...connection,
  };
  return createRunStorageConnections({
    storage: {
      store: {
        forWorkspace: () => ({
          get: () => Promise.resolve(row),
          credential: (_id: string, url: string) =>
            Promise.resolve(
              boundCredential(secret === null ? undefined : Buffer.from(secret), url),
            ),
        }),
      },
      fileRoots,
    },
    scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
  });
}

async function refusal(open: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  const error: unknown = await open.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof Error)) throw new Error('the connection opened');
  return { code: 'code' in error ? error.code : undefined, message: error.message };
}

const s3 = { provider: 's3' as const, url: 's3://acme-bucket' };

describe('opening a granted storage connection for a run', () => {
  it('[US-STO-12][unit][run] opens a file connection with no credential', async () => {
    const store = await connections({}).open(WORKSPACE, CONNECTION);
    expect((await store.listPage('reports', { recursive: true })).entries).toEqual([]);
  });

  it('[US-STO-12][unit][run] logs what a file connection listing left out, as counts and the connection id', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await mkdir(path.join(root, 'reports'), { recursive: true });
    // A link is never listed, wherever it points.
    await symlink(path.join(root, 'nowhere'), path.join(root, 'reports', 'leak.txt'));
    try {
      const store = await connections({}).open(WORKSPACE, CONNECTION);
      expect((await store.listPage('reports', { recursive: true })).entries).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.any(String), {
        connectionId: CONNECTION,
        links: 1,
        unreadable: 0,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(root);
    } finally {
      warn.mockRestore();
      await rm(path.join(root, 'reports'), { recursive: true, force: true });
    }
  });

  it('[US-STO-12][unit][run] refuses a connection whose credential is missing', async () => {
    const { code, message } = await refusal(connections(s3).open(WORKSPACE, CONNECTION));
    expect(code).toBe('run_storage_grant_unavailable');
    expect(message).toContain('is missing');
  });

  it('[US-STO-12][unit][run] refuses a credential that is not JSON, and never quotes it', async () => {
    const { code, message } = await refusal(
      connections(s3, SECRET_TEXT).open(WORKSPACE, CONNECTION),
    );
    expect(code).toBe('run_storage_grant_unavailable');
    expect(message).not.toContain(SECRET_TEXT.slice(0, 4));
  });

  it('[US-STO-12][unit][run] refuses a connection that cannot be opened, naming only the code', async () => {
    const { code, message } = await refusal(connections({}, null, []).open(WORKSPACE, CONNECTION));
    expect(code).toBe('run_storage_grant_unavailable');
    expect(message).toContain('(storage_connection_endpoint_forbidden)');
    expect(message).not.toContain(root);
  });

  it('[US-STO-12][unit][run] refuses a writable store for a connection that no longer allows writes', async () => {
    const { code, message } = await refusal(
      connections({ writeAllowed: false }).openWritable(WORKSPACE, CONNECTION),
    );
    expect(code).toBe('run_storage_grant_unavailable');
    expect(message).toContain('no longer allows writes');
    expect(openConnectionStore).not.toHaveBeenCalled();
  });

  it('[US-STO-12][unit][run] opens a writable store for a connection that allows writes, with the save signal', async () => {
    const saving = new AbortController().signal;
    await connections({ writeAllowed: true }).openWritable(WORKSPACE, CONNECTION, saving);
    expect(vi.mocked(openConnectionStore).mock.calls[0]?.[2]).toMatchObject({
      writable: true,
      signal: saving,
    });
  });

  it('[US-STO-12][unit][run] opens the store with the outbound proxy the environment names', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.internal:3128');
    vi.stubEnv('NO_PROXY', '.corp.example');
    try {
      await connections({}).open(WORKSPACE, CONNECTION);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(vi.mocked(openConnectionStore).mock.calls[0]?.[2]).toMatchObject({
      proxy: { httpsProxy: 'http://proxy.internal:3128', noProxy: ['.corp.example'] },
    });
  });
});

interface StoreWorld {
  readonly repositories: StorageConnectionRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly workspaceA: string;
  readonly workspaceB: string;
}

function memoryStoreWorld(): Promise<StoreWorld> {
  const workspaceA = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();
  return Promise.resolve({
    repositories: createInMemoryStorageConnectionRepositoryProvider(),
    scopes: createInMemoryWorkspaceScopeResolver([
      { id: workspaceA, slug: 'a' },
      { id: workspaceB, slug: 'b' },
    ]),
    workspaceA,
    workspaceB,
  });
}

async function postgresStoreWorld(): Promise<StoreWorld> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const workspaceA = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();
  await isolated.db.insert(workspaces).values([
    { id: workspaceA, slug: `a-${workspaceA}`, name: 'A' },
    { id: workspaceB, slug: `b-${workspaceB}`, name: 'B' },
  ]);
  return {
    repositories: createDatabaseStorageConnectionRepositoryProvider(isolated.db),
    scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
    workspaceA,
    workspaceB,
  };
}

/** An S3 credential, built at run time: a key-shaped literal trips the secret scanner. */
const s3Credential = () => ({
  provider: 's3' as const,
  accessKeyId: ['AK', 'IA'].join('') + crypto.randomUUID().replaceAll('-', '').slice(0, 16),
  secretAccessKey: crypto.randomUUID() + crypto.randomUUID(),
});

/** The real connection store over `world`, a connection in workspace A, and the run's view of it. */
async function storedConnection(world: StoreWorld) {
  const secrets = createInMemorySecretsService();
  const store = createRepositoryStorageConnectionsStoreProvider({
    repositories: world.repositories,
    scopes: world.scopes,
    secrets,
  });
  const first = s3Credential();
  const created = await store.forWorkspace(world.workspaceA).create({
    name: 'acme-data',
    url: 's3://acme-bucket',
    provider: 's3',
    allowedPrefixes: ['reports'],
    writeAllowed: false,
    credential: first,
  });
  if (created.kind !== 'created') throw new Error('the connection is created');
  const runs = createRunStorageConnections({
    storage: { store, fileRoots: [root] },
    scopes: world.scopes,
  });
  return { store, runs, id: created.connection.id, first };
}

function defineStoreSuite(name: string, setup: () => Promise<StoreWorld>) {
  describe(`a run's storage connections on the ${name}`, () => {
    it('[US-STO-12][unit][run] opens the next run with a credential rotated since the last one', async () => {
      const world = await setup();
      const { store, runs, id, first } = await storedConnection(world);
      const opened = vi.mocked(openConnectionStore);
      const stub = {} as Awaited<ReturnType<typeof openConnectionStore>>;
      opened.mockResolvedValueOnce(stub).mockResolvedValueOnce(stub);

      await runs.open(world.workspaceA, id);
      const second = s3Credential();
      expect(
        (await store.forWorkspace(world.workspaceA).rotate(id, 's3://acme-bucket', second)).kind,
      ).toBe('changed');
      await runs.open(world.workspaceA, id);

      expect(opened.mock.calls.map((call) => call[1])).toEqual([first, second]);
    });

    it("[US-STO-12][unit][run] never reads or opens another workspace's connection", async () => {
      const world = await setup();
      const { runs, id } = await storedConnection(world);

      expect(await runs.get(world.workspaceB, id)).toBeNull();
      const { code } = await refusal(runs.open(world.workspaceB, id));
      expect(code).toBe('run_storage_grant_unavailable');
      expect(openConnectionStore).not.toHaveBeenCalled();
      expect(await runs.get(world.workspaceA, id)).toMatchObject({ name: 'acme-data' });
    });
  });
}

defineStoreSuite('in-memory store', memoryStoreWorld);
defineStoreSuite('PostgreSQL store', postgresStoreWorld);
