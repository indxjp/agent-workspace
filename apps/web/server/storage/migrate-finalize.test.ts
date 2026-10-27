import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseStorageMigrationRunRepository,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createInMemoryStorageMigrationRuns,
  createIsolatedTestDatabase,
  memberships,
  storageMigrationRuns,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  storageObjectName,
  type ObjectStoreProviderV2,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import {
  deleteLegacy,
  runFinalizeStage,
  verifyAll,
  type FinalizeDependencies,
} from './migrate-finalize';
import { runCopyStage } from './migrate-naming';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[storage/migrate-finalize.test.ts] the PostgreSQL catalog suite was SKIPPED — ' +
      'TEST_DATABASE_URL is not set, so the finalize stage was NOT exercised against the database.',
  );
}

interface Fixture {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly catalog: ResourceCatalogRepository;
  readonly runs: FinalizeDependencies['runs'];
}

function memoryFixture(): Promise<Fixture> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    workspaceId,
    principalId: crypto.randomUUID(),
    catalog: createInMemoryCatalog().forWorkspace(workspaceId),
    runs: createInMemoryStorageMigrationRuns(),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  if (hasDatabase) isolated = await createIsolatedTestDatabase('aw_storage_migrate_finalize');
}, 180_000);

afterAll(async () => isolated?.close());

async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  // The pass log is deployment-wide: each test starts with none.
  await db.delete(storageMigrationRuns);
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'final' });
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
    runs: createDatabaseStorageMigrationRunRepository(db),
  };
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const stopped = () => new Error('process died');

function defineSuite(enabled: boolean, name: string, setup: () => Promise<Fixture>) {
  (enabled ? describe : describe.skip)(
    `finalizing the move off the old naming on the ${name}`,
    () => {
      async function harness() {
        const f = await setup();
        const objects = createInMemoryObjectStore();
        const legacy = createInMemoryObjectStoreProvider();
        const skills = createInMemoryObjectStoreProvider();
        const lines: string[] = [];
        const log: Logger = {
          info: (message) => lines.push(message),
          warn: (message) => lines.push(message),
          error: (message) => lines.push(message),
          child: () => log,
        };
        const keysOf = async (provider: ObjectStoreProviderV2) =>
          (await provider.forWorkspace(f.workspaceId).listPage('', { recursive: true })).entries
            .map((entry) => entry.key)
            .sort();
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
        const copy = () =>
          runCopyStage({
            objects,
            legacy: { files: legacy },
            catalog: () => Promise.resolve(f.catalog),
            workspaceIds: () => Promise.resolve([f.workspaceId]),
            mode: 'copy',
            log,
          });
        const deps = (overrides: Partial<FinalizeDependencies> = {}): FinalizeDependencies => ({
          objects,
          legacy: { files: legacy, skills },
          catalog: () => Promise.resolve(f.catalog),
          workspaceIds: () => Promise.resolve([f.workspaceId]),
          runs: f.runs,
          log,
          ...overrides,
        });
        const finalize = (overrides: Partial<FinalizeDependencies> = {}) =>
          runFinalizeStage(deps(overrides));
        return { f, objects, legacy, skills, lines, keysOf, legacyFile, copy, deps, finalize };
      }

      // @story US-STO-13
      it('[US-STO-13][unit][cli] a single checksum mismatch blocks every legacy delete', async () => {
        const { f, objects, legacy, legacyFile, copy, finalize } = await harness();
        await legacyFile('a.txt', 'alpha');
        await legacyFile('b.txt', 'bravo');
        await copy();
        // One new object is damaged in place: same size, other bytes.
        const damaged = (await f.catalog.get('b.txt'))?.objectId ?? '';
        await objects.write(storageObjectName(f.workspaceId, 'files', damaged), bytesOf('bravX'), {
          contentType: null,
        });

        const report = await finalize();

        expect(report.verify).toMatchObject({ mismatches: 1 });
        expect(report.outcome).toBe('blocked');
        // Nothing was deleted, not even the old copy of the file that checked out.
        const old = legacy.forWorkspace(f.workspaceId);
        await expect(old.head('a.txt')).resolves.not.toBeNull();
        await expect(old.head('b.txt')).resolves.not.toBeNull();
        await expect(f.runs.latest()).resolves.toMatchObject({ mismatches: 1 });
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] an object that is missing under the new name blocks every delete', async () => {
        const { f, objects, legacy, keysOf, legacyFile, copy, finalize } = await harness();
        await legacyFile('a.txt', 'alpha');
        await copy();
        const row = await f.catalog.get('a.txt');
        await objects.delete(storageObjectName(f.workspaceId, 'files', row?.objectId ?? ''));

        await expect(finalize()).resolves.toMatchObject({ outcome: 'blocked' });
        expect(await keysOf(legacy)).toEqual(['a.txt']);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] deletes nothing while any object_id IS NULL row exists', async () => {
        const { f, legacy, keysOf, legacyFile, copy, finalize } = await harness();
        await legacyFile('a.txt', 'alpha');
        await copy();
        // A second file arrives in the old naming after the copy stage ran.
        await legacyFile('late.txt', 'late');

        const report = await finalize();

        expect(report).toMatchObject({
          outcome: 'blocked',
          verify: { legacyRows: 1, mismatches: 0 },
        });
        expect(await keysOf(legacy)).toEqual(['a.txt', 'late.txt']);
        await expect(f.runs.latest()).resolves.toMatchObject({ legacyRows: 1 });
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] old copies are deleted only after a full check pass', async () => {
        const { f, objects, legacy, keysOf, legacyFile, copy, finalize } = await harness();
        for (const [path, text] of [
          ['a.txt', 'alpha'],
          ['deep/b.txt', 'bravo'],
          ['deep/er/c.bin', 'charlie'],
        ] as const) {
          await legacyFile(path, text);
        }
        await copy();
        expect(await keysOf(legacy)).toHaveLength(3);

        const report = await finalize();

        expect(report).toMatchObject({
          outcome: 'deleted',
          verify: { rowsChecked: 3, legacyRows: 0, mismatches: 0 },
          delete: { refused: null, deleted: 3, unaccounted: 0 },
        });
        await expect(f.runs.latest()).resolves.toMatchObject({
          rowsChecked: 3,
          legacyRows: 0,
          mismatches: 0,
        });
        expect(await keysOf(legacy)).toEqual([]);
        // Every file is still there under the new naming.
        for (const row of (await f.catalog.list('')).rows.filter((r) => r.kind === 'file')) {
          await expect(
            objects.head(storageObjectName(f.workspaceId, 'files', row.objectId ?? '')),
          ).resolves.not.toBeNull();
        }
        // A second run has nothing left to do.
        await expect(finalize()).resolves.toMatchObject({
          outcome: 'deleted',
          delete: { deleted: 0, unaccounted: 0 },
        });
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] a delete needs a recorded clean pass', async () => {
        const { f, legacy, keysOf, legacyFile, copy, deps } = await harness();
        await legacyFile('a.txt', 'alpha');
        await copy();

        await expect(deleteLegacy(deps())).resolves.toMatchObject({ refused: 'no-pass' });
        await f.runs.record({ rowsChecked: 1, legacyRows: 0, mismatches: 1 });
        await expect(deleteLegacy(deps())).resolves.toMatchObject({ refused: 'unclean-pass' });
        expect(await keysOf(legacy)).toEqual(['a.txt']);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] a clean pass gone stale deletes nothing when a legacy row has appeared', async () => {
        const { legacy, keysOf, legacyFile, copy, finalize, deps } = await harness();
        await legacyFile('a.txt', 'alpha');
        await copy();
        // Record a clean pass without deleting (no old store configured), keeping the old copy.
        await expect(finalize({ legacy: {} })).resolves.toMatchObject({ outcome: 'deleted' });
        // Then a row in the old naming appears (an old server, an adopt).
        await legacyFile('b.txt', 'bravo');

        await expect(deleteLegacy(deps())).resolves.toMatchObject({
          refused: 'legacy-rows',
          deleted: 0,
        });
        expect(await keysOf(legacy)).toEqual(['a.txt', 'b.txt']);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] an old object that a row without an object id names is never deleted', async () => {
        const { f, legacy, keysOf, legacyFile, copy, deps, finalize } = await harness();
        await legacyFile('a.txt', 'alpha');
        await copy();
        await expect(finalize({ legacy: {} })).resolves.toMatchObject({ outcome: 'deleted' });
        await legacyFile('b.txt', 'bravo');
        // The count says zero (it ran before the row appeared); the per-object check still holds.
        vi.spyOn(f.catalog, 'countLegacyFiles').mockResolvedValue(0);

        const result = await deleteLegacy(deps());

        expect(result).toMatchObject({ refused: null, deleted: 1, unaccounted: 1 });
        expect(await keysOf(legacy)).toEqual(['b.txt']);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] an old object no row accounts for is kept and reported', async () => {
        const { f, legacy, keysOf, legacyFile, copy, finalize, lines } = await harness();
        await legacyFile('a.txt', 'alpha');
        await copy();
        // Written by the old layout, never adopted: no row of any kind.
        await legacy
          .forWorkspace(f.workspaceId)
          .write('orphan/never-adopted.txt', bytesOf('x'), { contentType: null });

        const report = await finalize();

        expect(report.outcome).toBe('deleted');
        expect(report.delete).toMatchObject({
          deleted: 1,
          unaccounted: 1,
          unaccountedSample: [`files:${f.workspaceId}:orphan/never-adopted.txt`],
        });
        expect(await keysOf(legacy)).toEqual(['orphan/never-adopted.txt']);
        expect(lines.some((line) => line.includes('never-adopted.txt'))).toBe(true);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] the old twin of a file renamed during the copy is deleted', async () => {
        const { f, legacy, keysOf, legacyFile, copy, finalize } = await harness();
        await legacyFile('a.txt', 'alpha');
        await copy();
        // A rename that raced the copy stage: the row moved and the old object moved with it.
        await f.catalog.rename('a.txt', 'moved.txt');
        const old = legacy.forWorkspace(f.workspaceId);
        await old.copyObject('a.txt', 'moved.txt');
        await old.delete('a.txt');
        expect(await keysOf(legacy)).toEqual(['moved.txt']);

        const report = await finalize();

        expect(report.delete).toMatchObject({ deleted: 1, unaccounted: 0 });
        expect(await keysOf(legacy)).toEqual([]);
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] an empty-folder marker goes only when its folder is a catalog row', async () => {
        const { f, legacy, keysOf, copy, finalize } = await harness();
        const old = legacy.forWorkspace(f.workspaceId);
        await f.catalog.createFolder('kept', { ownerPrincipalId: f.principalId });
        await old.write('kept/.agent-workspace-empty-folder', bytesOf(''), { contentType: null });
        await old.write('nowhere/.agent-workspace-empty-folder', bytesOf(''), {
          contentType: null,
        });
        await copy();

        const report = await finalize();

        expect(report.delete).toMatchObject({ deleted: 1, unaccounted: 1 });
        expect(await keysOf(legacy)).toEqual(['nowhere/.agent-workspace-empty-folder']);
      });

      describe('skill marker objects', () => {
        const put = (
          skills: ObjectStoreProviderV2,
          workspaceId: string,
          key: string,
          value: unknown,
        ) =>
          skills
            .forWorkspace(workspaceId)
            .write(key, bytesOf(JSON.stringify(value)), { contentType: 'application/json' });
        const addSkill = (f: Fixture, skillName: string) =>
          f.catalog.putSkill({
            name: skillName,
            skillMd: `# ${skillName}`,
            enabled: true,
            ownerPrincipalId: f.principalId,
          });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] markers are copied to their columns, then deleted', async () => {
          const { f, skills, keysOf, finalize } = await harness();
          await addSkill(f, 'alpha');
          const meta = { name: 'alpha', enabled: true, createdAt: 'a', updatedAt: 'b' };
          await put(skills, f.workspaceId, 'skill-meta/alpha.json', meta);
          await put(skills, f.workspaceId, 'skill-builtin/alpha.json', { digest: 'abc123' });
          await put(skills, f.workspaceId, 'skill-deletes/alpha.json', {
            ownerPrincipalId: f.principalId,
            revisions: [1],
          });

          const report = await finalize();

          expect(report.delete).toMatchObject({ deleted: 3, unaccounted: 0 });
          expect(await keysOf(skills)).toEqual([]);
          const [row] = await f.catalog.listSkills();
          expect(row).toMatchObject({
            meta,
            builtinDigest: 'abc123',
            pendingDelete: { ownerPrincipalId: f.principalId, revisions: [1] },
          });
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] a marker whose column is already set is deleted without overwriting it', async () => {
          const { f, skills, keysOf, finalize } = await harness();
          await addSkill(f, 'alpha');
          await f.catalog.setSkillMeta('alpha', { name: 'alpha' });
          await put(skills, f.workspaceId, 'skill-meta/alpha.json', { name: 'old' });

          await finalize();

          expect(await keysOf(skills)).toEqual([]);
          expect((await f.catalog.listSkills())[0]?.meta).toEqual({ name: 'alpha' });
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] a marker of a skill with no row is kept while its files remain', async () => {
          const { f, skills, keysOf, finalize } = await harness();
          await put(skills, f.workspaceId, 'skill-meta/live.json', { name: 'live' });
          await skills
            .forWorkspace(f.workspaceId)
            .write('skills/live/SKILL.md', bytesOf('# live'), { contentType: null });
          // This skill is really gone: markers and nothing else.
          await put(skills, f.workspaceId, 'skill-meta/gone.json', { name: 'gone' });
          await put(skills, f.workspaceId, 'skill-deletes/gone.json', {});

          const report = await finalize();

          expect(report.delete).toMatchObject({ deleted: 2, unaccounted: 2 });
          expect(await keysOf(skills)).toEqual(['skill-meta/live.json', 'skills/live/SKILL.md']);
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] the marker of a skill with no row survives a rerun once its files have moved', async () => {
          const { f, skills, objects, keysOf, finalize } = await harness();
          await put(skills, f.workspaceId, 'skill-meta/hidden.json', { name: 'hidden' });
          // The skill's legacy files are gone already: its bytes are catalog rows (current and a
          // revision), the only other record that the skill exists.
          for (const path of ['.skills/hidden/SKILL.md', '.skills/hidden@1/SKILL.md']) {
            const objectId = crypto.randomUUID();
            const bytes = bytesOf('# hidden');
            await objects.write(storageObjectName(f.workspaceId, 'skills', objectId), bytes, {
              contentType: null,
            });
            const reserved = await f.catalog.reserve(path, {
              ownerPrincipalId: f.principalId,
              sizeBytes: bytes.byteLength,
              contentType: null,
              objectId,
              area: 'skills',
            });
            if (reserved.kind !== 'reserved') throw new Error('expected a reserved row');
            await f.catalog.confirm(reserved.row, {
              sizeBytes: bytes.byteLength,
              contentType: null,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            });
          }

          await finalize();
          await finalize();

          expect(await keysOf(skills)).toEqual(['skill-meta/hidden.json']);
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] a marker that cannot be read is kept', async () => {
          const { f, skills, keysOf, finalize } = await harness();
          await addSkill(f, 'alpha');
          await skills
            .forWorkspace(f.workspaceId)
            .write('skill-meta/alpha.json', bytesOf('{not json'), { contentType: null });

          const report = await finalize();

          expect(report.delete).toMatchObject({ deleted: 0, unaccounted: 1 });
          expect(await keysOf(skills)).toEqual(['skill-meta/alpha.json']);
        });
      });

      describe('stopping and starting again', () => {
        // @story US-STO-13
        it('[US-STO-13][unit][cli] a crash while deleting is finished by the next run', async () => {
          const { legacy, keysOf, legacyFile, copy, finalize } = await harness();
          for (const file of ['a.txt', 'b.txt', 'c.txt']) await legacyFile(file, file);
          await copy();
          let deletes = 0;
          const dying: ObjectStoreProviderV2 = {
            forWorkspace: (id) => ({
              ...legacy.forWorkspace(id),
              delete: async (key) => {
                deletes += 1;
                if (deletes === 2) throw stopped();
                await legacy.forWorkspace(id).delete(key);
              },
            }),
          };

          await expect(finalize({ legacy: { files: dying } })).rejects.toThrow('process died');
          expect(await keysOf(legacy)).toEqual(['b.txt', 'c.txt']);

          await expect(finalize()).resolves.toMatchObject({
            outcome: 'deleted',
            delete: { deleted: 2, unaccounted: 0 },
          });
          expect(await keysOf(legacy)).toEqual([]);
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] a crash after the check and before the record deletes nothing and records nothing', async () => {
          const { f, legacy, keysOf, legacyFile, copy, finalize } = await harness();
          await legacyFile('a.txt', 'alpha');
          await copy();
          const dying = { ...f.runs, record: () => Promise.reject(stopped()) };

          await expect(finalize({ runs: dying })).rejects.toThrow('process died');
          expect(await f.runs.latest()).toBeNull();
          expect(await keysOf(legacy)).toEqual(['a.txt']);

          await expect(finalize()).resolves.toMatchObject({ outcome: 'deleted' });
          expect(await keysOf(legacy)).toEqual([]);
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] a crash after the record and before the first delete leaves a clean pass and every old copy', async () => {
          const { f, legacy, keysOf, legacyFile, copy, finalize } = await harness();
          await legacyFile('a.txt', 'alpha');
          await copy();
          const dying: ObjectStoreProviderV2 = {
            forWorkspace: (id) => ({
              ...legacy.forWorkspace(id),
              listPage: () => Promise.reject(stopped()),
            }),
          };

          await expect(finalize({ legacy: { files: dying } })).rejects.toThrow('process died');
          await expect(f.runs.latest()).resolves.toMatchObject({ legacyRows: 0, mismatches: 0 });
          expect(await keysOf(legacy)).toEqual(['a.txt']);

          await expect(finalize()).resolves.toMatchObject({ outcome: 'deleted' });
          expect(await keysOf(legacy)).toEqual([]);
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] a crash while checking records nothing and deletes nothing', async () => {
          const { f, objects, legacy, keysOf, legacyFile, copy, finalize } = await harness();
          await legacyFile('a.txt', 'alpha');
          await copy();
          const dying = { ...objects, head: () => Promise.reject(stopped()) };

          await expect(finalize({ objects: dying })).rejects.toThrow('process died');
          expect(await f.runs.latest()).toBeNull();
          expect(await keysOf(legacy)).toEqual(['a.txt']);

          await expect(finalize()).resolves.toMatchObject({ outcome: 'deleted' });
        });

        // @story US-STO-13
        it('[US-STO-13][unit][cli] deleting works page by page while the listing shrinks', async () => {
          const { legacy, keysOf, legacyFile, copy, finalize } = await harness();
          for (const file of ['a', 'b', 'c', 'd', 'e']) await legacyFile(`${file}.txt`, file);
          await copy();

          await expect(finalize({ pageSize: 2 })).resolves.toMatchObject({
            delete: { deleted: 5, unaccounted: 0 },
          });
          expect(await keysOf(legacy)).toEqual([]);
        });
      });

      // @story US-STO-13
      it('[US-STO-13][unit][cli] the check streams each object and compares size and checksum', async () => {
        const { objects, legacyFile, copy, deps } = await harness();
        await legacyFile('a.txt', 'alpha');
        await copy();
        await expect(verifyAll(deps())).resolves.toMatchObject({ rowsChecked: 1, mismatches: 0 });

        // The check never buffers an object: `get` is not used.
        const streamed = { ...objects, get: () => Promise.reject(new Error('buffered read')) };
        await expect(verifyAll(deps({ objects: streamed }))).resolves.toMatchObject({
          mismatches: 0,
        });
      });
    },
  );
}

defineSuite(true, 'in-memory catalog', memoryFixture);
defineSuite(hasDatabase, 'PostgreSQL catalog', postgresFixture);

describe('finalizing session-state blobs', () => {
  interface BlobRow {
    readonly storageKey: string;
    readonly objectId: string | null;
    readonly sizeBytes: number;
    readonly sha256: string;
  }

  /** The new object of a blob, written under the new naming; its row records the real checksum. */
  async function setup(
    blobs: (
      workspaceId: string,
      objects: ReturnType<typeof createInMemoryObjectStore>,
    ) => Promise<BlobRow[]>,
  ) {
    const workspaceId = crypto.randomUUID();
    const objects = createInMemoryObjectStore();
    const legacy = createInMemoryObjectStoreProvider();
    const rows = await blobs(workspaceId, objects);
    const log: Logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => log,
    };
    const deps: FinalizeDependencies = {
      objects,
      legacy: { 'session-state': legacy },
      catalog: () => Promise.resolve(createInMemoryCatalog().forWorkspace(workspaceId)),
      blobs: () =>
        Promise.resolve({
          countLegacyBlobs: () => Promise.resolve(rows.filter((r) => r.objectId === null).length),
          listObjectBlobs: () =>
            Promise.resolve(
              rows.flatMap((r) =>
                r.objectId === null ? [] : [{ ...r, blobKey: r.storageKey, objectId: r.objectId }],
              ),
            ),
          legacyBlobKeysHeld: (keys) =>
            Promise.resolve(
              rows
                .filter((r) => r.objectId === null && keys.includes(r.storageKey))
                .map((r) => r.storageKey),
            ),
        }),
      workspaceIds: () => Promise.resolve([workspaceId]),
      runs: createInMemoryStorageMigrationRuns(),
      log,
    };
    const old = legacy.forWorkspace(workspaceId);
    return { deps, old, workspaceId, objects };
  }

  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const moved = async (
    workspaceId: string,
    objects: ReturnType<typeof createInMemoryObjectStore>,
    key: string,
    text: string,
    stored = text,
  ): Promise<BlobRow> => {
    const objectId = crypto.randomUUID();
    await objects.write(
      storageObjectName(workspaceId, 'session-state', objectId),
      bytesOf(stored),
      { contentType: null },
    );
    return { storageKey: key, objectId, sizeBytes: bytesOf(text).byteLength, sha256: sha(text) };
  };

  // @story US-STO-13
  it('[US-STO-13][unit][cli] the old blob of a moved snapshot is deleted and a blob no row names is kept and reported', async () => {
    const { deps, old } = await setup(async (workspaceId, objects) => [
      await moved(workspaceId, objects, 's/blob', 'snapshot'),
    ]);
    await old.write('s/blob', bytesOf('snapshot'), { contentType: null });
    // No row names this blob: it is unaccounted, so it stays.
    await old.write('s/overwritten', bytesOf('older'), { contentType: null });

    const report = await runFinalizeStage(deps);

    expect(report).toMatchObject({
      outcome: 'deleted',
      verify: { rowsChecked: 1, mismatches: 0 },
      delete: { deleted: 1, unaccounted: 1 },
    });
    expect((await old.listPage('', { recursive: true })).entries.map((e) => e.key)).toEqual([
      's/overwritten',
    ]);
  });

  // @story US-STO-13
  it('[US-STO-13][unit][cli] a blob row without an object id blocks the delete and keeps its bytes', async () => {
    const { deps, old } = await setup((workspaceId, objects) =>
      moved(workspaceId, objects, 's/new', 'new').then((row) => [
        row,
        { storageKey: 's/legacy', objectId: null, sizeBytes: 3, sha256: sha('old') },
      ]),
    );
    await old.write('s/new', bytesOf('new'), { contentType: null });
    await old.write('s/legacy', bytesOf('old'), { contentType: null });

    const report = await runFinalizeStage(deps);

    expect(report).toMatchObject({ outcome: 'blocked', verify: { legacyRows: 1 } });
    expect((await old.listPage('', { recursive: true })).entries).toHaveLength(2);
  });

  // @story US-STO-13
  it('[US-STO-13][unit][cli] a snapshot whose new object has other bytes blocks the delete', async () => {
    const { deps, old } = await setup(async (workspaceId, objects) => [
      await moved(workspaceId, objects, 's/blob', 'snapshot', 'snapshoX'),
    ]);
    await old.write('s/blob', bytesOf('snapshot'), { contentType: null });

    const report = await runFinalizeStage(deps);

    expect(report).toMatchObject({ outcome: 'blocked', verify: { mismatches: 1 } });
    await expect(old.head('s/blob')).resolves.not.toBeNull();
  });
});
