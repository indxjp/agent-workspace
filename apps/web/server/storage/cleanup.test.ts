import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agents,
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseSessionStateRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  memberships,
  sessions,
  sessionStateBlobs,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  createInMemoryStorageMigrationRuns,
  type CatalogPort,
  type ResourceCatalogRepository,
} from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  storageObjectName,
  type ObjectStore,
  type StorageArea,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { CLEANUP_MIN_AGE_MS, runCleanupPass, type CleanupDependencies } from './cleanup';
import { runAdoptStage } from './migrate-naming';

const PREFIX = 'files/workspaces';

type BlobStatus = 'pending' | 'ready' | 'deleting';

interface Fixture {
  readonly workspace: () => Promise<{ readonly id: string; readonly principalId: string }>;
  readonly catalog: (workspaceId: string) => Promise<ResourceCatalogRepository>;
  /** The session-state blob rows of a workspace, as the cleanup job reads them. */
  readonly sessionState: CleanupDependencies['sessionState'];
  /** A session-state blob row holding `objectId` in `status`. */
  readonly stateBlob: (workspaceId: string, objectId: string, status: BlobStatus) => Promise<void>;
}

function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  const held = new Set<string>();
  return Promise.resolve({
    workspace: () => Promise.resolve({ id: crypto.randomUUID(), principalId: crypto.randomUUID() }),
    catalog: (workspaceId) => Promise.resolve(provider.forWorkspace(workspaceId)),
    sessionState: () =>
      Promise.resolve({
        referencedObjectIds: (ids) => Promise.resolve(ids.filter((id) => held.has(id))),
      }),
    stateBlob: (_workspaceId, objectId) => {
      held.add(objectId);
      return Promise.resolve();
    },
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_storage_cleanup');
}, 180_000);

afterAll(async () => isolated?.close());

function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const provider = createDatabaseResourceCatalogRepositoryProvider(db);
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  const sessionsOf = new Map<string, string>();
  return Promise.resolve({
    workspace: async () => {
      const id = crypto.randomUUID();
      await db.insert(workspaces).values({ id, slug: `s-${id}`, name: 'cleanup' });
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
      // A session-state blob row hangs off a session, which hangs off an agent.
      const agentId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      await db.insert(agents).values({
        id: agentId,
        workspaceId: id,
        name: 'cleanup',
        instructions: '',
        ownerPrincipalId: principalId,
        createdBy: userId,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      await db
        .insert(sessions)
        .values({ id: sessionId, workspaceId: id, userId, ownerPrincipalId: principalId, agentId });
      sessionsOf.set(id, sessionId);
      return { id, principalId };
    },
    catalog: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
      return provider.forScope(scope);
    },
    sessionState: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
      return createDatabaseSessionStateRepositoryProvider(db).forScope(scope);
    },
    stateBlob: async (workspaceId, objectId, status) => {
      const sessionId = sessionsOf.get(workspaceId);
      if (sessionId === undefined) throw new Error('the workspace has no session');
      await db.insert(sessionStateBlobs).values({
        workspaceId,
        sessionId,
        engine: 'claude-agent-sdk',
        blobKey: crypto.randomUUID(),
        storageKey: `workspaces/${workspaceId}/session-state/${objectId}`,
        objectId,
        status,
        sizeBytes: 7,
        sha256: '0'.repeat(64),
      });
    },
  });
}

function defineSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`cleanup on the ${name}`, () => {
    async function harness() {
      const f = await setup();
      const objects = createInMemoryObjectStore();
      const legacyObjects = createInMemoryObjectStore();
      const lines: { message: string; fields: unknown }[] = [];
      const log: Logger = {
        info: (message, fields) => lines.push({ message, fields }),
        warn: (message, fields) => lines.push({ message, fields }),
        error: (message, fields) => lines.push({ message, fields }),
        child: () => log,
      };
      const owners = new Map<string, string>();
      const known = async () => {
        const created = await f.workspace();
        owners.set(created.id, created.principalId);
        return created;
      };
      /** An object the old layout wrote: raw bytes under the legacy prefix, no catalog row. */
      const legacyObject = (workspaceId: string, path: string) =>
        legacyObjects.write(`${PREFIX}/${workspaceId}/${path}`, new Uint8Array(7), {
          contentType: null,
        });
      // The objects were just written; the clock is far enough ahead for them to be old enough.
      const later = () => new Date(Date.now() + 2 * CLEANUP_MIN_AGE_MS);
      interface RunOptions {
        readonly pageSize?: number;
        readonly now?: () => Date;
        readonly objects?: ObjectStore;
        readonly legacy?: ObjectStore;
        readonly catalogs?: (workspaceId: string) => Promise<CatalogPort>;
      }
      const run = (mode: 'report' | 'delete', options: RunOptions = {}) =>
        runCleanupPass({
          objects: options.objects ?? objects,
          legacy: { objects: options.legacy ?? legacyObjects, prefix: PREFIX },
          catalogs: options.catalogs ?? f.catalog,
          sessionState: f.sessionState,
          workspaceIds: () => Promise.resolve([...owners.keys()]),
          now: options.now ?? later,
          mode,
          log,
          ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
        });
      const newName = (workspaceId: string, objectId: string) =>
        storageObjectName(workspaceId, 'files', objectId);
      /** An object in the new naming, `size` bytes long. */
      const newObject = (workspaceId: string, objectId: string, size = 7) =>
        objects.write(newName(workspaceId, objectId), new Uint8Array(size), { contentType: null });
      const reserveRow = async (
        ws: { id: string; principalId: string },
        path: string,
        input: {
          sizeBytes?: number;
          objectId?: string;
          area?: StorageArea;
          uploadMode?: 'relay' | 'signed';
        } = {},
      ) => {
        const catalog = await f.catalog(ws.id);
        const reserved = await catalog.reserve(path, {
          ...(input.area === undefined ? {} : { area: input.area }),
          ownerPrincipalId: ws.principalId,
          sizeBytes: input.sizeBytes ?? 0,
          contentType: 'text/plain',
          ...(input.objectId === undefined ? {} : { objectId: input.objectId }),
          ...(input.uploadMode === undefined ? {} : { uploadMode: input.uploadMode }),
        });
        if (reserved.kind !== 'reserved') throw new Error(`${path} was already taken`);
        return reserved.row;
      };
      const readyRow = async (
        ws: { id: string; principalId: string },
        path: string,
        input: { sizeBytes?: number; objectId?: string; area?: StorageArea } = {},
      ) => {
        const row = await reserveRow(ws, path, input);
        const catalog = await f.catalog(ws.id);
        const done = await catalog.confirm(row, {
          sizeBytes: row.sizeBytes,
          contentType: 'text/plain',
        });
        if (done === null) throw new Error(`${path} vanished before confirm`);
        return done.row;
      };
      const adopt = () =>
        runAdoptStage({
          objects: legacyObjects,
          prefix: PREFIX,
          catalog: f.catalog,
          ownerPrincipalId: (id) => Promise.resolve(owners.get(id) ?? null),
          runs: createInMemoryStorageMigrationRuns(),
          log,
        });
      return {
        f,
        known,
        legacyObject,
        newObject,
        newName,
        reserveRow,
        readyRow,
        run,
        adopt,
        lines,
        objects,
        legacyObjects,
      };
    }

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] an old-style file with a legacy row is never reported as an orphan', async () => {
      const { known, legacyObject, adopt, run } = await harness();
      const ws = await known();
      await legacyObject(ws.id, 'a.txt');
      await adopt();

      await expect(run('report')).resolves.toMatchObject({ scanned: 1, orphans: 0, deleted: 0 });
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] cleanup finds orphans in both namings and removes only new-naming ones', async () => {
      const h = await harness();
      const ws = await h.known();
      const kept = crypto.randomUUID();
      const orphan = crypto.randomUUID();
      await h.legacyObject(ws.id, 'a.txt');
      await h.adopt();
      await h.legacyObject(ws.id, 'dir/b.txt');
      await h.readyRow(ws, 'new.txt', { objectId: kept });
      await h.newObject(ws.id, kept);
      await h.newObject(ws.id, orphan);

      await expect(h.run('report')).resolves.toMatchObject({
        scanned: 4,
        orphans: 2,
        legacyOrphans: 1,
        deleted: 0,
      });
      await expect(h.objects.head(h.newName(ws.id, orphan))).resolves.not.toBeNull();
      await expect(h.legacyObjects.head(`${PREFIX}/${ws.id}/dir/b.txt`)).resolves.not.toBeNull();

      await expect(h.run('delete')).resolves.toMatchObject({
        orphans: 2,
        legacyOrphans: 1,
        deleted: 1,
      });
      await expect(h.objects.head(h.newName(ws.id, orphan))).resolves.toBeNull();
      await expect(h.legacyObjects.head(`${PREFIX}/${ws.id}/dir/b.txt`)).resolves.not.toBeNull();
      await expect(h.objects.head(h.newName(ws.id, kept))).resolves.not.toBeNull();
      await expect(h.legacyObjects.head(`${PREFIX}/${ws.id}/a.txt`)).resolves.not.toBeNull();
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] a legacy-naming orphan is never deleted in delete mode', async () => {
      const h = await harness();
      const ws = await h.known();
      await h.legacyObject(ws.id, 'unadopted.txt');

      for (const mode of ['report', 'delete'] as const) {
        await expect(h.run(mode)).resolves.toMatchObject({
          orphans: 1,
          legacyOrphans: 1,
          deleted: 0,
        });
      }
      await expect(
        h.legacyObjects.head(`${PREFIX}/${ws.id}/unadopted.txt`),
      ).resolves.not.toBeNull();
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] an object a deleting, side-path or pending row points at is never an orphan', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const replacement = crypto.randomUUID();
      const pendingId = crypto.randomUUID();
      // a removed old-style file whose row still waits for its delete
      await h.legacyObject(ws.id, 'gone.txt');
      await h.readyRow(ws, 'gone.txt', { sizeBytes: 7 });
      await catalog.remove('gone.txt');
      // a replacement waiting at a side path
      await h.legacyObject(ws.id, 'kept.txt');
      await h.readyRow(ws, 'kept.txt', { sizeBytes: 7 });
      await h.reserveRow(ws, 'kept.txt', { objectId: replacement });
      await h.newObject(ws.id, replacement);
      // an upload still waiting for its completion
      await h.reserveRow(ws, 'later.txt', { objectId: pendingId });
      await h.newObject(ws.id, pendingId);

      await expect(h.run('report')).resolves.toMatchObject({ scanned: 4, orphans: 0 });
    });

    // @story US-STO-09
    it('[US-STO-09][contract][run] a session-state object with a row is never an orphan', async () => {
      const h = await harness();
      const ws = await h.known();
      const ready = crypto.randomUUID();
      const deleting = crypto.randomUUID();
      const orphan = crypto.randomUUID();
      const stateObject = (objectId: string) =>
        h.objects.write(storageObjectName(ws.id, 'session-state', objectId), new Uint8Array(7), {
          contentType: null,
        });
      for (const [objectId, status] of [
        [ready, 'ready'],
        [deleting, 'deleting'],
      ] as const) {
        await stateObject(objectId);
        await h.f.stateBlob(ws.id, objectId, status);
      }
      await stateObject(orphan);

      await expect(h.run('report')).resolves.toMatchObject({ scanned: 3, orphans: 1, deleted: 0 });
      await expect(h.run('delete')).resolves.toMatchObject({ orphans: 1, deleted: 1 });
      const name = (objectId: string) => storageObjectName(ws.id, 'session-state', objectId);
      await expect(h.objects.head(name(orphan))).resolves.toBeNull();
      await expect(h.objects.head(name(ready))).resolves.not.toBeNull();
      await expect(h.objects.head(name(deleting))).resolves.not.toBeNull();
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a skills object with a row is not an orphan', async () => {
      const h = await harness();
      const ws = await h.known();
      const kept = crypto.randomUUID();
      const orphan = crypto.randomUUID();
      const skillObject = (objectId: string) =>
        h.objects.write(storageObjectName(ws.id, 'skills', objectId), new Uint8Array(7), {
          contentType: null,
        });
      await skillObject(kept);
      await skillObject(orphan);
      await h.readyRow(ws, '.skills/demo/SKILL.md', {
        sizeBytes: 7,
        objectId: kept,
        area: 'skills',
      });
      await expect(h.run('report')).resolves.toMatchObject({ scanned: 2, orphans: 1, deleted: 0 });
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] objects younger than the minimum age are skipped and counted in both modes', async () => {
      const h = await harness();
      const ws = await h.known();
      const id = crypto.randomUUID();
      await h.newObject(ws.id, id);
      await h.legacyObject(ws.id, 'fresh.txt');
      const options = { now: () => new Date() };

      for (const mode of ['report', 'delete'] as const) {
        await expect(h.run(mode, options)).resolves.toMatchObject({
          scanned: 2,
          skippedYoung: 2,
          orphans: 0,
          deleted: 0,
        });
      }
      await expect(h.objects.head(h.newName(ws.id, id))).resolves.not.toBeNull();
      await expect(h.legacyObjects.head(`${PREFIX}/${ws.id}/fresh.txt`)).resolves.not.toBeNull();
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] cleanup pages through the listing and counts every object once', async () => {
      const h = await harness();
      const first = await h.known();
      const second = await h.known();
      const kept = crypto.randomUUID();
      await h.readyRow(first, 'kept.txt', { objectId: kept });
      await h.newObject(first.id, kept);
      await h.newObject(first.id, crypto.randomUUID());
      await h.newObject(second.id, crypto.randomUUID());
      await h.legacyObject(second.id, 'x.txt');
      await h.legacyObject(second.id, 'y/z.txt');

      await expect(h.run('delete', { pageSize: 1 })).resolves.toMatchObject({
        scanned: 5,
        orphans: 4,
        legacyOrphans: 2,
        deleted: 2,
      });
      await expect(h.objects.head(h.newName(first.id, kept))).resolves.not.toBeNull();
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] cleanup reads past the first page at the default page size', async () => {
      const h = await harness();
      const ws = await h.known();
      for (let n = 0; n <= 1000; n += 1) await h.newObject(ws.id, crypto.randomUUID());

      await expect(h.run('delete')).resolves.toMatchObject({
        scanned: 1001,
        orphans: 1001,
        deleted: 1001,
      });
      expect((await h.objects.listPage('', { recursive: true })).entries).toEqual([]);
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a signed-link upload without complete becomes ready', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      await h.reserveRow(ws, 'up.bin', { sizeBytes: 7 });
      await h.legacyObject(ws.id, 'up.bin');

      await expect(h.run('report')).resolves.toMatchObject({ stalePendingReady: 1 });
      await expect(catalog.get('up.bin')).resolves.toBeNull();

      await expect(h.run('delete')).resolves.toMatchObject({ stalePendingReady: 1, orphans: 0 });
      await expect(catalog.get('up.bin')).resolves.toMatchObject({ status: 'ready', sizeBytes: 7 });
      await expect(h.legacyObjects.head(`${PREFIX}/${ws.id}/up.bin`)).resolves.not.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a stale upload in the new naming with its declared size becomes ready', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const objectId = crypto.randomUUID();
      await h.reserveRow(ws, 'up.bin', { sizeBytes: 5, objectId });
      await h.newObject(ws.id, objectId, 5);

      await expect(h.run('delete')).resolves.toMatchObject({ stalePendingReady: 1, orphans: 0 });
      const ready = await catalog.get('up.bin');
      expect(ready).toMatchObject({ status: 'ready', sizeBytes: 5 });
      // Published on a copy, as `completeUpload` does; the uploaded object is gone.
      expect(ready?.objectId).not.toBe(objectId);
      await expect(h.objects.head(h.newName(ws.id, ready?.objectId ?? ''))).resolves.not.toBeNull();
      await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a stale upload confirmed by cleanup records the SHA-256 of its bytes', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const objectId = crypto.randomUUID();
      const bytes = new TextEncoder().encode('five!');
      await h.reserveRow(ws, 'sum.bin', { sizeBytes: bytes.length, objectId });
      await h.objects.write(h.newName(ws.id, objectId), bytes, { contentType: null });

      await expect(h.run('delete')).resolves.toMatchObject({ stalePendingReady: 1 });
      await expect(catalog.get('sum.bin')).resolves.toMatchObject({
        status: 'ready',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] a row reserved 2 h ago and re-minted 1 min ago is not stale', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const objectId = crypto.randomUUID();
      const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
      await h.reserveRow(ws, 'mint.bin', { sizeBytes: 5, objectId, uploadMode: 'signed' });
      await h.newObject(ws.id, objectId, 5);
      await pause();
      const cut = new Date();
      await pause();
      // The same owner asks for the link again: the reservation is as young as the new link.
      await expect(
        catalog.reserve('mint.bin', {
          ownerPrincipalId: ws.principalId,
          sizeBytes: 5,
          contentType: 'text/plain',
          objectId,
          uploadMode: 'signed',
        }),
      ).resolves.toMatchObject({ kind: 'taken' });

      // The pass sees `cut` as its cut-off: the first reservation is older, the re-mint younger.
      const now = () => new Date(cut.getTime() + CLEANUP_MIN_AGE_MS);
      await expect(h.run('delete', { now })).resolves.toMatchObject({
        stalePendingReady: 0,
        stalePendingDeleted: 0,
      });
      await expect(catalog.pending('mint.bin')).resolves.not.toBeNull();
      await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.not.toBeNull();
    });

    /** The objects store, running `during` once when the pass checks the object `name`. */
    const onHead = (store: ObjectStore, name: string, during: () => Promise<unknown>) => {
      let ran = false;
      return new Proxy(store, {
        get: (inner, property) =>
          property === 'head'
            ? async (key: string) => {
                if (key === name && !ran) {
                  ran = true;
                  await during();
                }
                return inner.head(key);
              }
            : (Reflect.get(inner, property) as unknown),
      });
    };

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] a stale cleanup snapshot cannot delete an upload that was confirmed during its object check', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const objectId = crypto.randomUUID();
      // A relay save wrote its bytes and has not confirmed them yet: its row still declares 0.
      const row = await h.reserveRow(ws, 'late.bin', { objectId, uploadMode: 'relay' });
      await h.newObject(ws.id, objectId, 4);
      const confirmLate = () => catalog.confirm(row, { sizeBytes: 4, contentType: 'text/plain' });

      await h.run('delete', {
        objects: onHead(h.objects, h.newName(ws.id, objectId), confirmLate),
      });

      await expect(catalog.get('late.bin')).resolves.toMatchObject({ id: row.id, objectId });
      await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.not.toBeNull();
      await expect(catalog.deleting()).resolves.toEqual([]);
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] a stale cleanup snapshot cannot delete an upload that was refreshed during its object check', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const objectId = crypto.randomUUID();
      // The first PUT stopped short; the owner mints the link again while the pass looks at it.
      const row = await h.reserveRow(ws, 'again.bin', {
        sizeBytes: 5,
        objectId,
        uploadMode: 'signed',
      });
      await h.newObject(ws.id, objectId, 4);
      const remint = () =>
        catalog.reserve('again.bin', {
          ownerPrincipalId: ws.principalId,
          sizeBytes: 5,
          contentType: 'text/plain',
          objectId,
          uploadMode: 'signed',
        });

      await h.run('delete', { objects: onHead(h.objects, h.newName(ws.id, objectId), remint) });

      await expect(catalog.pending('again.bin')).resolves.toMatchObject({ id: row.id });
      await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.not.toBeNull();
      await expect(catalog.deleting()).resolves.toEqual([]);
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a stale signed upload that declared 0 bytes becomes ready', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const objectId = crypto.randomUUID();
      await h.reserveRow(ws, 'empty.bin', { sizeBytes: 0, objectId });
      await h.newObject(ws.id, objectId, 0);

      await expect(h.run('delete')).resolves.toMatchObject({ stalePendingReady: 1, orphans: 0 });
      await expect(catalog.get('empty.bin')).resolves.toMatchObject({
        status: 'ready',
        sizeBytes: 0,
      });
    });

    // @story US-STO-07
    it('[US-STO-07][unit][run] a stale staging row is deleted, never confirmed', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const objectId = crypto.randomUUID();
      const path = `.staging-${objectId}`;
      const name = storageObjectName(ws.id, 'staging', objectId);
      // The object is exactly as long as the row declares, which confirms any other pending row.
      await h.reserveRow(ws, path, { sizeBytes: 5, objectId, area: 'staging' });
      await h.objects.write(name, new Uint8Array(5), { contentType: null });

      await expect(h.run('report')).resolves.toMatchObject({
        stalePendingReady: 0,
        stalePendingDeleted: 1,
      });
      await expect(catalog.pending(path)).resolves.not.toBeNull();
      await expect(h.objects.head(name)).resolves.not.toBeNull();

      await expect(h.run('delete')).resolves.toMatchObject({
        stalePendingReady: 0,
        stalePendingDeleted: 1,
      });
      await expect(catalog.get(path, { includePending: true })).resolves.toBeNull();
      await expect(h.objects.head(name)).resolves.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a stale upload with the wrong size, no size or no object is dropped with its object', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const wrong = crypto.randomUUID();
      const relay = crypto.randomUUID();
      const missing = crypto.randomUUID();
      await h.reserveRow(ws, 'wrong.bin', { sizeBytes: 5, objectId: wrong });
      await h.newObject(ws.id, wrong, 4);
      await h.reserveRow(ws, 'relay.bin', { objectId: relay });
      await h.newObject(ws.id, relay, 4);
      await h.reserveRow(ws, 'missing.bin', { sizeBytes: 5, objectId: missing });
      await h.reserveRow(ws, 'legacy-wrong.bin', { sizeBytes: 5 });
      await h.legacyObject(ws.id, 'legacy-wrong.bin');
      await h.reserveRow(ws, 'legacy-missing.bin', { sizeBytes: 5 });

      await expect(h.run('delete')).resolves.toMatchObject({
        stalePendingReady: 0,
        stalePendingDeleted: 5,
      });
      const later = new Date(Date.now() + CLEANUP_MIN_AGE_MS * 4);
      await expect(catalog.stalePending(later)).resolves.toEqual([]);
      await expect(catalog.get('legacy-wrong.bin')).resolves.toBeNull();
      await expect(catalog.get('legacy-missing.bin')).resolves.toBeNull();
      await expect(h.objects.head(h.newName(ws.id, wrong))).resolves.toBeNull();
      await expect(h.objects.head(h.newName(ws.id, relay))).resolves.toBeNull();
      await expect(h.legacyObjects.head(`${PREFIX}/${ws.id}/legacy-wrong.bin`)).resolves.toBeNull();
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] cleanup finishes an interrupted delete: the object, then the row', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const objectId = crypto.randomUUID();
      await h.readyRow(ws, 'new.txt', { objectId });
      await h.newObject(ws.id, objectId);
      await h.legacyObject(ws.id, 'old.txt');
      await h.readyRow(ws, 'old.txt', { sizeBytes: 7 });
      await catalog.remove('new.txt');
      await catalog.remove('old.txt');

      await expect(h.run('report')).resolves.toMatchObject({ deletingFinished: 2 });
      await expect(catalog.deleting()).resolves.toHaveLength(2);

      await expect(h.run('delete')).resolves.toMatchObject({ deletingFinished: 2, orphans: 0 });
      await expect(catalog.deleting()).resolves.toEqual([]);
      await expect(h.objects.head(h.newName(ws.id, objectId))).resolves.toBeNull();
      await expect(h.legacyObjects.head(`${PREFIX}/${ws.id}/old.txt`)).resolves.toBeNull();
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] a delete that fails keeps the deleting row for the next pass', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      await h.legacyObject(ws.id, 'old.txt');
      await h.readyRow(ws, 'old.txt', { sizeBytes: 7 });
      await catalog.remove('old.txt');
      const failing: ObjectStore = {
        ...h.legacyObjects,
        delete: () => Promise.reject(new Error('the store is down')),
      };

      await expect(h.run('delete', { legacy: failing })).resolves.toMatchObject({
        deletingFinished: 0,
      });
      await expect(catalog.deleting()).resolves.toHaveLength(1);
      await expect(h.run('delete')).resolves.toMatchObject({ deletingFinished: 1 });
      await expect(catalog.deleting()).resolves.toEqual([]);
    });

    // @story US-STO-04
    it('[US-STO-04][unit][sdk] a deleting row whose key a live row now holds only drops the row', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      await h.legacyObject(ws.id, 'again.txt');
      await h.readyRow(ws, 'again.txt', { sizeBytes: 7 });
      await catalog.remove('again.txt');
      await h.readyRow(ws, 'again.txt', { sizeBytes: 7 });

      await expect(h.run('delete')).resolves.toMatchObject({ deletingFinished: 1, orphans: 0 });
      await expect(catalog.deleting()).resolves.toEqual([]);
      await expect(h.legacyObjects.head(`${PREFIX}/${ws.id}/again.txt`)).resolves.not.toBeNull();
      await expect(catalog.get('again.txt')).resolves.toMatchObject({ status: 'ready' });
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] a report pass writes nothing: every write method of the stores and the catalog throws', async () => {
      const h = await harness();
      const ws = await h.known();
      const catalog = await h.f.catalog(ws.id);
      const orphan = crypto.randomUUID();
      const stale = crypto.randomUUID();
      const gone = crypto.randomUUID();
      await h.newObject(ws.id, orphan);
      await h.legacyObject(ws.id, 'orphan.txt');
      await h.reserveRow(ws, 'stale.bin', { sizeBytes: 5, objectId: stale });
      await h.newObject(ws.id, stale, 5);
      await h.readyRow(ws, 'gone.bin', { objectId: gone });
      await h.newObject(ws.id, gone);
      await catalog.remove('gone.bin');
      const reads = new Set(['listPage', 'head', 'deleting', 'stalePending', 'referencing']);
      const readOnly = <T extends object>(target: T): T =>
        new Proxy(target, {
          get: (inner, property) =>
            typeof property !== 'string' || property === 'then' || reads.has(property)
              ? Reflect.get(inner, property)
              : () => {
                  throw new Error(`report mode called ${property}`);
                },
        });

      const report = await h.run('report', {
        objects: readOnly(h.objects),
        legacy: readOnly(h.legacyObjects),
        catalogs: async (id) => readOnly(await h.f.catalog(id)),
      });

      expect(report).toMatchObject({
        orphans: 2,
        stalePendingReady: 1,
        deletingFinished: 1,
        deleted: 0,
      });
      expect(h.lines.filter((line) => line.message.includes('failed'))).toEqual([]);
      expect(h.lines.find((line) => line.message === 'storage cleanup')?.fields).toMatchObject({
        mode: 'report',
        orphans: 2,
      });
      await expect(catalog.deleting()).resolves.toHaveLength(1);
      await expect(h.objects.head(h.newName(ws.id, orphan))).resolves.not.toBeNull();
    });
  });
}

defineSuite('in-memory catalog', memoryFixture);
defineSuite('PostgreSQL catalog', postgresFixture);
