import {
  type SessionRecord,
  type SessionRepositoryProvider,
  type SessionStateRepository,
} from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { installTestDomains } from '../application-context-fixtures';
import { createStorageService } from '../storage/service';
import type { SessionApiPrincipal } from './environment';
import { InMemoryTranscriptStore } from './memory-store';
import { getSessionStateBlob, putSessionStateBlob } from './state-api';
import { createRepositorySessionsStoreProvider, DatabaseSessionStateStore } from './store';
import { ENGINE, BLOB_KEY, type Fixture, log } from './state-blobs.fixture.test-support';
export function createSessionBlobFixture(setup: () => Promise<Fixture>) {
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
  return {
    get harness() {
      return harness;
    },
  };
}
export type SessionBlobFixture = ReturnType<typeof createSessionBlobFixture>;
