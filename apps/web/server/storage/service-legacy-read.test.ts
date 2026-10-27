import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  streamToBytes,
  type ObjectStream,
} from '@agent-workspace/core/storage';

import { createStorageService, type StorageContext } from './service';
import type { CatalogPort } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[storage/service-legacy-read.test.ts] the PostgreSQL catalog suite was SKIPPED — ' +
      'TEST_DATABASE_URL is not set, so open was NOT exercised against the database.',
  );
}

interface Fixture {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
  readonly catalog: CatalogPort;
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const textOf = async (stream: ObjectStream | null): Promise<string | null> =>
  stream === null ? null : new TextDecoder().decode(await streamToBytes(stream.body));

function memoryFixture(): Promise<Fixture> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    workspaceId,
    principalId: crypto.randomUUID(),
    userId: null,
    catalog: createInMemoryCatalog().forWorkspace(workspaceId),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  if (hasDatabase) isolated = await createIsolatedTestDatabase('aw_storage_legacy_read');
}, 180_000);

afterAll(async () => isolated?.close());

async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'storage' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('catalog scope did not resolve');
  return {
    workspaceId,
    principalId,
    userId,
    catalog: createDatabaseResourceCatalogRepositoryProvider(db).forScope(scope),
  };
}

function defineSuite(enabled: boolean, name: string, setup: () => Promise<Fixture>) {
  (enabled ? describe : describe.skip)(`open and remove across both namings on the ${name}`, () => {
    async function harness() {
      const f = await setup();
      const objects = createInMemoryObjectStore();
      const legacy = createInMemoryObjectStoreProvider();
      const log = { info() {}, warn() {}, error() {}, child: () => log };
      const storage = createStorageService({
        catalog: () => Promise.resolve(f.catalog),
        objects,
        legacy: { files: legacy },
        log,
      });
      const ctx: StorageContext = {
        workspaceId: f.workspaceId,
        principalId: f.principalId,
        userId: f.userId,
      };
      /** A ready row with no object id, whose bytes sit at the path in the old area store. */
      const legacyRow = async (path: string, text: string) => {
        await legacy.forWorkspace(f.workspaceId).write(path, bytesOf(text), {});
        const reserved = await f.catalog.reserve(path, {
          ownerPrincipalId: f.principalId,
          sizeBytes: bytesOf(text).byteLength,
          contentType: null,
        });
        const confirmed = await f.catalog.confirm(reserved.row, {
          sizeBytes: bytesOf(text).byteLength,
          contentType: null,
        });
        if (confirmed === null) throw new Error('the legacy row did not confirm');
        return confirmed.row;
      };
      const newRow = async (path: string, text: string) => {
        const result = await storage.save(ctx, {
          area: 'files',
          path,
          maxBytes: 1024,
          replace: true,
          body: bytesToStream(bytesOf(text)),
        });
        if (!result.ok) throw new Error(`save refused: ${result.code}`);
        return result.row;
      };
      return { f, ctx, storage, legacy, objects, log, legacyRow, newRow };
    }

    // @story US-STO-05
    it('[US-STO-05][unit][sdk] open reads old and new naming', async () => {
      const { ctx, storage, legacyRow, newRow } = await harness();
      const old = await legacyRow('old/report.txt', 'old bytes');
      const fresh = await newRow('new/report.txt', 'new bytes');

      expect(old.objectId ?? null).toBeNull();
      expect(fresh.objectId ?? null).not.toBeNull();
      await expect(textOf(await storage.open(ctx, old))).resolves.toBe('old bytes');
      await expect(textOf(await storage.open(ctx, fresh))).resolves.toBe('new bytes');
      await expect(textOf(await storage.open(ctx, old, { start: 1, end: 3 }))).resolves.toBe('ld ');
      await expect(textOf(await storage.open(ctx, fresh, { start: 4 }))).resolves.toBe('bytes');
    });

    // @story US-STO-05
    it('[US-STO-05][unit][sdk] open answers null for a missing object, an unconfigured area and another workspace', async () => {
      const { ctx, storage, legacy, objects, log, legacyRow, newRow } = await harness();
      const old = await legacyRow('old.txt', 'old');
      const fresh = await newRow('new.txt', 'new');
      const bare = createStorageService({
        catalog: () => Promise.reject(new Error('no catalog call expected')),
        objects,
        log,
      });

      await expect(bare.open(ctx, old)).resolves.toBeNull();
      await expect(
        storage.open({ ...ctx, workspaceId: crypto.randomUUID() }, old),
      ).resolves.toBeNull();
      await legacy.forWorkspace(ctx.workspaceId).delete('old.txt');
      await expect(storage.open(ctx, old)).resolves.toBeNull();
      await objects.delete(`workspaces/${ctx.workspaceId}/files/${fresh.objectId ?? ''}`);
      await expect(storage.open(ctx, fresh)).resolves.toBeNull();
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] remove deletes the object of a legacy row', async () => {
      const { f, ctx, storage, legacy, legacyRow } = await harness();
      await legacyRow('old.txt', 'old');

      await expect(storage.remove(ctx, 'files', 'old.txt', { recursive: false })).resolves.toEqual({
        ok: true,
        removed: 1,
      });

      await expect(legacy.forWorkspace(ctx.workspaceId).get('old.txt')).resolves.toBeNull();
      await expect(f.catalog.deleting()).resolves.toEqual([]);
      await expect(f.catalog.get('old.txt')).resolves.toBeNull();
    });

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] renaming a legacy file keeps its bytes readable', async () => {
      const { f, ctx, storage, legacy, legacyRow } = await harness();
      await legacyRow('old.txt', 'old bytes');

      await expect(storage.rename(ctx, 'files', 'old.txt', 'new.txt')).resolves.toEqual({
        ok: true,
        moved: 1,
      });

      const row = await f.catalog.get('new.txt');
      if (row === null) throw new Error('the renamed row is missing');
      await expect(textOf(await storage.open(ctx, row))).resolves.toBe('old bytes');
      await expect(legacy.forWorkspace(ctx.workspaceId).get('old.txt')).resolves.toBeNull();
    });

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] renaming a folder moves its legacy objects and leaves new ones', async () => {
      const { f, ctx, storage, legacy, objects, legacyRow, newRow } = await harness();
      await legacyRow('docs/a.txt', 'a');
      await legacyRow('docs/deep/b.txt', 'b');
      const fresh = await newRow('docs/c.txt', 'c');
      const freshKey = `workspaces/${ctx.workspaceId}/files/${fresh.objectId ?? ''}`;

      const result = await storage.rename(ctx, 'files', 'docs', 'moved');

      expect(result).toMatchObject({ ok: true });
      for (const [path, text] of [
        ['moved/a.txt', 'a'],
        ['moved/deep/b.txt', 'b'],
        ['moved/c.txt', 'c'],
      ] as const) {
        const row = await f.catalog.get(path);
        if (row === null) throw new Error(`${path} is missing`);
        await expect(textOf(await storage.open(ctx, row))).resolves.toBe(text);
      }
      const store = legacy.forWorkspace(ctx.workspaceId);
      await expect(store.listPrefix('docs')).resolves.toEqual([]);
      await expect(objects.head(freshKey)).resolves.not.toBeNull();
    });

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] a legacy rename refused with path_taken leaves no copies', async () => {
      const { f, ctx, storage, legacy, legacyRow, newRow } = await harness();
      await legacyRow('docs/a.txt', 'a');
      await newRow('moved/a.txt', 'held');

      await expect(storage.rename(ctx, 'files', 'docs', 'moved')).resolves.toEqual({
        ok: false,
        code: 'path_taken',
      });

      const store = legacy.forWorkspace(ctx.workspaceId);
      await expect(store.listPrefix('moved')).resolves.toEqual([]);
      await expect(store.get('docs/a.txt')).resolves.not.toBeNull();
      const row = await f.catalog.get('docs/a.txt');
      if (row === null) throw new Error('the legacy row moved');
      await expect(textOf(await storage.open(ctx, row))).resolves.toBe('a');
    });

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] a rename onto another legacy row is path_taken and keeps its bytes', async () => {
      const { f, ctx, storage, legacy, legacyRow } = await harness();
      await legacyRow('docs/a.txt', 'a');
      await legacyRow('moved/a.txt', 'held');

      await expect(storage.rename(ctx, 'files', 'docs', 'moved')).resolves.toEqual({
        ok: false,
        code: 'path_taken',
      });

      const store = legacy.forWorkspace(ctx.workspaceId);
      await expect(textOf(await store.read('moved/a.txt'))).resolves.toBe('held');
      await expect(textOf(await store.read('docs/a.txt'))).resolves.toBe('a');
      const held = await f.catalog.get('moved/a.txt');
      if (held === null) throw new Error('the destination row is missing');
      await expect(textOf(await storage.open(ctx, held))).resolves.toBe('held');
    });

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] a rename onto a key a deleting legacy row still holds is path_taken', async () => {
      const { f, ctx, storage, legacy, legacyRow } = await harness();
      await legacyRow('old.txt', 'old bytes');
      await legacyRow('gone.txt', 'gone bytes');
      // Marked deleting, with its object left for the cleanup job.
      await f.catalog.remove('gone.txt');

      await expect(storage.rename(ctx, 'files', 'old.txt', 'gone.txt')).resolves.toEqual({
        ok: false,
        code: 'path_taken',
      });

      const store = legacy.forWorkspace(ctx.workspaceId);
      await expect(textOf(await store.read('gone.txt'))).resolves.toBe('gone bytes');
      await expect(textOf(await store.read('old.txt'))).resolves.toBe('old bytes');
      await expect(f.catalog.get('old.txt')).resolves.not.toBeNull();
    });
  });
}

defineSuite(true, 'in-memory catalog', memoryFixture);
defineSuite(hasDatabase, 'PostgreSQL catalog', postgresFixture);
