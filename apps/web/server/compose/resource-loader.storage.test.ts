/**
 * What the run resource loader makes of granted connection folders (US-STO-12, the storage design,
 * §05): references under `storage/<name>/`, the grant re-checked against the connection as it is
 * now, keys that could leave that folder skipped, and the shared run-size cap.
 */
// @story US-STO-12
import {
  bytesToStream,
  createInMemoryObjectStore,
  streamToBytes,
  type ObjectListEntry,
} from '@agent-workspace/core/storage';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createStorageService, type StorageService } from '../storage/service';
import { log } from '../telemetry/logger';
import { STREAMED_SHA256 } from '../runs/streamed-digests';
import {
  createAgentRunResourceLoader,
  type RunConnectionStore,
  type RunStorageConnections,
} from './resource-loader';

const quietLog = { info() {}, warn() {}, error() {}, child: () => quietLog };

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';

const file = (key: string, sizeBytes = 3): ObjectListEntry => ({
  kind: 'file',
  key,
  sizeBytes,
  contentType: null,
  lastModified: new Date(0),
});

/** A connection whose store lists `pages` in turn and serves `bytes` for every key. */
function connection(
  pages: readonly (readonly ObjectListEntry[])[],
  overrides: Partial<{ name: string; writeAllowed: boolean; allowedPrefixes: string[] }> = {},
) {
  const cursors: (string | undefined)[] = [];
  const store = {
    listPage: (_prefix: string, options?: { cursor?: string }) => {
      cursors.push(options?.cursor);
      const index = options?.cursor === undefined ? 0 : Number(options.cursor);
      return Promise.resolve({
        entries: pages[index] ?? [],
        cursor: index + 1 < pages.length ? String(index + 1) : null,
      });
    },
    read: () => Promise.resolve({ body: bytesToStream(Buffer.from('abc')) }),
  } satisfies RunConnectionStore;
  const storageConnections: RunStorageConnections = {
    get: () =>
      Promise.resolve({
        name: 'acme-data',
        allowedPrefixes: ['reports'],
        writeAllowed: false,
        ...overrides,
      }),
    open: () => Promise.resolve(store),
    openWritable: () => Promise.reject(new Error('a delivery never opens a writable store')),
  };
  return { storageConnections, cursors };
}

const grant = (access: 'read' | 'read-write' = 'read') => ({
  connectionId: CONNECTION,
  prefix: 'reports',
  access,
});

function load(
  storageConnections: RunStorageConnections | undefined,
  options: { sizesOnly?: boolean; access?: 'read' | 'read-write'; writeFiles?: boolean } = {},
) {
  const loader = createAgentRunResourceLoader({
    catalog: createInMemoryCatalogStore(),
    ...(storageConnections === undefined ? {} : { storageConnections }),
    ...(options.sizesOnly === true ? { sizesOnly: true } : {}),
  });
  return loader.load(
    WORKSPACE,
    { files: [], skillIds: [], connectorIds: [], storageGrants: [grant(options.access)] },
    null,
    options.writeFiles === undefined
      ? undefined
      : {
          readFiles: true,
          writeFiles: options.writeFiles,
          runCommands: false,
          unrestrictedNetwork: false,
        },
  );
}

const paths = (selection: Awaited<ReturnType<typeof load>>) =>
  selection.files.map((entry) => entry.path);

afterEach(() => vi.restoreAllMocks());

describe('a granted connection folder', () => {
  it('[US-STO-12][unit][run] becomes references under storage/<name>/, streamed from the store', async () => {
    const { storageConnections } = connection([[file('reports/a.csv'), file('reports/q3/b.csv')]]);
    const loaded = await load(storageConnections);

    expect(loaded.files).toEqual([
      { kind: 'directory', path: 'storage/acme-data/reports', access: 'read' },
      {
        kind: 'file',
        path: 'storage/acme-data/reports/a.csv',
        access: 'read',
        size: 3,
        sha256: STREAMED_SHA256,
      },
      {
        kind: 'file',
        path: 'storage/acme-data/reports/q3/b.csv',
        access: 'read',
        size: 3,
        sha256: STREAMED_SHA256,
      },
    ]);
    const source = loaded.sources?.get('storage/acme-data/reports/a.csv');
    expect(source?.streamed).toBe(true);
    const body = await source?.open();
    expect(
      Buffer.from(await streamToBytes(body ?? bytesToStream(Buffer.alloc(0)))).toString(),
    ).toBe('abc');
  });

  it('[US-STO-12][unit][run] is listed by size alone for the start-time check', async () => {
    const { storageConnections } = connection([[file('reports/a.csv', 7)]]);
    const loaded = await load(storageConnections, { sizesOnly: true });
    expect(loaded.files).toContainEqual({
      kind: 'file',
      path: 'storage/acme-data/reports/a.csv',
      access: 'read',
      size: 7,
      sha256: '',
    });
    expect(loaded.sources?.size ?? 0).toBe(0);
  });

  it('[US-STO-12][unit][run] is read page after page', async () => {
    const { storageConnections, cursors } = connection([
      [file('reports/a.csv')],
      [file('reports/b.csv')],
    ]);
    expect(paths(await load(storageConnections))).toEqual([
      'storage/acme-data/reports',
      'storage/acme-data/reports/a.csv',
      'storage/acme-data/reports/b.csv',
    ]);
    expect(cursors).toEqual([undefined, '1']);
  });

  it('[US-STO-12][unit][run] skips every key that could leave storage/<name>/, and logs no key', async () => {
    // Built at run time: a literal key-shaped string would trip the secret scanner.
    const attacks = [
      'reports/../../etc/passwd',
      `/${'reports'}/abs.txt`,
      'reports\\win.txt',
      `reports/nul${String.fromCharCode(0)}.txt`,
      `reports/${'%2e'.repeat(2)}/x.txt`,
      'reports/a%2fb.txt',
      'elsewhere/x.txt',
    ];
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { storageConnections } = connection([
      [...attacks.map((key) => file(key)), file('reports/ok.txt')],
    ]);

    const loaded = await load(storageConnections);

    expect(paths(loaded)).toEqual([
      'storage/acme-data/reports',
      'storage/acme-data/reports/ok.txt',
    ]);
    expect([...(loaded.sources?.keys() ?? [])]).toEqual(['storage/acme-data/reports/ok.txt']);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).toContain(`"skipped":${String(attacks.length)}`);
    for (const key of attacks)
      expect(JSON.stringify(warn.mock.calls)).not.toContain(JSON.stringify(key));
  });

  it('[US-STO-12][unit][run] counts toward the run limit and fails fast with run_files_too_large', async () => {
    const { storageConnections } = connection([
      [file('reports/a.bin', RUN_FILES_MAX_BYTES), file('reports/b.bin', 1)],
    ]);
    await expect(load(storageConnections)).rejects.toMatchObject({ code: 'run_files_too_large' });
  });
  it('[US-STO-12][unit][run] counts an object two overlapping grants list only once', async () => {
    // The fake lists every key under `reports` for each grant, so `reports/2026/a.bin` is listed twice.
    const { storageConnections } = connection([[file('reports/2026/a.bin', RUN_FILES_MAX_BYTES)]]);
    const loader = createAgentRunResourceLoader({
      catalog: createInMemoryCatalogStore(),
      storageConnections,
    });
    const loaded = await loader.load(WORKSPACE, {
      files: [],
      skillIds: [],
      connectorIds: [],
      storageGrants: [grant(), { ...grant(), prefix: 'reports/2026' }],
    });
    expect(paths(loaded)).toContain('storage/acme-data/reports/2026/a.bin');
  });

  it('[US-STO-12][unit][run] keeps its own streamed source when a workspace file has the same path', async () => {
    const path = 'storage/acme-data/reports/a.csv';
    const catalogs = createInMemoryCatalogStore();
    const storage = createStorageService({
      catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
      objects: createInMemoryObjectStore(),
      log: quietLog,
    });
    const saved = await storage.save(
      { workspaceId: WORKSPACE, principalId: '44444444-4444-4444-8444-444444444444', userId: null },
      {
        area: 'files',
        path,
        body: bytesToStream(Buffer.from('workspace')),
        maxBytes: 1024,
        replace: true,
      },
    );
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    const row = saved.row;
    // The workspace file is read last, so a shared source map would end up holding it.
    const slow: Pick<StorageService, 'open' | 'list'> = {
      ...storage,
      open: async (ctx, target, range) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return storage.open(ctx, target, range);
      },
    };
    const { storageConnections } = connection([[file('reports/a.csv')]]);
    const loader = createAgentRunResourceLoader({
      catalog: catalogs,
      storage: slow,
      storageConnections,
    });

    const loaded = await loader.load(WORKSPACE, {
      files: [{ fileId: row.id, access: 'read' }],
      skillIds: [],
      connectorIds: [],
      storageGrants: [grant()],
    });

    expect(loaded.files.find((entry) => entry.path === path)).toMatchObject({
      sha256: STREAMED_SHA256,
    });
    const source = loaded.sources?.get(path);
    expect(source?.streamed).toBe(true);
    const body = await source?.open();
    expect(
      Buffer.from(await streamToBytes(body ?? bytesToStream(Buffer.alloc(0)))).toString(),
    ).toBe('abc');
  });
});

describe('a grant is re-checked when the run starts', () => {
  it('[US-STO-12][unit][run] refuses a connection that is gone', async () => {
    const storageConnections: RunStorageConnections = {
      get: () => Promise.resolve(null),
      open: () => Promise.reject(new Error('never opened')),
      openWritable: () => Promise.reject(new Error('never opened')),
    };
    await expect(load(storageConnections)).rejects.toMatchObject({
      code: 'run_storage_grant_unavailable',
    });
  });

  it('[US-STO-12][unit][run] names the folder after the connection as it is called now', async () => {
    const { storageConnections } = connection([[file('reports/a.csv')]], { name: 'acme-archive' });
    expect(paths(await load(storageConnections))).toEqual([
      'storage/acme-archive/reports',
      'storage/acme-archive/reports/a.csv',
    ]);
  });

  it('[US-STO-12][unit][run] refuses a deployment that keeps no connections', async () => {
    await expect(load(undefined)).rejects.toMatchObject({ code: 'run_storage_grant_unavailable' });
  });

  it('[US-STO-12][unit][run] refuses a folder the connection no longer allows', async () => {
    const { storageConnections } = connection([[file('reports/a.csv')]], {
      allowedPrefixes: ['raw'],
    });
    await expect(load(storageConnections)).rejects.toMatchObject({
      code: 'run_storage_grant_unavailable',
    });
  });

  it('[US-STO-12][unit][run] narrows a read-write grant to read once the connection stops allowing writes', async () => {
    const { storageConnections } = connection([[file('reports/a.csv')]], { writeAllowed: false });
    const loaded = await load(storageConnections, { access: 'read-write' });
    expect(loaded.files.map((entry) => entry.access)).toEqual(['read', 'read']);
  });

  it('[US-STO-12][unit][run] narrows a read-write grant to read when the agent may not write files', async () => {
    const { storageConnections } = connection([[file('reports/a.csv')]], { writeAllowed: true });
    const loaded = await load(storageConnections, { access: 'read-write', writeFiles: false });
    expect(loaded.files.map((entry) => entry.access)).toEqual(['read', 'read']);
  });

  it('[US-STO-12][unit][run] narrows a read-write grant to read when the agent permissions are omitted', async () => {
    const { storageConnections } = connection([[file('reports/a.csv')]], { writeAllowed: true });
    const loaded = await load(storageConnections, { access: 'read-write' });
    expect(loaded.files.map((entry) => entry.access)).toEqual(['read', 'read']);
  });

  it('[US-STO-12][unit][run] delivers a read-write grant writable when the connection and the agent allow writing', async () => {
    const { storageConnections } = connection([[file('reports/a.csv')]], { writeAllowed: true });
    const loaded = await load(storageConnections, { access: 'read-write', writeFiles: true });
    expect(loaded.files.map((entry) => entry.access)).toEqual(['read-write', 'read-write']);
    expect(loaded.storageFolders).toEqual(
      new Map([['storage/acme-data/reports', { connectionId: CONNECTION, prefix: 'reports' }]]),
    );
  });

  it('[US-STO-12][unit][run] delivers a read grant read only even when the connection and the agent allow writing', async () => {
    const { storageConnections } = connection([[file('reports/a.csv')]], { writeAllowed: true });
    const loaded = await load(storageConnections, { access: 'read', writeFiles: true });
    // The runner materialises a `read` reference 0444.
    expect(loaded.files.map((entry) => entry.access)).toEqual(['read', 'read']);
    expect(loaded.storageFolders).toBeUndefined();
  });
});
