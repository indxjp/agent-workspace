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
  bytesToStream,
  createInMemoryObjectStore,
  storageObjectName,
  type ObjectStoreV2,
  type SignedUrlRequest,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';
import { MAX_PENDING_UPLOADS_PER_WORKSPACE } from '@indx-workspace/contracts/files';

import { createStorageService, type StorageContext } from './service';

interface Fixture {
  readonly workspace: () => Promise<{ readonly id: string; readonly principalId: string }>;
  readonly catalog: (workspaceId: string) => Promise<ResourceCatalogRepository>;
}

function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  return Promise.resolve({
    workspace: () => Promise.resolve({ id: crypto.randomUUID(), principalId: crypto.randomUUID() }),
    catalog: (workspaceId) => Promise.resolve(provider.forWorkspace(workspaceId)),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_storage_service_upload');
}, 180_000);

afterAll(async () => isolated?.close());

function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const provider = createDatabaseResourceCatalogRepositoryProvider(db);
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return Promise.resolve({
    workspace: async () => {
      const id = crypto.randomUUID();
      await db.insert(workspaces).values({ id, slug: `s-${id}`, name: 'service upload' });
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

const noLog: Logger = { info() {}, warn() {}, error() {}, child: () => noLog };
const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha256Of = async (text: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', bytesOf(text))).toString('hex');

function defineSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`signed uploads through the service on the ${name}`, () => {
    async function harness(bindsLength = true) {
      const f = await setup();
      const ws = await f.workspace();
      const requests: SignedUrlRequest[] = [];
      const inner = createInMemoryObjectStore();
      const objects: ObjectStoreV2 = {
        ...inner,
        capabilities: { ...inner.capabilities, sign: true, boundLengthSign: bindsLength },
        createSignedUrl: (key, request) => {
          requests.push(request);
          return Promise.resolve({ url: `https://store.invalid/${key}`, headers: {} });
        },
      };
      const storage = createStorageService({ catalog: f.catalog, objects, log: noLog });
      const ctx: StorageContext = { workspaceId: ws.id, principalId: ws.principalId, userId: null };
      const catalog = await f.catalog(ws.id);
      const nameOf = (objectId: string | null | undefined) =>
        storageObjectName(ws.id, 'files', objectId ?? '');
      const save = async (path: string, text: string) => {
        const saved = await storage.save(ctx, {
          area: 'files',
          path,
          body: bytesToStream(bytesOf(text)),
          maxBytes: 1024,
          replace: true,
        });
        if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
        return saved.row;
      };
      const mint = (path: string, sizeBytes: number, mayReplace = true) =>
        storage.reserveUpload(ctx, {
          path,
          sizeBytes,
          mayReplace: () => Promise.resolve(mayReplace),
        });
      /** The bytes a `PUT` to the signed link would land on its object. */
      const put = async (path: string, text: string) => {
        const pending = await catalog.pending(path);
        if (pending === null) throw new Error(`${path} has no pending upload`);
        await objects.write(nameOf(pending.objectId), bytesOf(text), { contentType: null });
        return pending;
      };
      const complete = (path: string, maxBytes = 1024) =>
        storage.completeUpload(ctx, { path, maxBytes });
      return { ws, ctx, catalog, objects, requests, storage, nameOf, save, mint, put, complete };
    }

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a signed replace keeps the old object until complete, then swaps the rows', async () => {
      const h = await harness();
      const old = await h.save('a.txt', 'old');
      await expect(h.mint('a.txt', 3)).resolves.toMatchObject({ ok: true });
      const fresh = await h.put('a.txt', 'new');
      expect(fresh.objectId).not.toBe(old.objectId);
      await expect(h.catalog.get('a.txt')).resolves.toMatchObject({ id: old.id });
      await expect(h.objects.head(h.nameOf(old.objectId))).resolves.not.toBeNull();

      const done = await h.complete('a.txt');
      expect(done).toMatchObject({
        ok: true,
        row: { objectId: fresh.objectId, sizeBytes: 3, sha256: await sha256Of('new') },
      });
      await expect(h.objects.head(h.nameOf(old.objectId))).resolves.toBeNull();
      await expect(h.catalog.pending('a.txt')).resolves.toBeNull();
      await expect(h.catalog.countPending()).resolves.toBe(0);
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] an oversize object is deleted with its pending row and the ready file is untouched', async () => {
      const h = await harness();
      const old = await h.save('a.txt', 'old');
      await h.mint('a.txt', 3);
      const fresh = await h.put('a.txt', 'far too long');

      await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'too_large' });
      await expect(h.objects.head(h.nameOf(fresh.objectId))).resolves.toBeNull();
      await expect(h.catalog.pending('a.txt')).resolves.toBeNull();
      await expect(h.catalog.get('a.txt')).resolves.toMatchObject({ id: old.id });
      await expect(h.objects.head(h.nameOf(old.objectId))).resolves.not.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] an object over the deployment limit is refused even when it matches the declared size', async () => {
      const h = await harness();
      await h.mint('a.txt', 12);
      const fresh = await h.put('a.txt', 'twelve bytes');

      await expect(h.complete('a.txt', 5)).resolves.toEqual({ ok: false, code: 'too_large' });
      await expect(h.objects.head(h.nameOf(fresh.objectId))).resolves.toBeNull();
      await expect(h.catalog.pending('a.txt')).resolves.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a missing or smaller object leaves the row pending', async () => {
      const h = await harness();
      await h.mint('a.txt', 5);
      await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'not_verified' });
      await h.put('a.txt', 'abc');
      await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'size_mismatch' });
      await expect(h.catalog.pending('a.txt')).resolves.not.toBeNull();
      await h.put('a.txt', 'abcde');
      await expect(h.complete('a.txt')).resolves.toMatchObject({ ok: true });
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] completing again answers the ready file, and a path with nothing is not found', async () => {
      const h = await harness();
      await h.mint('a.txt', 2);
      await h.put('a.txt', 'hi');
      const first = await h.complete('a.txt');
      await expect(h.complete('a.txt')).resolves.toEqual(first);
      await expect(h.complete('none.txt')).resolves.toEqual({ ok: false, code: 'not_found' });
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a ready file whose object is gone is not answered as complete', async () => {
      const h = await harness();
      const old = await h.save('a.txt', 'old');
      await h.objects.delete(h.nameOf(old.objectId));
      await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'not_verified' });
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a refused replace leaves no row, and re-minting a pending path is not counted twice', async () => {
      const h = await harness();
      await h.save('a.txt', 'old');
      await expect(h.mint('a.txt', 3, false)).resolves.toEqual({
        ok: false,
        code: 'replace_refused',
      });
      await expect(h.catalog.countPending()).resolves.toBe(0);

      for (let index = 0; index < MAX_PENDING_UPLOADS_PER_WORKSPACE - 1; index += 1) {
        await h.catalog.reserve(`seed/${index}.bin`, {
          ownerPrincipalId: h.ws.principalId,
          sizeBytes: 1,
          contentType: null,
        });
      }
      await expect(h.mint('b.txt', 1)).resolves.toMatchObject({ ok: true });
      await expect(h.mint('b.txt', 1)).resolves.toMatchObject({ ok: true });
      await expect(h.catalog.countPending()).resolves.toBe(MAX_PENDING_UPLOADS_PER_WORKSPACE);
      await expect(h.mint('c.txt', 1)).resolves.toEqual({ ok: false, code: 'too_many_pending' });
      await expect(h.catalog.countPending()).resolves.toBe(MAX_PENDING_UPLOADS_PER_WORKSPACE);
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a pending staging row does not use the pending-upload cap', async () => {
      const h = await harness();
      const staged = await h.storage.stage(h.ctx, bytesToStream(bytesOf('tar')), 1024);
      if (!staged.ok) throw new Error('stage refused');
      await expect(h.catalog.countPending()).resolves.toBe(0);
      for (let index = 0; index < MAX_PENDING_UPLOADS_PER_WORKSPACE; index += 1) {
        await expect(h.mint(`up/${index}.bin`, 1)).resolves.toMatchObject({ ok: true });
      }
      await expect(h.mint('over.bin', 1)).resolves.toEqual({ ok: false, code: 'too_many_pending' });
      await h.storage.unstage(h.ctx, staged.row);
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a relay save over my own pending signed upload is refused and leaves its declared size', async () => {
      const h = await harness();
      await expect(h.mint('a.txt', 3)).resolves.toMatchObject({ ok: true });
      await expect(
        h.storage.save(h.ctx, {
          area: 'files',
          path: 'a.txt',
          body: bytesToStream(bytesOf('xyz')),
          maxBytes: 1024,
          replace: true,
        }),
      ).resolves.toEqual({ ok: false, code: 'upload_in_progress' });
      await expect(h.catalog.pending('a.txt')).resolves.toMatchObject({ sizeBytes: 3 });
      await h.put('a.txt', 'abc');
      await expect(h.complete('a.txt')).resolves.toMatchObject({ ok: true });
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a mint during my own in-flight relay save is refused and signs nothing', async () => {
      const h = await harness();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate;
          controller.enqueue(bytesOf('abc'));
          controller.close();
        },
      });
      const saving = h.storage.save(h.ctx, {
        area: 'files',
        path: 'a.txt',
        body,
        maxBytes: 1024,
        replace: true,
      });
      while ((await h.catalog.pending('a.txt')) === null)
        await new Promise((r) => setTimeout(r, 1));
      await expect(h.mint('a.txt', 3)).resolves.toEqual({ ok: false, code: 'upload_in_progress' });
      expect(h.requests).toHaveLength(0);
      release();
      await expect(saving).resolves.toMatchObject({ ok: true });
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] completing a path whose pending row is a relay save in flight deletes nothing', async () => {
      const h = await harness();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate;
          controller.enqueue(bytesOf('abc'));
          controller.close();
        },
      });
      const saving = h.storage.save(h.ctx, {
        area: 'files',
        path: 'a.txt',
        body,
        maxBytes: 1024,
        replace: true,
      });
      let pending = await h.catalog.pending('a.txt');
      while (pending === null) {
        await new Promise((r) => setTimeout(r, 1));
        pending = await h.catalog.pending('a.txt');
      }
      // The save's object is written but its row is not yet confirmed: the store reports it.
      const realHead = h.objects.head.bind(h.objects);
      Object.assign(h.objects, {
        head: () => Promise.resolve({ sizeBytes: 3, contentType: null, etag: 'x' }),
      });
      const discarded: string[] = [];
      const realDelete = h.objects.delete.bind(h.objects);
      Object.assign(h.objects, {
        delete: (key: string) => (discarded.push(key), realDelete(key)),
      });
      await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'upload_in_progress' });
      expect(discarded).toEqual([]);
      await expect(h.catalog.pending('a.txt')).resolves.toMatchObject({ id: pending.id });
      Object.assign(h.objects, { head: realHead, delete: realDelete });
      release();
      await expect(saving).resolves.toMatchObject({ ok: true });
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] an object that grows between head and read is deleted, not left', async () => {
      const h = await harness();
      await h.mint('a.txt', 3);
      const pending = await h.put('a.txt', 'abcdef');
      // The store reports the declared size at head time, then serves more bytes.
      Object.assign(h.objects, {
        head: () => Promise.resolve({ sizeBytes: 3, contentType: null, etag: 'x' }),
      });
      await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'too_large' });
      await expect(h.catalog.pending('a.txt')).resolves.toBeNull();
      await expect(h.objects.read(h.nameOf(pending.objectId))).resolves.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] the link binds the length where the store can and not where it cannot', async () => {
      const binding = await harness(true);
      await binding.mint('a.txt', 3);
      expect(binding.requests[0]).toMatchObject({
        method: 'PUT',
        contentLength: 3,
        requireBoundContentLength: true,
      });
      const azure = await harness(false);
      await azure.mint('a.txt', 3);
      expect(azure.requests[0]).toMatchObject({ requireBoundContentLength: false });
    });
  });
}

defineSuite('in-memory catalog', memoryFixture);
defineSuite('PostgreSQL catalog', postgresFixture);
