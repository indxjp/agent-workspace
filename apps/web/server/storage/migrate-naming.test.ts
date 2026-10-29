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
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  newObjectId,
  storageObjectName,
  streamToBytes,
  type ObjectStoreProvider,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { runCleanupPass } from './cleanup';
import { runCopyStage, type CopyDependencies } from './migrate-naming';
import { createStorageService } from './service';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[storage/migrate-naming.test.ts] the PostgreSQL catalog suite was SKIPPED — ' +
      'TEST_DATABASE_URL is not set, so the copy stage was NOT exercised against the database.',
  );
}

interface Fixture {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly catalog: ResourceCatalogRepository;
}

function memoryFixture(): Promise<Fixture> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    workspaceId,
    principalId: crypto.randomUUID(),
    catalog: createInMemoryCatalog().forWorkspace(workspaceId),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  if (hasDatabase) isolated = await createIsolatedTestDatabase('aw_storage_migrate_copy');
}, 180_000);

afterAll(async () => isolated?.close());

async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'copy' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
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
    catalog: createDatabaseResourceCatalogRepositoryProvider(db).forScope(scope),
  };
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const quietLog = (): Logger => {
  const log: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log;
};

/** An old store whose reads run `before` first (a user acting mid-copy) or rewrite the body. */
function hooked(
  base: ObjectStoreProvider,
  hooks: {
    readonly before?: () => Promise<unknown>;
    readonly body?: (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
  },
): ObjectStoreProvider {
  return {
    forWorkspace: (workspaceId) => {
      const store = base.forWorkspace(workspaceId);
      return {
        ...store,
        read: async (key, options) => {
          await hooks.before?.();
          const found = await store.read(key, options);
          return found === null || hooks.body === undefined
            ? found
            : { ...found, body: hooks.body(found.body) };
        },
      };
    },
  };
}

function defineSuite(enabled: boolean, name: string, setup: () => Promise<Fixture>) {
  (enabled ? describe : describe.skip)(
    `copying legacy rows to the new naming on the ${name}`,
    () => {
      async function harness() {
        const f = await setup();
        const objects = createInMemoryObjectStore();
        const legacy = createInMemoryObjectStoreProvider();
        const lines: { message: string; fields: unknown }[] = [];
        const log: Logger = {
          info: (message, fields) => lines.push({ message, fields }),
          warn: (message, fields) => lines.push({ message, fields }),
          error: (message, fields) => lines.push({ message, fields }),
          child: () => log,
        };
        /** A file the old layout wrote: bytes at the path in the area store, and a legacy row. */
        const legacyFile = async (path: string, text: string) => {
          await legacy
            .forWorkspace(f.workspaceId)
            .write(path, bytesOf(text), { contentType: null });
          return f.catalog.putFile({
            path,
            kind: 'file',
            storageKey: path,
            sizeBytes: bytesOf(text).byteLength,
            contentType: null,
            ownerPrincipalId: f.principalId,
          });
        };
        const run = (
          mode: 'copy' | 'copy-dry-run' = 'copy',
          overrides: Partial<CopyDependencies> = {},
        ) =>
          runCopyStage({
            objects,
            legacy: { files: legacy },
            catalog: () => Promise.resolve(f.catalog),
            workspaceIds: () => Promise.resolve([f.workspaceId]),
            mode,
            log,
            ...overrides,
          });
        return { f, objects, legacy, legacyFile, run, lines };
      }

      // @story US-STO-13
      it('[US-STO-13][unit][cli] migration copies, verifies and switches', async () => {
        const { f, objects, legacyFile, run } = await harness();
        const texts: Record<string, string> = {
          'a.txt': 'alpha',
          'deep/b.txt': 'bravo bravo',
          'deep/er/c.bin': 'charlie',
        };
        for (const [path, text] of Object.entries(texts)) await legacyFile(path, text);

        await run();

        const rows = (await f.catalog.list('')).rows.filter((row) => row.kind === 'file');
        expect(rows).toHaveLength(3);
        for (const row of rows) {
          // No old-style row remains, and the bytes at the new name are the ones that were uploaded.
          expect(row.objectId).toEqual(expect.any(String));
          expect(row.sha256).toMatch(/^[0-9a-f]{64}$/u);
          const stream = await objects.read(
            storageObjectName(f.workspaceId, 'files', row.objectId ?? ''),
          );
          expect(stream).not.toBeNull();
          const text = new TextDecoder().decode(await streamToBytes((stream ?? never()).body));
          expect(text).toBe(texts[row.path]);
        }
      });

      // @story US-STO-13
      it('[US-STO-13][api][cli] dry run reports counts', async () => {
        const { f, objects, legacyFile, run } = await harness();
        await legacyFile('a.txt', 'alpha');
        await legacyFile('deep/b.txt', 'bravo');

        const report = await run('copy-dry-run');

        expect(report).toMatchObject({ mode: 'copy-dry-run', areas: { files: { found: 2 } } });
        expect(report.areas['files']?.switched).toBe(0);
        // Nothing was written and no row changed.
        await expect(objects.listPage('', { recursive: true })).resolves.toMatchObject({
          entries: [],
        });
        const rows = (await f.catalog.list('')).rows.filter((row) => row.kind === 'file');
        expect(rows.map((row) => row.objectId ?? null)).toEqual([null, null]);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] a rerun finds nothing left and a stopped run resumes', async () => {
        const { f, legacyFile, run } = await harness();
        await legacyFile('a.txt', 'alpha');
        await legacyFile('b.txt', 'bravo');
        await expect(run()).resolves.toMatchObject({ areas: { files: { switched: 2 } } });

        await legacyFile('c.txt', 'charlie');
        const second = await run();

        expect(second.areas['files']).toMatchObject({ found: 1, switched: 1 });
        const rows = (await f.catalog.list('')).rows.filter((row) => row.kind === 'file');
        expect(rows.every((row) => row.objectId !== null)).toBe(true);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] reads work before and after the switch', async () => {
        const { f, objects, legacy, legacyFile, run } = await harness();
        await legacyFile('a.txt', 'alpha');
        const service = createStorageService({
          catalog: () => Promise.resolve(f.catalog),
          objects,
          legacy: { files: legacy },
          log: quietLog(),
        });
        const ctx = { workspaceId: f.workspaceId, principalId: f.principalId, userId: null };
        const readA = async () => {
          const row = await service.get(ctx, 'files', 'a.txt');
          const stream = await service.open(ctx, row ?? never());
          return new TextDecoder().decode(await streamToBytes((stream ?? never()).body));
        };

        await expect(readA()).resolves.toBe('alpha');
        await run();
        await expect(readA()).resolves.toBe('alpha');
        expect((await service.get(ctx, 'files', 'a.txt'))?.objectId).toEqual(expect.any(String));
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] a crash between copy and switch loses nothing and leaves one orphan', async () => {
        const { f, objects, legacyFile, run } = await harness();
        await legacyFile('a.txt', 'alpha');
        // The process dies after the copy is written and before the row is switched.
        const first = await run('copy', {
          catalog: () =>
            Promise.resolve({
              list: (folder, page) => f.catalog.list(folder, page),
              switchObject: () => Promise.reject(new Error('process died')),
            }),
        });
        expect(first.areas['files']).toMatchObject({ found: 1, failed: 1, switched: 0 });
        expect(await f.catalog.get('a.txt')).toMatchObject({ status: 'ready', objectId: null });
        expect((await objects.listPage('', { recursive: true })).entries).toHaveLength(1);

        await run();

        const row = await f.catalog.get('a.txt');
        expect(row?.objectId).toEqual(expect.any(String));
        const all = await objects.listPage('', { recursive: true });
        // One copy the row names and one orphan nothing names.
        expect(all.entries).toHaveLength(2);
        const live = storageObjectName(f.workspaceId, 'files', row?.objectId ?? '');
        const orphan = all.entries.find((entry) => entry.key !== live);
        expect(orphan).toBeDefined();

        // The cleanup job reports the orphan and, once it is old enough, removes only it.
        const cleanup = (mode: 'report' | 'delete') =>
          runCleanupPass({
            objects,
            legacy: null,
            catalogs: () => Promise.resolve(f.catalog),
            sessionState: () => Promise.resolve({ referencedObjectIds: () => Promise.resolve([]) }),
            workspaceIds: () => Promise.resolve([f.workspaceId]),
            now: () => new Date(Date.now() + 30 * 24 * 3600 * 1000),
            mode,
            log: quietLog(),
          });
        await expect(cleanup('report')).resolves.toMatchObject({ orphans: 1, deleted: 0 });
        await expect(cleanup('delete')).resolves.toMatchObject({ orphans: 1, deleted: 1 });
        await expect(objects.head(live)).resolves.not.toBeNull();
        await expect(objects.head(orphan?.key ?? '')).resolves.toBeNull();
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] a failed write leaves no copy and no change', async () => {
        const { f, objects, legacy, legacyFile, run } = await harness();
        await legacyFile('a.txt', 'alpha');
        const broken = hooked(legacy, {
          body: (stream) =>
            stream.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  controller.enqueue(chunk);
                  controller.error(new Error('connection lost'));
                },
              }),
            ),
        });

        const report = await run('copy', { legacy: { files: broken } });

        expect(report.areas['files']).toMatchObject({ failed: 1, switched: 0 });
        expect(await f.catalog.get('a.txt')).toMatchObject({ objectId: null });
        expect((await objects.listPage('', { recursive: true })).entries).toEqual([]);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] a copy of the wrong size is deleted and the row is left', async () => {
        const { f, objects, legacy, legacyFile, run } = await harness();
        await legacyFile('a.txt', 'alpha');
        const truncated = hooked(legacy, {
          body: (stream) =>
            stream.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  controller.enqueue(chunk.subarray(0, chunk.byteLength - 1));
                },
              }),
            ),
        });

        const report = await run('copy', { legacy: { files: truncated } });

        expect(report.areas['files']).toMatchObject({ mismatched: 1, switched: 0 });
        expect(await f.catalog.get('a.txt')).toMatchObject({ objectId: null });
        expect((await objects.listPage('', { recursive: true })).entries).toEqual([]);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] an old object that is gone leaves its row as it is', async () => {
        const { f, legacy, legacyFile, run } = await harness();
        await legacyFile('a.txt', 'alpha');
        await legacy.forWorkspace(f.workspaceId).delete('a.txt');

        const report = await run();

        expect(report.areas['files']).toMatchObject({ found: 1, missing: 1, switched: 0 });
        expect(await f.catalog.get('a.txt')).toMatchObject({ objectId: null });
      });

      describe('a user changing the file while the job copies it', () => {
        // @story US-STO-13
        it('[US-STO-13][unit][cli] a renamed file is not switched and its copy is deleted', async () => {
          const { f, objects, legacy, legacyFile, run } = await harness();
          await legacyFile('a.txt', 'alpha');
          const renaming = hooked(legacy, { before: () => f.catalog.rename('a.txt', 'moved.txt') });

          const report = await run('copy', { legacy: { files: renaming } });

          expect(report.areas['files']).toMatchObject({ raced: 1, switched: 0 });
          expect(await f.catalog.get('a.txt')).toBeNull();
          expect(await f.catalog.get('moved.txt')).toMatchObject({ objectId: null });
          expect((await objects.listPage('', { recursive: true })).entries).toEqual([]);
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] a deleted file is not resurrected', async () => {
          const { f, objects, legacy, legacyFile, run } = await harness();
          await legacyFile('a.txt', 'alpha');
          const removing = hooked(legacy, { before: () => f.catalog.remove('a.txt') });

          const report = await run('copy', { legacy: { files: removing } });

          expect(report.areas['files']).toMatchObject({ raced: 1, switched: 0 });
          expect(await f.catalog.get('a.txt')).toBeNull();
          const doomed = await f.catalog.deleting();
          expect(doomed.map((row) => row.objectId ?? null)).toEqual([null]);
          expect((await objects.listPage('', { recursive: true })).entries).toEqual([]);
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] a file overwritten by a user keeps the new content', async () => {
          const { f, objects, legacy, legacyFile, run } = await harness();
          await legacyFile('a.txt', 'alpha');
          const userObjectId = newObjectId();
          const userObject = storageObjectName(f.workspaceId, 'files', userObjectId);
          const overwriting = hooked(legacy, {
            before: async () => {
              const reserved = await f.catalog.reserve('a.txt', {
                ownerPrincipalId: f.principalId,
                sizeBytes: 3,
                contentType: null,
                objectId: userObjectId,
              });
              await objects.write(userObject, bytesOf('new'), { contentType: null });
              await f.catalog.confirm(reserved.row, { sizeBytes: 3, contentType: null });
            },
          });

          const report = await run('copy', { legacy: { files: overwriting } });

          expect(report.areas['files']).toMatchObject({ raced: 1, switched: 0 });
          expect((await f.catalog.get('a.txt'))?.objectId).toBe(userObjectId);
          const stream = await objects.read(userObject);
          expect(new TextDecoder().decode(await streamToBytes((stream ?? never()).body))).toBe(
            'new',
          );
          // Only the user's object is left; the copy of the old bytes is gone.
          const left = await objects.listPage('', { recursive: true });
          expect(left.entries.map((entry) => entry.key)).toEqual([userObject]);
        });
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] skills rows are copied from the skills store into the skills area', async () => {
        const { f, objects, legacy, run } = await harness();
        const skills = createInMemoryObjectStoreProvider();
        await skills
          .forWorkspace(f.workspaceId)
          .write('s/SKILL.md', bytesOf('# skill'), { contentType: null });
        const reserved = await f.catalog.reserve('s/SKILL.md', {
          ownerPrincipalId: f.principalId,
          sizeBytes: 7,
          contentType: null,
          area: 'skills',
        });
        await f.catalog.confirm(reserved.row, { sizeBytes: 7, contentType: null });

        const report = await run('copy', { legacy: { files: legacy, skills } });

        expect(report.areas['skills']).toMatchObject({ found: 1, switched: 1 });
        const row = await f.catalog.get('s/SKILL.md');
        const stream = await objects.read(
          storageObjectName(f.workspaceId, 'skills', row?.objectId ?? ''),
        );
        expect(new TextDecoder().decode(await streamToBytes((stream ?? never()).body))).toBe(
          '# skill',
        );
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] a row whose area has no old store is counted and left', async () => {
        const { f, run } = await harness();
        const reserved = await f.catalog.reserve('s/SKILL.md', {
          ownerPrincipalId: f.principalId,
          sizeBytes: 7,
          contentType: null,
          area: 'skills',
        });
        await f.catalog.confirm(reserved.row, { sizeBytes: 7, contentType: null });

        const report = await run();

        expect(report.areas['skills']).toMatchObject({ found: 1, noStore: 1, switched: 0 });
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] progress is one JSON line per 100 rows and one at the end', async () => {
        const { legacyFile, run, lines } = await harness();
        for (let index = 0; index < 205; index += 1) await legacyFile(`f/${index}.txt`, 'x');

        await run();

        const progress = lines
          .filter((line) => line.message.startsWith('{'))
          .map(
            (line) =>
              JSON.parse(line.message) as {
                done: boolean;
                areas: { files: { found: number } };
              },
          );
        expect(progress.map((line) => line.done)).toEqual([false, false, true]);
        expect(progress.map((line) => line.areas.files.found)).toEqual([100, 200, 205]);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] a workspace that is gone does not stop the others', async () => {
        const { f, legacyFile, run, lines } = await harness();
        await legacyFile('a.txt', 'alpha');

        const report = await run('copy', {
          workspaceIds: () => Promise.resolve([crypto.randomUUID(), f.workspaceId]),
          catalog: (id) =>
            id === f.workspaceId
              ? Promise.resolve(f.catalog)
              : Promise.reject(new Error('the workspace is gone')),
        });

        expect(report.areas['files']).toMatchObject({ switched: 1 });
        expect(lines.some((line) => line.message.includes('failed for a workspace'))).toBe(true);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] removing a switched file also removes its old object', async () => {
        const { f, objects, legacy, legacyFile, run } = await harness();
        await legacyFile('a.txt', 'alpha');
        await run();
        const service = createStorageService({
          catalog: () => Promise.resolve(f.catalog),
          objects,
          legacy: { files: legacy },
          log: quietLog(),
        });
        const ctx = { workspaceId: f.workspaceId, principalId: f.principalId, userId: null };

        await service.remove(ctx, 'files', 'a.txt', { recursive: false });

        // Left behind it would be a row-less old file, and the adopt stage would bring it back.
        await expect(legacy.forWorkspace(f.workspaceId).head('a.txt')).resolves.toBeNull();
        expect((await objects.listPage('', { recursive: true })).entries).toEqual([]);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] overwriting a switched file removes its old object so adopt cannot bring it back', async () => {
        const { f, objects, legacy, legacyFile, run } = await harness();
        await legacyFile('a.txt', 'alpha');
        await run();
        const service = createStorageService({
          catalog: () => Promise.resolve(f.catalog),
          objects,
          legacy: { files: legacy },
          log: quietLog(),
        });
        const ctx = { workspaceId: f.workspaceId, principalId: f.principalId, userId: null };

        const saved = await service.save(ctx, {
          area: 'files',
          path: 'a.txt',
          body: new Blob(['beta']).stream(),
          maxBytes: 100,
          replace: true,
        });

        expect(saved.ok).toBe(true);
        // A row-less old object is what the adopt stage adopts; none may be left at the old key.
        await expect(legacy.forWorkspace(f.workspaceId).head('a.txt')).resolves.toBeNull();
        const rows = (await f.catalog.list('')).rows.filter((row) => row.kind === 'file');
        expect(rows).toHaveLength(1);
        expect((await objects.listPage('', { recursive: true })).entries).toHaveLength(1);
      });
    },
  );
}

function never(): never {
  throw new Error('unreachable');
}

defineSuite(true, 'in-memory catalog', memoryFixture);
defineSuite(hasDatabase, 'PostgreSQL catalog', postgresFixture);
