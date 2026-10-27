import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  createInMemoryStorageMigrationRuns,
  type ResourceCatalogRepository,
} from '@agent-workspace/core/db';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { parseLegacyKey } from './legacy-naming';
import { runAdoptStage } from './migrate-naming';

const PREFIX = 'files/workspaces';

interface Fixture {
  /** A workspace with an owner principal, or one the catalog has never heard of. */
  readonly workspace: (options?: { readonly owner?: boolean }) => Promise<{
    readonly id: string;
    readonly principalId: string | null;
  }>;
  readonly catalog: (workspaceId: string) => Promise<ResourceCatalogRepository>;
}

function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  return Promise.resolve({
    workspace: (options) =>
      Promise.resolve({
        id: crypto.randomUUID(),
        principalId: options?.owner === false ? null : crypto.randomUUID(),
      }),
    catalog: (workspaceId) => Promise.resolve(provider.forWorkspace(workspaceId)),
  });
}

let isolated: IsolatedTestDatabase | undefined;
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[storage/migrate-adopt.test.ts] the PostgreSQL catalog suite was SKIPPED — ' +
      'TEST_DATABASE_URL is not set, so adopt was NOT exercised against the database.',
  );
}

beforeAll(async () => {
  if (hasDatabase) isolated = await createIsolatedTestDatabase('aw_storage_migrate_adopt');
}, 180_000);

afterAll(async () => isolated?.close());

function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const provider = createDatabaseResourceCatalogRepositoryProvider(db);
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return Promise.resolve({
    workspace: async (options) => {
      const id = crypto.randomUUID();
      await db.insert(workspaces).values({ id, slug: `s-${id}`, name: 'adopt' });
      if (options?.owner === false) return { id, principalId: null };
      const userId = crypto.randomUUID();
      const membershipId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
      await db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
        await tx
          .insert(workspacePrincipals)
          .values({ id: principalId, workspaceId: id, kind: 'membership', membershipId });
      });
      return { id, principalId };
    },
    catalog: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
      return provider.forScope(scope);
    },
  });
}

function defineSuite(enabled: boolean, name: string, setup: () => Promise<Fixture>) {
  (enabled ? describe : describe.skip)(`adopting row-less legacy objects on the ${name}`, () => {
    async function harness() {
      const f = await setup();
      const objects = createInMemoryObjectStore();
      const lines: { message: string; fields: unknown }[] = [];
      const log: Logger = {
        info: (message, fields) => lines.push({ message, fields }),
        warn: (message, fields) => lines.push({ message, fields }),
        error: (message, fields) => lines.push({ message, fields }),
        child: () => log,
      };
      const owners = new Map<string, string | null>();
      const known = async (options?: { readonly owner?: boolean }) => {
        const created = await f.workspace(options);
        owners.set(created.id, created.principalId);
        return created;
      };
      /** An object the old layout wrote: raw bytes under the legacy prefix, no catalog row. */
      const legacyObject = (workspaceId: string, path: string, contentType: string | null = null) =>
        objects.write(`${PREFIX}/${workspaceId}/${path}`, new Uint8Array(7), { contentType });
      const runs = createInMemoryStorageMigrationRuns();
      const run = (pageSize?: number, catalog = f.catalog) =>
        runAdoptStage({
          objects,
          prefix: PREFIX,
          catalog,
          ownerPrincipalId: (id) => Promise.resolve(owners.get(id) ?? null),
          runs,
          log,
          ...(pageSize === undefined ? {} : { pageSize }),
        });
      return { f, known, legacyObject, run, runs, lines, log };
    }

    // @story US-STO-13
    it('[US-STO-13][unit][cli] an object uploaded by signed link before the fix gets a ready row and stays listed', async () => {
      const { f, known, legacyObject, run } = await harness();
      const ws = await known();
      await legacyObject(ws.id, 'reports/q1.pdf', 'application/pdf');

      await expect(run()).resolves.toMatchObject({ adopted: 1, skipped: 0 });

      const catalog = await f.catalog(ws.id);
      const listed = (await catalog.list('reports')).rows.filter((row) => row.kind === 'file');
      expect(listed).toEqual([
        expect.objectContaining({
          path: 'reports/q1.pdf',
          kind: 'file',
          status: 'ready',
          objectId: null,
          storageKey: 'reports/q1.pdf',
          sizeBytes: 7,
          contentType: 'application/pdf',
          ownerPrincipalId: ws.principalId,
        }),
      ]);
      await expect(catalog.get('reports')).resolves.toMatchObject({ kind: 'folder' });
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] adopt gives every row-less legacy object a row', async () => {
      const { f, known, legacyObject, run } = await harness();
      const one = await known();
      const two = await known();
      await legacyObject(one.id, 'a.txt');
      await legacyObject(one.id, 'deep/b.txt');
      await legacyObject(two.id, 'c.txt');

      await expect(run(2)).resolves.toMatchObject({ adopted: 3, hadRow: 0, skipped: 0 });

      const rowsOf = async (id: string) =>
        (await (await f.catalog(id)).list('')).rows
          .filter((row) => row.kind === 'file')
          .map((row) => row.path)
          .sort();
      await expect(rowsOf(one.id)).resolves.toEqual(['a.txt', 'deep/b.txt']);
      await expect((await f.catalog(one.id)).get('deep/b.txt')).resolves.not.toBeNull();
      await expect(rowsOf(two.id)).resolves.toEqual(['c.txt']);
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] a rerun adopts nothing', async () => {
      const { known, legacyObject, run } = await harness();
      const ws = await known();
      await legacyObject(ws.id, 'a.txt');
      await legacyObject(ws.id, 'b.txt');
      await run();

      await expect(run()).resolves.toMatchObject({ adopted: 0, hadRow: 2, skipped: 0 });
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] two concurrent runs adopt each object once', async () => {
      const { f, known, legacyObject, run } = await harness();
      const ws = await known();
      const paths = Array.from({ length: 12 }, (_, index) => `dir/file-${index}.txt`);
      for (const path of paths) await legacyObject(ws.id, path);

      const [first, second] = await Promise.all([run(5), run(5)]);

      expect(first.adopted + second.adopted).toBe(paths.length);
      const folder = (await (await f.catalog(ws.id)).list('dir')).rows.filter(
        (row) => row.kind === 'file',
      );
      expect(folder.map((row) => row.path).sort()).toEqual([...paths].sort());
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] a folder marker and a staging tar are not adopted', async () => {
      const { f, known, legacyObject, run } = await harness();
      const ws = await known();
      await legacyObject(ws.id, 'empty/.agent-workspace-empty-folder');
      await legacyObject(ws.id, 'runs/run-1/outputs/.runtime-staging.tar');
      await legacyObject(ws.id, 'runs/run-1/outputs/result.txt');

      await expect(run()).resolves.toMatchObject({ adopted: 1, hadRow: 0, skipped: 0 });

      const catalog = await f.catalog(ws.id);
      await expect(catalog.get('empty')).resolves.toBeNull();
      await expect(catalog.get('runs/run-1/outputs/.runtime-staging.tar')).resolves.toBeNull();
      await expect(catalog.get('runs/run-1/outputs/result.txt')).resolves.not.toBeNull();
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] a listed key no route could name is not adopted and the rest are', async () => {
      const { f, known, log } = await harness();
      const ws = await known();
      const unsafe = ['%aside/x', 'a/../b', 'a//b', 'a/'].map((path) => ({
        kind: 'file' as const,
        key: `${PREFIX}/${ws.id}/${path}`,
        sizeBytes: 7,
        contentType: null,
        lastModified: new Date(),
      }));
      const listed = createInMemoryObjectStore();
      await listed.write(`${PREFIX}/${ws.id}/kept.txt`, new Uint8Array(7), { contentType: null });
      const page = await listed.listPage(PREFIX, { recursive: true });

      await expect(
        runAdoptStage({
          objects: {
            ...listed,
            listPage: () => Promise.resolve({ ...page, entries: [...unsafe, ...page.entries] }),
          },
          prefix: PREFIX,
          catalog: f.catalog,
          ownerPrincipalId: () => Promise.resolve(ws.principalId),
          runs: createInMemoryStorageMigrationRuns(),
          log,
        }),
      ).resolves.toMatchObject({ adopted: 1, hadRow: 0, skipped: 0 });

      const files = (await (await f.catalog(ws.id)).list('')).rows.filter(
        (row) => row.kind === 'file',
      );
      expect(files.map((row) => row.path)).toEqual(['kept.txt']);
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] an object whose row is deleting is not adopted', async () => {
      const { f, known, legacyObject, run } = await harness();
      const ws = await known();
      const catalog = await f.catalog(ws.id);
      await catalog.putFile({
        path: 'gone.txt',
        kind: 'file',
        storageKey: 'gone.txt',
        sizeBytes: 7,
        contentType: null,
        ownerPrincipalId: ws.principalId ?? '',
      });
      await catalog.remove('gone.txt');
      await legacyObject(ws.id, 'gone.txt');

      await expect(run()).resolves.toMatchObject({ adopted: 0, hadRow: 1, skipped: 0 });

      await expect(catalog.get('gone.txt')).resolves.toBeNull();
      expect((await catalog.list('')).rows).toEqual([]);
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] an object whose path holds another key is skipped and counted', async () => {
      const { f, known, legacyObject, run } = await harness();
      const ws = await known();
      const catalog = await f.catalog(ws.id);
      const reserved = await catalog.reserve('taken.txt', {
        ownerPrincipalId: ws.principalId ?? '',
        sizeBytes: 3,
        contentType: null,
        objectId: crypto.randomUUID(),
      });
      const held = await catalog.confirm(reserved.row, { sizeBytes: 3, contentType: null });
      await legacyObject(ws.id, 'taken.txt');

      await expect(run()).resolves.toMatchObject({
        adopted: 0,
        hadRow: 0,
        skipped: 1,
        pathTaken: 1,
      });

      await expect(catalog.get('taken.txt')).resolves.toMatchObject({
        id: held?.row.id,
        storageKey: reserved.row.storageKey,
      });
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] a workspace with no owner is skipped and the others still adopt', async () => {
      const { f, known, legacyObject, run } = await harness();
      const ownerless = await known({ owner: false });
      const owned = await known();
      await legacyObject(ownerless.id, 'a.txt');
      await legacyObject(owned.id, 'b.txt');

      await expect(run()).resolves.toMatchObject({
        adopted: 1,
        hadRow: 0,
        skipped: 1,
        ownerless: 1,
      });

      await expect((await f.catalog(owned.id)).get('b.txt')).resolves.not.toBeNull();
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] the pass is recorded with what it skipped, by reason', async () => {
      const { f, known, legacyObject, run, runs } = await harness();
      const owned = await known();
      const ownerless = await known({ owner: false });
      const failing = await known();
      const catalog = await f.catalog(owned.id);
      const reserved = await catalog.reserve('taken.txt', {
        ownerPrincipalId: owned.principalId ?? '',
        sizeBytes: 3,
        contentType: null,
        objectId: crypto.randomUUID(),
      });
      await catalog.confirm(reserved.row, { sizeBytes: 3, contentType: null });
      await legacyObject(owned.id, 'taken.txt');
      await legacyObject(owned.id, 'new.txt');
      await legacyObject(ownerless.id, 'a.txt');
      await legacyObject(ownerless.id, 'b.txt');
      await legacyObject(failing.id, 'c.txt');

      // A workspace whose catalog fails makes the pass unclean.
      await run(undefined, (id) =>
        id === failing.id ? Promise.reject(new Error('the workspace is gone')) : f.catalog(id),
      );
      expect(await runs.latest('adopt')).toMatchObject({
        rowsChecked: 1,
        legacyRows: 4,
        mismatches: 1,
        skippedOwnerless: 2,
        skippedPathTaken: 1,
        skippedFailed: 1,
        clean: false,
      });
      // The pass that gates deleting old objects is not touched.
      expect(await runs.latest()).toBeNull();

      await run();
      expect(await runs.latest('adopt')).toMatchObject({
        rowsChecked: 1,
        legacyRows: 3,
        mismatches: 0,
        skippedFailed: 0,
        clean: true,
      });
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] a pass that adopts nothing and finds what the last one found is not recorded again', async () => {
      const { known, legacyObject, run, runs } = await harness();
      const ws = await known();
      await legacyObject(ws.id, 'a.txt');
      const recorded = vi.spyOn(runs, 'record');

      // The pass that adopts and the first idle one after it differ; idle passes after that do not.
      await run();
      await run();
      await run();
      expect(recorded).toHaveBeenCalledTimes(2);

      await legacyObject(ws.id, 'b.txt');
      await run();
      expect(recorded).toHaveBeenCalledTimes(3);
    });

    // @story US-STO-13
    it('[US-STO-13][unit][cli] the log lines carry counts and never a key', async () => {
      const { known, legacyObject, run, lines } = await harness();
      const ws = await known();
      await legacyObject(ws.id, 'secret-looking/name.txt');

      await run();

      expect(lines.length).toBeGreaterThan(0);
      const written = JSON.stringify(lines);
      expect(written).not.toContain('name.txt');
      expect(written).not.toContain(ws.id);
      expect(lines.at(-1)?.fields).toMatchObject({ stage: 'adopt', adopted: 1, skipped: 0 });
    });
  });
}

defineSuite(true, 'in-memory catalog', memoryFixture);
defineSuite(hasDatabase, 'PostgreSQL catalog', postgresFixture);

describe('reading a legacy key', () => {
  const ws = crypto.randomUUID();

  // @story US-STO-13
  it('[US-STO-13][unit][cli] only a file of a workspace under the prefix becomes a catalog path', () => {
    expect(parseLegacyKey(PREFIX, `${PREFIX}/${ws}/a/b.txt`)).toEqual({
      workspaceId: ws,
      path: 'a/b.txt',
    });
    expect(parseLegacyKey(PREFIX, `${PREFIX}/not-a-workspace/b.txt`)).toBeNull();
    expect(parseLegacyKey(PREFIX, `${PREFIX}/${ws}`)).toBeNull();
    expect(parseLegacyKey(PREFIX, `${PREFIX}/${ws}/`)).toBeNull();
    expect(parseLegacyKey(PREFIX, `skills/workspaces/${ws}/b.txt`)).toBeNull();
    expect(parseLegacyKey(PREFIX, `${PREFIX}/${ws}/x/.agent-workspace-empty-folder`)).toBeNull();
  });

  // @story US-STO-13
  it('[US-STO-13][unit][cli] a path no route could name is not a catalog path', () => {
    for (const path of ['%aside/x', 'a/../b', 'a//b', 'a/', './a']) {
      expect(parseLegacyKey(PREFIX, `${PREFIX}/${ws}/${path}`)).toBeNull();
    }
  });
});
