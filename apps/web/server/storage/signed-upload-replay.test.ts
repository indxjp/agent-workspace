/**
 * #1991 UPLOAD-1: a signed `PUT` stays usable until it expires, so the object it names must never
 * be the one a ready row publishes. Each case replays the link (a write to the very key it was
 * signed for) after the upload was published and checks the file still reads as its checksum
 * says. The link is simulated on the real in-memory object store; the catalog is the in-memory
 * one and PostgreSQL. `files/presign.network.test.ts` replays a real S3 link.
 */
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createInMemorySessionStateBlobs,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import type { CatalogPort, ResourceCatalogRepository } from '@agent-workspace/core/db';
import { createInMemoryObjectStore, type ObjectStore } from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { CLEANUP_MIN_AGE_MS, runCleanupPass } from './cleanup';
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
  isolated = await createIsolatedTestDatabase('aw_storage_upload_replay');
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
      await db.insert(workspaces).values({ id, slug: `s-${id}`, name: 'upload replay' });
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
const sha256Of = (text: string) => createHash('sha256').update(text).digest('hex');

type Wrap<T> = (inner: T) => T;

/** Past the age guard, so the cleanup job settles pending rows and sweeps orphans. */
const later = () => new Date(Date.now() + CLEANUP_MIN_AGE_MS * 2);

function defineSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`a replayed upload link on the ${name}`, () => {
    async function harness(
      wrap: { readonly objects?: Wrap<ObjectStore>; readonly catalog?: Wrap<CatalogPort> } = {},
    ) {
      const f = await setup();
      const ws = await f.workspace();
      const inner = createInMemoryObjectStore();
      /** The keys a `PUT` link was signed for: what a replay can write. */
      const signedPuts = new Map<string, string>();
      const signing: ObjectStore = {
        ...inner,
        capabilities: { ...inner.capabilities, sign: true, boundLengthSign: true },
        createSignedUrl: (key, request) => {
          const url = `https://store.invalid/${crypto.randomUUID()}`;
          if (request.method === 'PUT') signedPuts.set(url, key);
          return Promise.resolve({ url, headers: {} });
        },
      };
      const objects = wrap.objects?.(signing) ?? signing;
      const catalogOf = async (workspaceId: string) => {
        const real = await f.catalog(workspaceId);
        return wrap.catalog?.(real) ?? real;
      };
      const storage = createStorageService({ catalog: catalogOf, objects, log: noLog });
      const ctx: StorageContext = { workspaceId: ws.id, principalId: ws.principalId, userId: null };
      const catalog = await f.catalog(ws.id);
      /** Mint a link for `path` and `PUT` `text` through it; the link is returned for a replay. */
      const upload = async (path: string, text: string) => {
        const minted = await storage.reserveUpload(ctx, {
          path,
          sizeBytes: bytesOf(text).length,
          mayReplace: () => Promise.resolve(true),
        });
        if (!minted.ok) throw new Error(`mint refused: ${minted.code}`);
        const url = minted.url.url;
        await replay(url, text);
        return url;
      };
      /** What a `PUT` to a still-valid link does: overwrite the key it was signed for. */
      const replay = async (url: string, text: string) => {
        const key = signedPuts.get(url);
        if (key === undefined) throw new Error('no such link');
        await inner.write(key, bytesOf(text), { contentType: null });
      };
      const complete = (path: string, maxBytes = 1024) =>
        storage.completeUpload(ctx, { path, maxBytes });
      /** The ready file's bytes, read the way a download does. */
      const download = async (path: string) => {
        const row = await storage.get(ctx, 'files', path);
        if (row === null) throw new Error(`${path} is not a ready file`);
        const stream = await storage.open(ctx, row);
        if (stream === null) throw new Error(`${path} has no object`);
        return { row, text: await new Response(stream.body).text() };
      };
      /** Every object in the store, as the orphan sweep would list it. */
      const objectKeys = async () =>
        (await inner.listPage('workspaces', { recursive: true })).entries.map((e) => e.key);
      const cleanup = (now: Date) =>
        runCleanupPass({
          objects,
          catalogs: catalogOf,
          sessionState: (id) => Promise.resolve(createInMemorySessionStateBlobs().forWorkspace(id)),
          workspaceIds: () => Promise.resolve([ws.id]),
          now: () => now,
          mode: 'delete',
          log: noLog,
        });
      const all = { ctx, catalog, storage, signedPuts, upload, replay, complete, download };
      return { ...all, objectKeys, cleanup };
    }

    /** The file reads as its checksum says, from an object no link was signed for. */
    async function expectIntact(
      h: Awaited<ReturnType<typeof harness>>,
      path: string,
      text: string,
    ) {
      const { row, text: read } = await h.download(path);
      expect(read).toBe(text);
      expect(row.sha256).toBe(sha256Of(text));
      const own = (await h.objectKeys()).filter((key) => key.endsWith(`/${row.objectId ?? ''}`));
      expect(own).toHaveLength(1);
      expect([...h.signedPuts.values()]).not.toContain(own[0]);
    }

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a link replayed after complete cannot change the ready file', async () => {
      const h = await harness();
      const url = await h.upload('a.txt', 'good');
      await expect(h.complete('a.txt')).resolves.toMatchObject({ ok: true });

      await h.replay(url, 'evil');

      await expectIntact(h, 'a.txt', 'good');
      // A retried complete answers the published file again.
      await expect(h.complete('a.txt')).resolves.toMatchObject({ ok: true });
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a link replayed after the cleanup job completed it cannot change the file, and the sweep removes its residue', async () => {
      const h = await harness();
      const url = await h.upload('a.txt', 'good');
      await expect(h.cleanup(later())).resolves.toMatchObject({ stalePendingReady: 1 });

      await h.replay(url, 'evil');

      await expectIntact(h, 'a.txt', 'good');
      // The replay re-created the ingress object; no row names it, so the sweep takes it.
      await expect(h.cleanup(later())).resolves.toMatchObject({ orphans: 1, deleted: 1 });
      await expectIntact(h, 'a.txt', 'good');
      expect(await h.objectKeys()).toHaveLength(1);
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a confirm that commits, loses its reply and is renamed keeps the published file', async () => {
      let renameOnConfirm = true;
      const h = await harness({
        catalog: (inner) => ({
          ...inner,
          confirm: async (row, input) => {
            const done = await inner.confirm(row, input);
            if (!renameOnConfirm) return done;
            renameOnConfirm = false;
            await inner.rename('a.txt', 'b.txt');
            throw new Error('reply lost');
          },
        }),
      });
      const url = await h.upload('a.txt', 'good');
      await expect(h.complete('a.txt')).rejects.toThrow('reply lost');

      await h.replay(url, 'evil');

      await expectIntact(h, 'b.txt', 'good');
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] a failed copy keeps the upload pending, leaves no copy and can be retried', async () => {
      let failCopy = true;
      const h = await harness({
        objects: (inner) => ({
          ...inner,
          write: async (key, body, options) => {
            if (!failCopy) return inner.write(key, body, options);
            failCopy = false;
            // The bytes landed, the reply did not.
            await inner.write(key, body, options);
            throw new Error('store unavailable');
          },
        }),
      });
      const url = await h.upload('a.txt', 'good');
      const ingress = [...h.signedPuts.values()];

      await expect(h.complete('a.txt')).rejects.toThrow('store unavailable');
      await expect(h.catalog.pending('a.txt')).resolves.not.toBeNull();
      expect(await h.objectKeys()).toEqual(ingress);

      await expect(h.complete('a.txt')).resolves.toMatchObject({ ok: true });
      await h.replay(url, 'evil');
      await expectIntact(h, 'a.txt', 'good');
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] an object that grows after its HEAD is refused as too large though the store wraps the error', async () => {
      const grown = new Set<string>();
      const h = await harness({
        objects: (inner) => ({
          ...inner,
          head: async (key) => {
            const meta = await inner.head(key);
            // The link is used again between the HEAD and the copy.
            if (meta !== null && !grown.has(key)) {
              grown.add(key);
              await inner.write(key, bytesOf('good and then some'), { contentType: null });
            }
            return meta;
          },
          write: (key, body, options) =>
            inner.write(key, body, options).catch((error: unknown) => {
              throw new Error('provider stream failed', { cause: error });
            }),
        }),
      });
      await h.upload('a.txt', 'good');

      await expect(h.complete('a.txt')).resolves.toEqual({ ok: false, code: 'too_large' });
      await expect(h.catalog.get('a.txt', { includePending: true })).resolves.toBeNull();
      expect(await h.objectKeys()).toEqual([]);
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] complete racing the cleanup job publishes one copy and leaves no other object', async () => {
      // The pass's clock: the row is long stale, while every object it lists was written at its
      // `now`, so its sweep never takes a copy still in flight for an orphan.
      const now = later();
      // Both promotions reach `confirm` with their copy written; the second to arrive commits
      // first, so the first always loses and must remove its own copy.
      let arrivals = 0;
      let bothArrived = () => {};
      const arrived = new Promise<void>((resolve) => (bothArrived = resolve));
      let winnerDone = () => {};
      const won = new Promise<void>((resolve) => (winnerDone = resolve));
      const h = await harness({
        objects: (inner) => ({
          ...inner,
          listPage: async (prefix, options) => {
            const page = await inner.listPage(prefix, options);
            return { ...page, entries: page.entries.map((e) => ({ ...e, lastModified: now })) };
          },
        }),
        catalog: (inner) => ({
          ...inner,
          confirm: async (row, input) => {
            arrivals += 1;
            if (arrivals === 1) {
              await arrived;
              await won;
              return inner.confirm(row, input);
            }
            bothArrived();
            try {
              return await inner.confirm(row, input);
            } finally {
              winnerDone();
            }
          },
        }),
      });
      const url = await h.upload('a.txt', 'good');

      const [completed, report] = await Promise.all([h.complete('a.txt'), h.cleanup(now)]);
      expect(completed).toMatchObject({ ok: true });
      expect(report).toMatchObject({ orphans: 0, deleted: 0 });
      expect(arrivals).toBe(2);

      await h.replay(url, 'evil');
      await expectIntact(h, 'a.txt', 'good');
      // Only the published copy and the replay's ingress object; the losing copy is gone.
      expect(await h.objectKeys()).toHaveLength(2);
    });

    // @story US-STO-02
    it('[US-STO-02][unit][sdk] complete racing a rename of the replaced file publishes the copy at one path', async () => {
      const h = await harness();
      await h.upload('a.txt', 'old!');
      await expect(h.complete('a.txt')).resolves.toMatchObject({ ok: true });
      const url = await h.upload('a.txt', 'good');

      const [, renamed] = await Promise.all([
        h.complete('a.txt'),
        h.storage.rename(h.ctx, 'files', 'a.txt', 'b.txt'),
      ]);

      await h.replay(url, 'evil');
      const at = renamed.ok ? 'b.txt' : 'a.txt';
      await expectIntact(h, at, 'good');
      await expect(h.storage.get(h.ctx, 'files', at === 'a.txt' ? 'b.txt' : 'a.txt')).resolves.toBe(
        null,
      );
    });
  });
}

defineSuite('in-memory catalog', memoryFixture);
defineSuite('PostgreSQL catalog', postgresFixture);
