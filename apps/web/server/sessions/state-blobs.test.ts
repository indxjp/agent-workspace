/**
 * Session state saves through the storage service (the storage design, §04): a blob's bytes go
 * under a new object ID in the `session-state` area, the row is confirmed after the write, and the
 * replaced blob's object is deleted last. Run on an in-memory repository and on PostgreSQL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  agents,
  createDatabaseSessionStateRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  createInMemorySessionStateBlobs,
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
  type SessionStateRepository,
  type SessionStateRepositoryProvider,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';
import { SESSION_STATE_BLOB_MAX_BYTES } from '@agent-workspace/engine';

import {
  generatedBody,
  MiB,
  NEW_SPACE_CREDIT_BOUND,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../../tests/load/flat-memory';

import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createStorageService } from '../storage/service';
import type { SessionApiPrincipal } from './environment';
import { InMemoryTranscriptStore } from './memory-store';
import { getSessionStateBlob, putSessionStateBlob } from './state-api';
import { createRepositorySessionsStoreProvider, DatabaseSessionStateStore } from './store';

const ENGINE = 'claude-agent-sdk' as const;
const BLOB_KEY = 'state.tar';

interface Fixture {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly repositories: SessionStateRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
}

/** The blob rows in memory (held to the database's contract); the stream half is not used here. */
function memoryFixture(): Promise<Fixture> {
  const workspaceId = crypto.randomUUID();
  const unreachable = (): never => {
    throw new Error('this suite drives only the blob half of the session-state repository');
  };
  const repository: SessionStateRepository = {
    ...createInMemorySessionStateBlobs().forWorkspace(workspaceId),
    append: unreachable,
    list: unreachable,
    deleteLast: unreachable,
    replaceAll: unreachable,
    deleteStream: unreachable,
    listStreams: unreachable,
  };
  return Promise.resolve({
    workspaceId,
    sessionId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    repositories: { forScope: () => repository },
    scopes: createInMemoryWorkspaceScopeResolver([{ id: workspaceId, slug: 'acme' }]),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_session_state_blobs');
}, 180_000);

afterAll(async () => isolated?.close());

async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'blobs' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: 'blobs',
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
    .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
  return {
    workspaceId,
    sessionId,
    principalId,
    repositories: createDatabaseSessionStateRepositoryProvider(db),
    scopes: createDatabaseWorkspaceScopeResolver(db),
  };
}

/** A body that yields `size` bytes without ever holding them, so no test buffers the cap. */
function lazyBody(size: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = Math.min(chunk.byteLength, size - sent);
      if (next === 0) controller.close();
      else controller.enqueue(chunk.subarray(0, next));
      sent += next;
    },
  });
}

const log: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
};

afterEach(() => {
  clearApplicationContext();
});

function defineSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`session state blobs on the ${name}`, () => {
    async function harness(options: { readonly objects?: ObjectStore } = {}) {
      const f = await setup();
      let confirmFails = false;
      let afterNextRowRead: (() => Promise<unknown>) | undefined;
      let beforeNextWrite: ((name: string) => Promise<unknown>) | undefined;
      let beforeDelete: ((name: string) => Promise<unknown>) | undefined;
      let deletesFail = false;
      const store = options.objects ?? createInMemoryObjectStore();
      const objects: ObjectStore = {
        ...store,
        write: async (name, body, writeOptions) => {
          const hook = beforeNextWrite;
          beforeNextWrite = undefined;
          if (hook !== undefined) await hook(name);
          return store.write(name, body, writeOptions);
        },
        delete: async (name) => {
          if (beforeDelete !== undefined) await beforeDelete(name);
          if (deletesFail) throw new Error('the object store refused the delete');
          return store.delete(name);
        },
      };
      const legacy = createInMemoryObjectStoreProvider();
      const scope = await f.scopes.forWorkspaceId(f.workspaceId);
      if (scope === null) throw new Error('the workspace did not resolve');
      const real = f.repositories.forScope(scope);
      const repository: SessionStateRepository = {
        ...real,
        confirmBlob: (pending, confirmation) => {
          if (confirmFails) {
            confirmFails = false;
            return Promise.reject(new Error('the confirm was lost'));
          }
          return real.confirmBlob(pending, confirmation);
        },
        getBlob: async (sessionId, engine, blobKey) => {
          const found = await real.getBlob(sessionId, engine, blobKey);
          const hook = afterNextRowRead;
          afterNextRowRead = undefined;
          if (hook !== undefined) await hook();
          return found;
        },
      };
      const storage = createStorageService({
        catalog: () => Promise.reject(new Error('the files catalog is not used here')),
        objects,
        sessionState: () => Promise.resolve(repository),
        log,
      });
      const stateStore = new DatabaseSessionStateStore({
        repositories: { forScope: () => repository },
        scopes: f.scopes,
        storage,
      });
      const row: SessionRecord = {
        id: f.sessionId,
        workspaceId: f.workspaceId,
        ownerPrincipalId: f.principalId,
        userId: f.principalId,
        agentId: crypto.randomUUID(),
        projectId: null,
        engineSessionId: f.sessionId,
        engine: ENGINE,
        agentVersionId: null,
        title: 'blobs',
        status: 'active',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      };
      const sessionRows: SessionRepositoryProvider = {
        forScope: () => ({
          ensure: () => Promise.resolve({ kind: 'existing', session: row }),
          get: (id) => Promise.resolve(id === row.id ? row : null),
          getByEngineSessionId: (id) => Promise.resolve(id === row.id ? row : null),
          list: () => Promise.resolve({ items: [row], nextCursor: null }),
          update: () => Promise.resolve({ kind: 'no-op', session: row }),
          archive: () => Promise.resolve({ kind: 'no-op', session: row }),
          restore: () => Promise.resolve({ kind: 'no-op', session: row }),
          discardIfUnused: () => Promise.resolve(false),
        }),
      };
      const user: SessionApiPrincipal = {
        kind: 'user',
        principalId: f.principalId,
        ownerPrincipalId: f.principalId,
        userId: f.principalId,
        workspaceId: f.workspaceId,
        role: 'builder',
      };
      const runner: SessionApiPrincipal = {
        kind: 'runner',
        workspaceId: f.workspaceId,
        runId: crypto.randomUUID(),
        sessionId: f.sessionId,
      };
      /** The routes as `principal` reaches them. */
      const as = (principal: SessionApiPrincipal) => {
        installTestDomains({
          sessions: {
            authenticate: () => Promise.resolve(principal),
            canAccessSession: (caller, id) =>
              Promise.resolve(caller.kind === 'runner' ? caller.sessionId === id : true),
            store: new InMemoryTranscriptStore(),
            stateStore,
            sessions: createRepositorySessionsStoreProvider({
              repositories: sessionRows,
              scopes: f.scopes,
            }),
          },
        });
        const url = `https://control.example/api/sessions/${f.sessionId}/state-blobs?engine=${ENGINE}&blobKey=${BLOB_KEY}`;
        return {
          put: (bytes: Uint8Array) =>
            putSessionStateBlob(
              new Request(url, { method: 'PUT', body: bytes.slice() }),
              f.sessionId,
            ),
          /** A streamed body with no Content-Length, as a chunked upload sends it. */
          putStream: (body: ReadableStream<Uint8Array>) => {
            // A variable, not a literal: the DOM `RequestInit` has no `duplex`.
            const init = { method: 'PUT', body, duplex: 'half' as const };
            return putSessionStateBlob(new Request(url, init), f.sessionId);
          },
          get: () => getSessionStateBlob(new Request(url), f.sessionId),
        };
      };
      const stored = () => repository.getBlob(f.sessionId, ENGINE, BLOB_KEY);
      const objectNames = async () => {
        const page = await objects.listPage('workspaces', { recursive: true });
        return page.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.key);
      };
      const failNextConfirm = () => {
        confirmFails = true;
      };
      /** Runs `hook` after the next row read returns and before its caller sees the row. */
      const raceNextRowRead = (hook: () => Promise<unknown>) => {
        afterNextRowRead = hook;
      };
      /** Runs `hook` before the next object write starts. */
      const raceNextWrite = (hook: (name: string) => Promise<unknown>) => {
        beforeNextWrite = hook;
      };
      /** Runs `hook` before every object delete. */
      const onDelete = (hook: (name: string) => Promise<unknown>) => {
        beforeDelete = hook;
      };
      const failDeletes = () => {
        deletesFail = true;
      };
      /** Rows a crash or a failed delete left: deleting rows, and every pending row. */
      const unsettled = () => repository.unsettledBlobs(new Date(Date.now() + 60_000));
      return {
        f,
        objects,
        legacy,
        repository,
        storage,
        stateStore,
        as,
        user,
        runner,
        stored,
        objectNames,
        failNextConfirm,
        raceNextRowRead,
        raceNextWrite,
        onDelete,
        failDeletes,
        unsettled,
      };
    }

    // @story US-STO-09
    it('[US-STO-09][api][sdk] resume restores state', async () => {
      const h = await harness();
      const api = h.as(h.user);
      const bytes = new Uint8Array([1, 2, 3, 4]);
      expect((await api.put(bytes)).status).toBe(204);

      const read = await api.get();
      expect(read.status).toBe(200);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);

      // The row names a new object ID, and the bytes are at the one name that ID makes.
      const row = await h.stored();
      expect(row?.objectId).toMatch(/^[0-9a-f-]{36}$/u);
      const name = `workspaces/${h.f.workspaceId}/session-state/${row?.objectId ?? ''}`;
      expect(row?.storageKey).toBe(name);
      await expect(h.objectNames()).resolves.toEqual([name]);
    });

    // @story US-STO-09
    it('[US-STO-09][api][run] engine resume reads state', async () => {
      const h = await harness();
      await h.as(h.user).put(new Uint8Array([9, 8, 7]));

      const read = await h.as(h.runner).get();
      expect(read.status).toBe(200);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    });

    // @story US-STO-09
    it('[US-STO-09][api][chat] resumed chat keeps its state', async () => {
      const h = await harness();
      const api = h.as(h.user);
      await api.put(new Uint8Array([1]));
      const first = (await h.stored())?.objectId;
      await api.put(new Uint8Array([2, 2]));
      const second = (await h.stored())?.objectId;

      expect(second).not.toBe(first);
      expect(new Uint8Array(await (await api.get()).arrayBuffer())).toEqual(new Uint8Array([2, 2]));
      // The replaced object went after the new row was confirmed; one object is left.
      await expect(h.objectNames()).resolves.toEqual([
        `workspaces/${h.f.workspaceId}/session-state/${second ?? ''}`,
      ]);
    });

    // @story US-STO-09
    it('[US-STO-09][api][sdk] a blob that was never written answers absent, not an error', async () => {
      const h = await harness();
      await expect(
        h.stateStore.getBlob({
          workspaceId: h.f.workspaceId,
          sessionId: h.f.sessionId,
          engine: ENGINE,
          blobKey: BLOB_KEY,
        }),
      ).resolves.toEqual({ ok: true, content: null });
    });

    // @story US-STO-09
    it('[US-STO-09][api][sdk] a resume refuses bytes that are not the ones it recorded', async () => {
      const h = await harness();
      const api = h.as(h.user);
      expect((await api.put(new Uint8Array([1, 2, 3]))).status).toBe(204);
      const [name] = await h.objectNames();
      // Somebody else wrote over the object: a recorded digest only proves something if it is checked.
      await h.objects.write(name ?? '', streamOf(new Uint8Array([9, 9, 9])), {
        contentType: 'application/octet-stream',
      });

      await expect(
        h.stateStore.getBlob({
          workspaceId: h.f.workspaceId,
          sessionId: h.f.sessionId,
          engine: ENGINE,
          blobKey: BLOB_KEY,
        }),
      ).rejects.toThrow(/Refusing to replay a snapshot/u);
    });

    // @story US-STO-09
    it('[US-STO-09][contract][sdk] a blob over the cap leaves no row and no object', async () => {
      const h = await harness();
      const refused = await h.storage.saveSessionState(
        { workspaceId: h.f.workspaceId },
        { sessionId: h.f.sessionId, engine: ENGINE, blobKey: BLOB_KEY },
        lazyBody(SESSION_STATE_BLOB_MAX_BYTES + 1),
      );

      expect(refused).toEqual({ ok: false, code: 'too_large' });
      await expect(h.stored()).resolves.toBeNull();
      await expect(h.objectNames()).resolves.toEqual([]);
    });

    // @story US-STO-09
    it('[US-STO-09][contract][sdk] a lost confirm keeps the replaced blob and its object', async () => {
      const h = await harness();
      const api = h.as(h.user);
      await api.put(new Uint8Array([1, 1]));
      const kept = await h.stored();

      // The next confirm fails: the old object is not deleted, the old row still serves.
      h.failNextConfirm();
      await expect(h.stateStore.putBlob(ref(h.f), streamOf(new Uint8Array([2])))).rejects.toThrow(
        'the confirm was lost',
      );

      expect((await h.stored())?.objectId).toBe(kept?.objectId);
      expect(new Uint8Array(await (await api.get()).arrayBuffer())).toEqual(new Uint8Array([1, 1]));
      // The confirm never committed: its reservation and the object it wrote are gone with it.
      await expect(h.objectNames()).resolves.toEqual([kept?.storageKey]);
      await expect(h.unsettled()).resolves.toEqual([]);
    });

    // @story US-STO-09
    it('[US-STO-09][contract][sdk] no doubled prefix', async () => {
      const h = await harness();
      await h.as(h.user).put(new Uint8Array([3, 3]));

      // The whole root store and the old store, so a name under any prefix shows up.
      const keys = async (store: ObjectStore) =>
        (await store.listPage('', { recursive: true })).entries.map((entry) => entry.key);
      const all = [
        ...(await keys(h.objects)),
        ...(await keys(h.legacy.forWorkspace(h.f.workspaceId))),
      ];
      expect(all).toHaveLength(1);
      for (const key of all) expect(key).not.toMatch(/session-state.*session-state/u);
    });

    // @story US-STO-09
    it('[US-STO-09][contract][sdk] a read that races a save reads the saved blob', async () => {
      const h = await harness();
      const api = h.as(h.user);
      await api.put(new Uint8Array([1]));

      // The save confirms after the read has the old row, so the object that row names is gone.
      h.raceNextRowRead(() => h.stateStore.putBlob(ref(h.f), streamOf(new Uint8Array([2, 2]))));
      const read = await h.stateStore.getBlob(ref(h.f));

      if (!read.ok || read.content === null) throw new Error('the racing read found no blob');
      expect(new Uint8Array(read.content.bytes)).toEqual(new Uint8Array([2, 2]));
      expect(read.content.sha256).toBe((await h.stored())?.sha256);
    });

    // @story US-STO-09
    it('[US-STO-09][api][run] retention deletes the row and its object', async () => {
      const h = await harness();
      await h.as(h.user).put(new Uint8Array([1]));

      await h.stateStore.purgeBefore(h.f.workspaceId, new Date(Date.now() + 60_000));

      await expect(h.stored()).resolves.toBeNull();
      await expect(h.objectNames()).resolves.toEqual([]);
      await expect(h.unsettled()).resolves.toEqual([]);
    });

    // @story US-STO-09
    it('[US-STO-09][contract][sdk] a save writes its pending row before the first byte', async () => {
      const h = await harness();
      let seen: { held: readonly string[]; served: unknown; objectId: string } | undefined;
      h.raceNextWrite(async (name) => {
        const objectId = name.split('/').at(-1) ?? '';
        const held = await h.repository.referencedObjectIds([objectId]);
        seen = { held, served: await h.stored(), objectId };
      });

      expect((await h.as(h.user).put(new Uint8Array([4, 2]))).status).toBe(204);

      // The object was held by a row before it was written, and that row was not served yet.
      expect(seen?.held).toEqual([seen?.objectId]);
      expect(seen?.served).toBeNull();
      expect((await h.stored())?.objectId).toBe(seen?.objectId);
      await expect(h.unsettled()).resolves.toEqual([]);
    });

    // @story US-STO-09
    it('[US-STO-09][contract][run] a reservation purged during the write is not confirmed and leaves nothing', async () => {
      const h = await harness();
      h.raceNextWrite(() =>
        h.stateStore.purgeBefore(h.f.workspaceId, new Date(Date.now() + 60_000)),
      );

      await expect(h.stateStore.putBlob(ref(h.f), streamOf(new Uint8Array([7])))).rejects.toThrow(
        /reservation/u,
      );

      await expect(h.stored()).resolves.toBeNull();
      await expect(h.objectNames()).resolves.toEqual([]);
      await expect(h.unsettled()).resolves.toEqual([]);
    });

    // @story US-STO-09
    it('[US-STO-09][api][run] retention marks a blob deleting before its bytes go', async () => {
      const h = await harness();
      await h.as(h.user).put(new Uint8Array([1]));
      const saved = await h.stored();
      const atDelete: { served: unknown; unsettled: unknown }[] = [];
      h.onDelete(async () => {
        atDelete.push({ served: await h.stored(), unsettled: await h.unsettled() });
      });

      await h.stateStore.purgeBefore(h.f.workspaceId, new Date(Date.now() + 60_000));

      expect(atDelete).toEqual([
        {
          served: null,
          unsettled: [expect.objectContaining({ status: 'deleting', objectId: saved?.objectId })],
        },
      ]);
      await expect(h.unsettled()).resolves.toEqual([]);
    });

    // @story US-STO-09
    it('[US-STO-09][api][run] a failed delete during retention keeps the row deleting for the cleanup job', async () => {
      const h = await harness();
      await h.as(h.user).put(new Uint8Array([1]));
      const saved = await h.stored();
      h.failDeletes();

      await h.stateStore.purgeBefore(h.f.workspaceId, new Date(Date.now() + 60_000));

      await expect(h.stored()).resolves.toBeNull();
      await expect(h.unsettled()).resolves.toEqual([
        expect.objectContaining({ status: 'deleting', objectId: saved?.objectId }),
      ]);
      await expect(h.objectNames()).resolves.toEqual([saved?.storageKey]);
    });

    // @story US-STO-09
    it('[US-STO-09][load][sdk] a PUT at the cap streams to the store and keeps memory growth under 16 MiB', async () => {
      const size = SESSION_STATE_BLOB_MAX_BYTES;
      const inner = createInMemoryObjectStore();
      let sample: () => void = () => undefined;
      // Drains the body instead of keeping it, so what the window reads is the route, the store
      // and the service, not the test's own object store.
      const h = await harness({
        objects: {
          ...inner,
          write: async (_key, body) => {
            let seen = 0;
            if (body instanceof Uint8Array) {
              seen = body.byteLength;
            } else {
              for await (const chunk of body) {
                const before = seen;
                seen += chunk.byteLength;
                if (Math.floor(seen / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
              }
            }
            return {
              sizeBytes: seen,
              contentType: null,
              etag: 'drained',
              lastModified: new Date(),
            };
          },
        },
      });
      const api = h.as(h.user);

      // Built before each baseline: the generator's 16 MiB ring is the source, not the route.
      let source = generatedBody(size);
      await warmHttpTransport();
      const streamed = await peakRssGrowth(async (sampled) => {
        sample = sampled;
        const response = await api.putStream(source.body);
        expect(response.status, await response.clone().text()).toBe(204);
      });
      expect(streamed).toBeLessThan(16 * MiB);
      expect(await h.stored()).toMatchObject({ sizeBytes: size, sha256: await source.sha256 });

      // One byte over the cap, with no Content-Length to refuse it early: 413, and nothing kept.
      const over = await api.putStream(generatedBody(size + 1).body);
      expect(over.status).toBe(413);
      expect(await h.stored()).toMatchObject({ sizeBytes: size });
      await expect(h.unsettled()).resolves.toEqual([]);

      // Negative control: buffering a body whole, as the route did, must read high. It is larger
      // than the blob by NEW_SPACE_CREDIT_BOUND, the RSS a reading may credit.
      const controlSize = size + NEW_SPACE_CREDIT_BOUND;
      source = generatedBody(controlSize);
      const buffered = await peakRssGrowth(async (sampled) => {
        const init = { method: 'PUT', body: source.body, duplex: 'half' as const };
        const read = await new Request('https://example.invalid/state-blobs', init).arrayBuffer();
        sampled();
        expect(read.byteLength).toBe(controlSize);
      });
      expect(buffered).toBeGreaterThanOrEqual(16 * MiB);
    }, 120_000);
  });
}

function ref(f: Fixture) {
  return {
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    engine: ENGINE,
    blobKey: BLOB_KEY,
  } as const;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([new Uint8Array(bytes)]).stream();
}

defineSuite('in-memory repository', memoryFixture);
defineSuite('PostgreSQL repository', postgresFixture);
