import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  files,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  createInMemoryObjectStore,
  type ObjectStore,
  type StorageArea,
} from '@agent-workspace/core/storage';

import { createStorageService, type StorageContext } from './service';
import type { CatalogPort } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[storage/service-read.test.ts] the PostgreSQL catalog suite was SKIPPED — TEST_DATABASE_URL is ' +
      'not set, so list, rename and remove were NOT exercised against the database.',
  );
}

interface Fixture {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
  readonly catalog: CatalogPort;
  /** Ready file rows at `paths`, each with an object id, written the way a raw insert does. */
  seed(paths: readonly string[]): Promise<void>;
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const bodyOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** An object store that counts every call that writes, copies or deletes an object. */
function countingStore(): { readonly store: ObjectStore; readonly mutations: () => number } {
  const inner = createInMemoryObjectStore();
  const mutating = new Set<string | symbol>(['write', 'put', 'delete', 'copy']);
  let count = 0;
  const store = new Proxy(inner, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (!mutating.has(property) || typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        count += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { store, mutations: () => count };
}

function memoryFixture(): Promise<Fixture> {
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const catalog = createInMemoryCatalog().forWorkspace(workspaceId);
  return Promise.resolve({
    workspaceId,
    principalId,
    userId: null,
    catalog,
    seed: (paths) => {
      for (const path of paths) {
        catalog.seed({
          path,
          status: 'ready',
          ownerPrincipalId: principalId,
          objectId: crypto.randomUUID(),
        });
      }
      return Promise.resolve();
    },
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  if (hasDatabase) isolated = await createIsolatedTestDatabase('aw_storage_read');
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
    seed: async (paths) => {
      const rows = paths.map((path) => {
        const objectId = crypto.randomUUID();
        return {
          workspaceId,
          path,
          kind: 'file' as const,
          storageKey: `files/${objectId}`,
          objectId,
          ownerPrincipalId: principalId,
          createdBy: userId,
        };
      });
      for (let at = 0; at < rows.length; at += 2000) {
        await db.insert(files).values(rows.slice(at, at + 2000));
      }
    },
  };
}

function defineSuite(enabled: boolean, name: string, setup: () => Promise<Fixture>) {
  (enabled ? describe : describe.skip)(`reads and state changes on the ${name}`, () => {
    async function harness() {
      const f = await setup();
      const counting = countingStore();
      const log = { info() {}, warn() {}, error() {}, child: () => log };
      const storage = createStorageService({
        catalog: () => Promise.resolve(f.catalog),
        objects: counting.store,
        log,
      });
      const ctx: StorageContext = {
        workspaceId: f.workspaceId,
        principalId: f.principalId,
        userId: f.userId,
      };
      const save = async (path: string, text = path, area: StorageArea = 'files') => {
        const result = await storage.save(ctx, {
          area,
          path,
          maxBytes: 1024,
          replace: true,
          body: bodyOf(bytesOf(text)),
        });
        if (!result.ok) throw new Error(`save refused: ${result.code}`);
        return result.row;
      };
      const objectKeys = async (): Promise<string[]> =>
        (await counting.store.listPage('workspaces', { recursive: true })).entries.map(
          (e) => e.key,
        );
      return { f, ctx, storage, save, objectKeys, mutations: counting.mutations };
    }

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] renaming a 10,000-file folder copies no objects', async () => {
      const { f, ctx, storage, mutations } = await harness();
      const paths = Array.from({ length: 10_000 }, (_, i) => `big/f${i}`);
      await f.seed(paths);
      const before = await f.catalog.get('big/f42');

      const result = await storage.rename(ctx, 'files', 'big', 'moved');

      expect(result).toEqual({ ok: true, moved: 10_000 });
      expect(mutations()).toBe(0);
      const after = await f.catalog.get('moved/f42');
      expect(after).toMatchObject({ status: 'ready', objectId: before?.objectId });
      await expect(f.catalog.get('big/f42')).resolves.toBeNull();
    }, 60_000);

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] a rename onto a held path answers path_taken', async () => {
      const { f, ctx, storage, save } = await harness();
      const a = await save('a.txt');
      await save('b.txt');

      await expect(storage.rename(ctx, 'files', 'a.txt', 'b.txt')).resolves.toEqual({
        ok: false,
        code: 'path_taken',
      });

      await expect(f.catalog.get('a.txt')).resolves.toMatchObject({ id: a.id });
    });

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] a folder with a pending upload answers upload_in_progress', async () => {
      const { f, ctx, storage, save } = await harness();
      await save('dir/a.txt');
      await f.catalog.reserve('dir/b.txt', {
        ownerPrincipalId: f.principalId,
        sizeBytes: 0,
        contentType: null,
        objectId: crypto.randomUUID(),
        area: 'files',
      });

      await expect(storage.rename(ctx, 'files', 'dir', 'moved')).resolves.toEqual({
        ok: false,
        code: 'upload_in_progress',
      });

      await expect(f.catalog.get('dir/a.txt')).resolves.not.toBeNull();
    });

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] a file of another area answers not_found and stays put', async () => {
      const { f, ctx, storage, save } = await harness();
      const skill = await save('docs/skill.md', 'skill', 'skills');

      await expect(storage.rename(ctx, 'files', 'docs/skill.md', 'x.md')).resolves.toEqual({
        ok: false,
        code: 'not_found',
      });

      await expect(f.catalog.get('docs/skill.md')).resolves.toMatchObject({ id: skill.id });
    });

    // @story US-STO-03
    it('[US-STO-03][unit][sdk] a missing path answers not_found and an unsafe one invalid_path', async () => {
      const { ctx, storage } = await harness();

      await expect(storage.rename(ctx, 'files', 'nope', 'x')).resolves.toEqual({
        ok: false,
        code: 'not_found',
      });
      await expect(storage.rename(ctx, 'files', 'nope', '../x')).resolves.toEqual({
        ok: false,
        code: 'invalid_path',
      });
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] list shows ready rows only', async () => {
      const { f, ctx, storage, save } = await harness();
      await save('docs/a.txt');
      await save('docs/d.txt');
      await save('docs/removed.txt');
      await f.catalog.remove('docs/removed.txt');
      await save('docs/skill.md', 'skill', 'skills');
      const reserve = (path: string) =>
        f.catalog.reserve(path, {
          ownerPrincipalId: f.principalId,
          sizeBytes: 0,
          contentType: null,
          objectId: crypto.randomUUID(),
          area: 'files',
        });
      await reserve('docs/pending.txt');
      await reserve('docs/a.txt');

      const all = await storage.list(ctx, 'files', 'docs');
      expect(all.rows.map((row) => row.path)).toEqual(['docs/a.txt', 'docs/d.txt']);
      expect(all.rows.every((row) => row.status === 'ready')).toBe(true);
      expect(all.cursor).toBeNull();

      const walked: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await storage.list(ctx, 'files', 'docs', {
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.rows.length).toBeLessThanOrEqual(1);
        walked.push(...page.rows.map((row) => row.path));
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined);
      expect(walked).toEqual(['docs/a.txt', 'docs/d.txt']);

      await expect(storage.get(ctx, 'files', 'docs/a.txt')).resolves.toMatchObject({
        status: 'ready',
      });
      await expect(storage.get(ctx, 'files', 'docs/pending.txt')).resolves.toBeNull();
      await expect(storage.get(ctx, 'files', 'docs/removed.txt')).resolves.toBeNull();
      await expect(storage.get(ctx, 'files', 'docs/skill.md')).resolves.toBeNull();
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] remove deletes the object', async () => {
      const { f, ctx, storage, save, objectKeys } = await harness();
      await save('a.txt');
      await save('keep.txt');

      await expect(storage.remove(ctx, 'files', 'a.txt', { recursive: false })).resolves.toEqual({
        ok: true,
        removed: 1,
        files: ['a.txt'],
      });

      await expect(f.catalog.get('a.txt')).resolves.toBeNull();
      await expect(f.catalog.deleting()).resolves.toEqual([]);
      await expect(objectKeys()).resolves.toHaveLength(1);
      await expect(f.catalog.get('keep.txt')).resolves.not.toBeNull();
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] a folder without recursive answers not_empty and changes nothing', async () => {
      const { f, ctx, storage, save, objectKeys } = await harness();
      await save('dir/a.txt');

      await expect(storage.remove(ctx, 'files', 'dir', { recursive: false })).resolves.toEqual({
        ok: false,
        code: 'not_empty',
      });

      await expect(f.catalog.get('dir/a.txt')).resolves.not.toBeNull();
      await expect(objectKeys()).resolves.toHaveLength(1);
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] a recursive remove deletes every row and object under the folder', async () => {
      const { f, ctx, storage, save, objectKeys } = await harness();
      await save('dir/a.txt');
      await save('dir/sub/b.txt');
      await save('other.txt');

      await expect(storage.remove(ctx, 'files', 'dir', { recursive: true })).resolves.toEqual({
        ok: true,
        removed: 2,
        files: ['dir/a.txt', 'dir/sub/b.txt'],
      });

      await expect(f.catalog.list('dir')).resolves.toMatchObject({ rows: [] });
      await expect(f.catalog.deleting()).resolves.toEqual([]);
      await expect(objectKeys()).resolves.toHaveLength(1);
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] a missing path answers not_found', async () => {
      const { ctx, storage } = await harness();

      await expect(storage.remove(ctx, 'files', 'nope', { recursive: true })).resolves.toEqual({
        ok: false,
        code: 'not_found',
      });
    });
  });
}

defineSuite(true, 'in-memory catalog', memoryFixture);
defineSuite(hasDatabase, 'PostgreSQL catalog', postgresFixture);

describe('remove on the in-memory catalog with a failing object delete', () => {
  // @story US-STO-04
  it('[US-STO-04][unit][sdk] a failed object delete leaves a deleting row for the cleanup job', async () => {
    const workspaceId = crypto.randomUUID();
    const catalog = createInMemoryCatalog().forWorkspace(workspaceId);
    const inner = createInMemoryObjectStore();
    const objects: ObjectStore = {
      ...inner,
      delete: () => Promise.reject(new Error('object store down')),
    };
    const log = { info() {}, warn() {}, error() {}, child: () => log };
    const storage = createStorageService({ catalog: () => Promise.resolve(catalog), objects, log });
    const ctx: StorageContext = { workspaceId, principalId: crypto.randomUUID(), userId: null };
    await storage.save(ctx, {
      area: 'files',
      path: 'a.txt',
      maxBytes: 1024,
      replace: true,
      body: bodyOf(bytesOf('a')),
    });

    await expect(storage.remove(ctx, 'files', 'a.txt', { recursive: false })).resolves.toEqual({
      ok: true,
      removed: 1,
      files: ['a.txt'],
    });

    await expect(catalog.get('a.txt')).resolves.toBeNull();
    await expect(catalog.deleting()).resolves.toHaveLength(1);
  });
});
