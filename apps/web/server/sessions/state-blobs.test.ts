/**
 * Session state saves through the storage service (the storage design, §04): a blob's bytes go
 * under a new object ID in the `session-state` area, the row is confirmed after the write, and the
 * replaced blob's object is deleted last. Run on an in-memory repository and on PostgreSQL.
 */
import { createHash } from 'node:crypto';

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
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
  type SessionStateRepository,
  type SessionStateRepositoryProvider,
  type StoredSessionStateBlob,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStoreV2,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';
import { SESSION_STATE_BLOB_MAX_BYTES } from '@agent-workspace/engine';

import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createStorageService } from '../storage/service';
import type { SessionApiPrincipal } from './environment';
import { InMemoryTranscriptStore } from './memory-store';
import { getSessionStateBlob, putSessionStateBlob } from './state-api';
import { createRepositorySessionsStoreProvider, DatabaseSessionStateStore } from './store';

const ENGINE = 'claude-agent-sdk';
const BLOB_KEY = 'state.tar';

interface Fixture {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly repositories: SessionStateRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
}

/** The blob half of the repository, in memory; the stream half is not used here. */
function memoryFixture(): Promise<Fixture> {
  const workspaceId = crypto.randomUUID();
  const rows = new Map<string, StoredSessionStateBlob>();
  const unreachable = (): never => {
    throw new Error('this suite drives only the blob half of the session-state repository');
  };
  const repository: SessionStateRepository = {
    append: unreachable,
    list: unreachable,
    deleteLast: unreachable,
    replaceAll: unreachable,
    deleteStream: unreachable,
    listStreams: unreachable,
    putBlob: (sessionId, blob) => {
      const id = `${sessionId}/${blob.engine}/${blob.blobKey}`;
      const previous = rows.get(id);
      rows.set(id, {
        blobKey: blob.blobKey,
        objectId: blob.objectId ?? null,
        storageKey: blob.storageKey,
        sizeBytes: blob.sizeBytes,
        sha256: blob.sha256,
      });
      return Promise.resolve({
        replaced:
          previous === undefined
            ? null
            : { objectId: previous.objectId, storageKey: previous.storageKey },
      });
    },
    getBlob: (sessionId, engine, blobKey) =>
      Promise.resolve(rows.get(`${sessionId}/${engine}/${blobKey}`) ?? null),
    listBlobs: () => Promise.resolve([...rows.values()]),
    listLegacyBlobs: unreachable,
    countLegacyBlobs: unreachable,
    listObjectBlobs: unreachable,
    legacyBlobKeysHeld: unreachable,
    switchBlobObject: unreachable,
    referencedObjectIds: (ids) =>
      Promise.resolve(ids.filter((id) => [...rows.values()].some((row) => row.objectId === id))),
    purgeBefore: () => {
      const blobs = [...rows.values()];
      rows.clear();
      return Promise.resolve({ streams: 0, entries: 0, blobs, sessionIds: [] });
    },
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
    async function harness() {
      const f = await setup();
      let confirmFails = false;
      let afterNextRowRead: (() => Promise<unknown>) | undefined;
      const objects = createInMemoryObjectStore();
      const legacy = createInMemoryObjectStoreProvider();
      const scope = await f.scopes.forWorkspaceId(f.workspaceId);
      if (scope === null) throw new Error('the workspace did not resolve');
      const real = f.repositories.forScope(scope);
      const repository: SessionStateRepository = {
        ...real,
        putBlob: (sessionId, blob) => {
          if (confirmFails) {
            confirmFails = false;
            return Promise.reject(new Error('the confirm was lost'));
          }
          return real.putBlob(sessionId, blob);
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
        legacy: { 'session-state': legacy },
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
    it('[US-STO-09][api][sdk] a blob row without an object ID still resumes, and a save moves it', async () => {
      const h = await harness();
      const oldKey = `session-state/${h.f.sessionId}/${ENGINE}/${BLOB_KEY}`;
      const bytes = new Uint8Array([5, 5, 5]);
      await h.legacy
        .forWorkspace(h.f.workspaceId)
        .write(oldKey, streamOf(bytes), { contentType: 'application/octet-stream' });
      await h.repository.putBlob(h.f.sessionId, {
        engine: ENGINE,
        blobKey: BLOB_KEY,
        storageKey: oldKey,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const api = h.as(h.user);

      expect(new Uint8Array(await (await api.get()).arrayBuffer())).toEqual(bytes);

      await api.put(new Uint8Array([6]));
      await expect(h.legacy.forWorkspace(h.f.workspaceId).head(oldKey)).resolves.toBeNull();
      expect((await h.stored())?.objectId).not.toBeNull();
      expect(new Uint8Array(await (await api.get()).arrayBuffer())).toEqual(new Uint8Array([6]));
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
      await expect(h.stateStore.putBlob(ref(h.f), new Uint8Array([2]))).rejects.toThrow(
        'the confirm was lost',
      );

      expect((await h.stored())?.objectId).toBe(kept?.objectId);
      expect(new Uint8Array(await (await api.get()).arrayBuffer())).toEqual(new Uint8Array([1, 1]));
      const names = await h.objectNames();
      expect(names).toContain(kept?.storageKey);
    });

    // @story US-STO-09
    it('[US-STO-09][contract][sdk] no doubled prefix', async () => {
      const h = await harness();
      await h.as(h.user).put(new Uint8Array([3, 3]));

      // The whole root store and the old store, so a name under any prefix shows up.
      const keys = async (store: ObjectStoreV2) =>
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
      h.raceNextRowRead(() => h.stateStore.putBlob(ref(h.f), new Uint8Array([2, 2])));
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
    });
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
