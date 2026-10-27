/**
 * The session-state store conformance suite — **one suite, every implementation of the port**
 * ({@link describeSessionStateStoreConformance}) — plus the half of the durable store that is
 * `apps/web`'s own (ENG-06, #305; W3-4). It runs against the in-memory store always, and against
 * {@link DatabaseSessionStateStore} over a real PostgreSQL whenever `TEST_DATABASE_URL` names one.
 *
 * The shape is `./store.test.ts`'s, and the reason is the one it gives: two implementations tested
 * by two suites are two contracts, and the durable one is the one nobody runs locally. The rules
 * here are not this repository's inventions — they are what a resume needs — so a store that breaks
 * one produces a resume that silently loses a turn rather than an error anybody sees.
 *
 * Two things this file deliberately does **not** cover, because something else does and saying so
 * is cheaper than covering them twice (ADR-0031):
 *
 *   * the PostgreSQL store's own SQL — sequencing, the advisory lock, the cascade — is
 *     `packages/core/src/db/repositories/session-state.test.ts`, against a real database;
 *   * the routes over either store are `./state-api.test.ts`.
 *
 * What is only here is {@link DatabaseSessionStateStore}'s **blob** half: the object-store write,
 * the order it happens in, and the digest check on the way out. None of that is the repository's,
 * and none of it is the route's.
 */
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import type {
  SessionStateBlobInput,
  SessionStateRepository,
  SessionStateRepositoryProvider,
  StoredSessionStateBlob,
} from '@agent-workspace/core/db';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bytesToStream,
  createLocalFilesystemObjectStoreProvider,
  streamToBytes,
} from '@agent-workspace/core/storage';
import {
  parseBlobKey,
  parseEngineId,
  parsePageLimit,
  parseSequenceCursor,
  parseSessionStateEntries,
  parseStreamKey,
  sessionStateBlobStorageKey,
  type SessionStateStore,
  type SessionStateStreamRef,
} from './state';
import { InMemorySessionStateStore } from './state-memory-store';
import { DatabaseSessionStateStore, SESSION_STATE_PAGE_LIMIT } from './store';

const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';
const SESSION = '11111111-2222-4333-8444-555555555555';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A repository that keeps rows in memory.
 *
 * Only the blob half is used below; the stream half throws, so a case that reached it by accident
 * fails loudly instead of quietly testing the wrong store (ADR-0015).
 */
function fakeRepositoryProvider(): {
  provider: SessionStateRepositoryProvider;
  rows: Map<string, StoredSessionStateBlob>;
} {
  const rows = new Map<string, StoredSessionStateBlob>();
  const unreachable = (): never => {
    throw new Error('this suite drives only the blob half of the database store');
  };
  const repository: SessionStateRepository = {
    append: () => unreachable(),
    list: () => unreachable(),
    deleteLast: () => unreachable(),
    replaceAll: () => unreachable(),
    deleteStream: () => unreachable(),
    listStreams: () => unreachable(),
    putBlob: (sessionId: string, blob: SessionStateBlobInput) => {
      rows.set(`${sessionId}/${blob.engine}/${blob.blobKey}`, {
        blobKey: blob.blobKey,
        objectId: blob.objectId ?? null,
        storageKey: blob.storageKey,
        sizeBytes: blob.sizeBytes,
        sha256: blob.sha256,
      });
      return Promise.resolve({ replaced: null });
    },
    getBlob: (sessionId, engine, blobKey) =>
      Promise.resolve(rows.get(`${sessionId}/${engine}/${blobKey}`) ?? null),
    listBlobs: () => Promise.resolve([...rows.values()]),
    listLegacyBlobs: () => unreachable(),
    countLegacyBlobs: () => unreachable(),
    listObjectBlobs: () => unreachable(),
    legacyBlobKeysHeld: () => unreachable(),
    switchBlobObject: () => unreachable(),
    referencedObjectIds: () => Promise.resolve([]),
    // Every row this fake holds counts as expired: the cutoff itself is the repository's concern
    // and is proved against PostgreSQL in `packages/core`.
    purgeBefore: () => {
      const blobs = [...rows.values()];
      rows.clear();
      return Promise.resolve({ streams: 0, entries: 0, blobs, sessionIds: [] });
    },
  };
  return { provider: { forScope: () => repository }, rows };
}

function databaseStore(options: { readonly blobs?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'aw-session-state-'));
  roots.push(root);
  const { provider, rows } = fakeRepositoryProvider();
  const objects = createLocalFilesystemObjectStoreProvider(root);
  const store = new DatabaseSessionStateStore({
    repositories: provider,
    scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
    ...((options.blobs ?? true) ? { blobs: objects } : {}),
  });
  return { store, rows, objects };
}

const BLOB = {
  workspaceId: WORKSPACE,
  sessionId: SESSION,
  engine: 'claude-agent-sdk',
  blobKey: 'state.tar',
} as const;

/** What the conformance suite needs: a store, two workspaces, and a way to make a session in one. */
export interface SessionStateStoreFixture {
  readonly store: SessionStateStore;
  readonly workspaceA: string;
  readonly workspaceB: string;
  /** A new platform session in `workspaceId` (the durable store's rows hang off a `sessions` row). */
  readonly session: (workspaceId: string) => Promise<string>;
}

export type MakeSessionStateStoreFixture = () => Promise<SessionStateStoreFixture>;

const ENGINE = 'claude-agent-sdk';

/** Run the conformance suite against a fixture factory, called once per test. */
export function describeSessionStateStoreConformance(
  label: string,
  makeFixture: MakeSessionStateStoreFixture,
): void {
  async function setUp() {
    const fixture = await makeFixture();
    const sessionId = await fixture.session(fixture.workspaceA);
    const at = (streamKey: string, engine: SessionStateStreamRef['engine'] = ENGINE) =>
      ({ workspaceId: fixture.workspaceA, sessionId, engine, streamKey }) as const;
    return { ...fixture, sessionId, ref: at(`${fixture.workspaceA}/`), at };
  }

  describe(label, () => {
    it('tells an empty stream apart from one that was never written', async () => {
      // The distinction a resume turns on: `[]` says the session exists and has no turns yet, `null`
      // says nothing was ever stored, and only the first resumes.
      const { store, ref } = await setUp();
      await expect(store.list(ref, {})).resolves.toBeNull();
      await store.append(ref, []);
      await expect(store.list(ref, {})).resolves.toEqual([]);
    });

    it('upserts on entryKey in place, so a redelivery never reorders the stream', async () => {
      const { store, ref } = await setUp();
      await store.append(ref, [
        { entryKey: 'a', entry: { index: 0 } },
        { entryKey: 'b', entry: { index: 1 } },
      ]);
      await store.append(ref, [{ entryKey: 'a', entry: { index: 'corrected' } }]);
      await expect(store.list(ref, {})).resolves.toEqual([
        { sequence: 1, entryKey: 'a', entry: { index: 'corrected' } },
        { sequence: 2, entryKey: 'b', entry: { index: 1 } },
      ]);
    });

    it('appends every keyless entry, because one with no identity cannot be deduped', async () => {
      const { store, ref } = await setUp();
      await store.append(ref, [{ entry: { type: 'summary' } }]);
      await store.append(ref, [{ entry: { type: 'summary' } }]);
      await expect(store.list(ref, {})).resolves.toEqual([
        { sequence: 1, entryKey: null, entry: { type: 'summary' } },
        { sequence: 2, entryKey: null, entry: { type: 'summary' } },
      ]);
    });

    it('returns entries in append order, deep-equal to what was appended', async () => {
      const { store, ref } = await setUp();
      const entry = { usage: { n: 3, ratio: 0.25, flag: true, none: null }, list: [1, 'x'] };
      await store.append(ref, [{ entryKey: 'z', entry }]);
      await store.append(ref, [{ entryKey: 'a', entry: {} }]);
      const listed = await store.list(ref, {});
      expect(listed?.map((one) => one.entryKey)).toEqual(['z', 'a']);
      expect(listed?.[0]?.entry).toEqual(entry);
    });

    it('numbers a stream densely from 1, and renumbers on replace-all', async () => {
      const { store, ref } = await setUp();
      await store.append(ref, [
        { entryKey: 'a', entry: {} },
        { entryKey: 'b', entry: {} },
      ]);
      await store.replaceAll(ref, [{ entryKey: 'z', entry: {} }]);
      await expect(store.list(ref, {})).resolves.toEqual([
        { sequence: 1, entryKey: 'z', entry: {} },
      ]);
    });

    it('creates the stream on replace-all, even with nothing to put in it', async () => {
      const { store, ref } = await setUp();
      await store.replaceAll(ref, []);
      await expect(store.list(ref, {})).resolves.toEqual([]);
    });

    it('removes exactly the last entry, and reports an empty or unknown stream as zero', async () => {
      const { store, ref, at } = await setUp();
      await expect(store.deleteLast(at('never-written'))).resolves.toBe(0);
      await store.append(ref, [
        { entryKey: 'a', entry: {} },
        { entryKey: 'b', entry: {} },
      ]);
      await expect(store.deleteLast(ref)).resolves.toBe(1);
      await expect(store.list(ref, {})).resolves.toEqual([
        { sequence: 1, entryKey: 'a', entry: {} },
      ]);
      await expect(store.deleteLast(ref)).resolves.toBe(1);
      await expect(store.deleteLast(ref)).resolves.toBe(0);
      // Emptied is not deleted.
      await expect(store.list(ref, {})).resolves.toEqual([]);
    });

    it('keeps sequences dense when an append follows a deleteLast', async () => {
      const { store, ref } = await setUp();
      await store.append(ref, [
        { entryKey: 'a', entry: {} },
        { entryKey: 'b', entry: {} },
      ]);
      await store.deleteLast(ref);
      await store.append(ref, [{ entryKey: 'c', entry: {} }]);
      const listed = await store.list(ref, {});
      expect(listed?.map((one) => [one.sequence, one.entryKey])).toEqual([
        [1, 'a'],
        [2, 'c'],
      ]);
    });

    describe('paging', () => {
      it('pages from a cursor', async () => {
        const { store, ref } = await setUp();
        await store.append(ref, [
          { entryKey: 'a', entry: {} },
          { entryKey: 'b', entry: {} },
          { entryKey: 'c', entry: {} },
        ]);
        await expect(store.list(ref, { afterSequence: 1, limit: 1 })).resolves.toEqual([
          { sequence: 2, entryKey: 'b', entry: {} },
        ]);
        await expect(store.list(ref, { afterSequence: 3 })).resolves.toEqual([]);
      });

      it('caps a page at SESSION_STATE_PAGE_LIMIT, whether or not a larger limit is asked for', async () => {
        const { store, ref } = await setUp();
        const total = SESSION_STATE_PAGE_LIMIT + 3;
        await store.append(
          ref,
          Array.from({ length: total }, (_, index) => ({
            entryKey: `k${String(index)}`,
            entry: {},
          })),
        );
        await expect(store.list(ref, {})).resolves.toHaveLength(SESSION_STATE_PAGE_LIMIT);
        await expect(
          store.list(ref, { limit: SESSION_STATE_PAGE_LIMIT * 5 }),
        ).resolves.toHaveLength(SESSION_STATE_PAGE_LIMIT);
        // The cursor continues exactly where the capped page stopped.
        const rest = await store.list(ref, { afterSequence: SESSION_STATE_PAGE_LIMIT });
        expect(rest?.map((one) => one.sequence)).toEqual([total - 2, total - 1, total]);
      });
    });

    it('deleting a stream is not the same as emptying it, and is idempotent', async () => {
      const { store, ref, at } = await setUp();
      await store.append(ref, [{ entryKey: 'a', entry: {} }]);
      await store.deleteStream(ref);
      await expect(store.list(ref, {})).resolves.toBeNull();
      await expect(store.deleteStream(ref)).resolves.toBeUndefined();
      await expect(store.deleteStream(at('never-written'))).resolves.toBeUndefined();
    });

    it('lists a session’s streams, newest write first, and none for an unknown session', async () => {
      const { store, ref, at, workspaceA, sessionId, session } = await setUp();
      const sub = at(`${workspaceA}/subagents/agent-1`);
      await store.append(ref, []);
      await store.append(sub, []);
      const streams = await store.listStreams({ workspaceId: workspaceA, sessionId });
      expect(streams.map((stream) => stream.streamKey)).toEqual([sub.streamKey, ref.streamKey]);
      // A write moves a stream to the front.
      await store.append(ref, [{ entryKey: 'a', entry: {} }]);
      const after = await store.listStreams({ workspaceId: workspaceA, sessionId });
      expect(after.map((stream) => stream.streamKey)).toEqual([ref.streamKey, sub.streamKey]);
      const other = await session(workspaceA);
      await expect(
        store.listStreams({ workspaceId: workspaceA, sessionId: other }),
      ).resolves.toEqual([]);
    });

    describe('isolation', () => {
      it('keeps two streams of one session, and two engines under one key, apart', async () => {
        const { store, ref, at } = await setUp();
        const pi = at(ref.streamKey, 'pi');
        await store.append(ref, [{ entryKey: 'a', entry: { from: 'claude' } }]);
        await store.append(at('other'), [{ entryKey: 'a', entry: { from: 'other' } }]);
        await expect(store.list(pi, {})).resolves.toBeNull();
        await store.append(pi, [{ entryKey: 'a', entry: { from: 'pi' } }]);
        await expect(store.list(ref, {})).resolves.toEqual([
          { sequence: 1, entryKey: 'a', entry: { from: 'claude' } },
        ]);
        await store.deleteStream(pi);
        await expect(store.list(ref, {})).resolves.toHaveLength(1);
        await expect(store.list(at('other'), {})).resolves.toHaveLength(1);
      });

      it('never lets another workspace read, write, delete or list a stream', async () => {
        const { store, ref, sessionId, workspaceA, workspaceB } = await setUp();
        await store.append(ref, [{ entryKey: 'a', entry: { secret: true } }]);
        const asB = { ...ref, workspaceId: workspaceB };
        await expect(store.list(asB, {})).resolves.toBeNull();
        await expect(store.deleteLast(asB)).resolves.toBe(0);
        await expect(store.listStreams({ workspaceId: workspaceB, sessionId })).resolves.toEqual(
          [],
        );
        await store.deleteStream(asB);
        await expect(store.list(ref, {})).resolves.toEqual([
          { sequence: 1, entryKey: 'a', entry: { secret: true } },
        ]);
        await expect(
          store.listStreams({ workspaceId: workspaceA, sessionId }),
        ).resolves.toHaveLength(1);
      });
    });

    describe('text PostgreSQL cannot store', () => {
      const unstorable = [
        ['a NUL character', { message: { content: [{ text: 'a\u0000b' }] } }],
        ['a NUL character in a key', { meta: { 'a\u0000b': 1 } }],
        ['a lone surrogate', { message: { content: 'a\ud800b' } }],
      ] as const;

      it.each(unstorable)(
        'refuses an append carrying %s, and keeps none of the batch',
        async (_name, bad) => {
          const { store, ref } = await setUp();
          await expect(
            store.append(ref, [
              { entryKey: 'fine', entry: {} },
              { entryKey: 'bad', entry: bad },
            ]),
          ).rejects.toThrow();
          // All or nothing, and a refused first write does not even create the stream.
          await expect(store.list(ref, {})).resolves.toBeNull();
        },
      );

      it.each(unstorable)(
        'refuses a replace-all carrying %s, and keeps what was there',
        async (_name, bad) => {
          const { store, ref } = await setUp();
          await store.append(ref, [{ entryKey: 'kept', entry: {} }]);
          await expect(
            store.replaceAll(ref, [
              { entryKey: 'new', entry: {} },
              { entryKey: 'bad', entry: bad },
            ]),
          ).rejects.toThrow();
          await expect(store.list(ref, {})).resolves.toEqual([
            { sequence: 1, entryKey: 'kept', entry: {} },
          ]);
        },
      );

      it('stores a well-formed surrogate pair and the escaped text of a NUL verbatim', async () => {
        const { store, ref } = await setUp();
        const entry = { text: '😀 \\u0000 literal' };
        await store.append(ref, [{ entryKey: 'ok', entry }]);
        await expect(store.list(ref, {})).resolves.toEqual([
          { sequence: 1, entryKey: 'ok', entry },
        ]);
      });
    });
  });
}

// ── Implementation 1: memory ────────────────────────────────────────────────────────────────

describeSessionStateStoreConformance('InMemorySessionStateStore — the session-state contract', () =>
  Promise.resolve({
    store: new InMemorySessionStateStore(),
    workspaceA: crypto.randomUUID(),
    workspaceB: crypto.randomUUID(),
    session: () => Promise.resolve(crypto.randomUUID()),
  }),
);

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[sessions/state-store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half ' +
      'of this conformance suite did NOT run. A green result without it says nothing about whether ' +
      'the database-backed session-state store satisfies the same contract as the in-memory one.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL session-state store', () => {
  let isolated: IsolatedTestDatabase;
  let store: SessionStateStore;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w34_session_state_store');
    store = new DatabaseSessionStateStore({
      repositories: createDatabaseSessionStateRepositoryProvider(isolated.db),
      scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
    });
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  /** A workspace with an owner and an agent, which is what a platform session hangs off. */
  async function workspace(): Promise<{ id: string; session: () => Promise<string> }> {
    const id = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({ id, slug: id, name: `Workspace ${id}` });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId: id,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId: id,
      name: 'Conformance agent',
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
    return {
      id,
      async session() {
        const sessionId = crypto.randomUUID();
        await isolated.db.insert(sessions).values({
          id: sessionId,
          workspaceId: id,
          userId,
          ownerPrincipalId: principalId,
          agentId,
        });
        return sessionId;
      },
    };
  }

  describeSessionStateStoreConformance(
    'over a real PostgreSQL, against the same suite',
    async () => {
      const a = await workspace();
      const b = await workspace();
      return {
        store,
        workspaceA: a.id,
        workspaceB: b.id,
        session: (workspaceId) => (workspaceId === a.id ? a.session() : b.session()),
      };
    },
  );
});

describe('DatabaseSessionStateStore — the blob half, which is only this file’s', () => {
  it('writes the bytes before the row, so a failed row never claims a snapshot exists', async () => {
    const { store, rows, objects } = databaseStore();
    await expect(store.putBlob(BLOB, new Uint8Array([1, 2, 3]))).resolves.toEqual({ ok: true });

    const storageKey = sessionStateBlobStorageKey(BLOB);
    const object = await objects.forWorkspace(WORKSPACE).read(storageKey);
    // `Uint8Array.from`, because the local-filesystem backend hands back a Node `Buffer` — a
    // `Uint8Array` subclass that vitest's structural comparison reports as a different type.
    expect(Uint8Array.from(object === null ? [] : await streamToBytes(object.body))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    // The row records where the bytes are and what they were, never the bytes themselves.
    const recorded = rows.get(`${SESSION}/claude-agent-sdk/state.tar`);
    expect(recorded).toMatchObject({ blobKey: 'state.tar', storageKey, sizeBytes: 3 });
    expect(recorded?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('round-trips a snapshot and reports the digest it recorded', async () => {
    const { store } = databaseStore();
    await store.putBlob(BLOB, new Uint8Array([7, 7, 7, 7]));
    const read = await store.getBlob(BLOB);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Uint8Array.from(read.content?.bytes ?? [])).toEqual(new Uint8Array([7, 7, 7, 7]));
    expect(read.content?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('answers a blob that was never written as absent, not as an error', async () => {
    const { store } = databaseStore();
    await expect(store.getBlob(BLOB)).resolves.toEqual({ ok: true, content: null });
  });

  it('refuses to hand back bytes that are not the ones it recorded', async () => {
    const { store, objects } = databaseStore();
    await store.putBlob(BLOB, new Uint8Array([1, 2, 3]));
    // Somebody else wrote over the object. A recorded digest that is only ever *reported* proves
    // nothing about the bytes a caller was handed; it is the check that makes the claim.
    await objects
      .forWorkspace(WORKSPACE)
      .write(sessionStateBlobStorageKey(BLOB), bytesToStream(new Uint8Array([9, 9, 9])), {
        contentType: 'application/octet-stream',
      });
    await expect(store.getBlob(BLOB)).rejects.toThrow(/Refusing to replay a snapshot/u);
  });

  it('reports "no blob backend" rather than pretending to have stored something', async () => {
    const { store } = databaseStore({ blobs: false });
    const put = await store.putBlob(BLOB, new Uint8Array([1]));
    expect(put.ok).toBe(false);
    expect(put.ok ? '' : put.reason).toMatch(/AW_STORAGE_URL/u);
    const read = await store.getBlob(BLOB);
    expect(read.ok).toBe(false);
  });

  it('purges a blob row and then its bytes, and reports the counts', async () => {
    const { store, objects } = databaseStore();
    await store.putBlob(BLOB, new Uint8Array([1, 2, 3]));
    await expect(store.purgeBefore(WORKSPACE, new Date())).resolves.toEqual({
      entries: 0,
      blobs: 1,
      sessionIds: [],
    });
    await expect(store.getBlob(BLOB)).resolves.toEqual({ ok: true, content: null });
    await expect(
      objects.forWorkspace(WORKSPACE).head(sessionStateBlobStorageKey(BLOB)),
    ).resolves.toBeNull();
  });

  it('derives the old-naming object key from values the platform produced, never from a request', () => {
    expect(sessionStateBlobStorageKey(BLOB)).toBe(
      `session-state/${SESSION}/claude-agent-sdk/state.tar`,
    );
  });
});

describe('parsing — every rejection is by name, and the last arm rejects (ADR-0015)', () => {
  it('accepts the engine ids this platform knows and refuses the rest', () => {
    expect(parseEngineId('claude-agent-sdk')).toEqual({ ok: true, value: 'claude-agent-sdk' });
    expect(parseEngineId('pi')).toEqual({ ok: true, value: 'pi' });
    expect(parseEngineId('mastra')).toEqual({ ok: true, value: 'mastra' });
    expect(parseEngineId('acp').ok).toBe(false);
    expect(parseEngineId(7).ok).toBe(false);
  });

  it.each([
    ['the empty string', ''],
    ['a control character', 'w1/\n'],
    ['a non-ASCII byte', 'w1/é'],
    ['something that is not a string', 7],
  ])('refuses a stream key that is %s', (_name, value) => {
    expect(parseStreamKey(value).ok).toBe(false);
  });

  it('accepts the two shapes the Claude adapter produces', () => {
    expect(parseStreamKey('w1/').ok).toBe(true);
    expect(parseStreamKey('w1/subagents/agent-1').ok).toBe(true);
  });

  it.each([
    ['a traversal', '../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash', 'a\\b'],
    ['the empty string', ''],
  ])('refuses a blob key that is %s', (_name, value) => {
    expect(parseBlobKey(value).ok).toBe(false);
  });

  it('accepts a blob key with an extension and a nested segment', () => {
    expect(parseBlobKey('state.tar').ok).toBe(true);
    expect(parseBlobKey('snapshots/2026-09-28.tar.gz').ok).toBe(true);
  });

  it('parses a cursor before comparing it', () => {
    // `Number('7x')` is NaN and `NaN < 0` is false, so a check written the other way round reads a
    // malformed cursor as valid and pages from somewhere the caller did not ask for.
    expect(parseSequenceCursor(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseSequenceCursor('0')).toEqual({ ok: true, value: 0 });
    expect(parseSequenceCursor('7x').ok).toBe(false);
    expect(parseSequenceCursor('-1').ok).toBe(false);
    expect(parsePageLimit('0').ok).toBe(false);
    expect(parsePageLimit('25')).toEqual({ ok: true, value: 25 });
  });

  it('refuses a batch that names one key twice, rather than choosing between them', () => {
    const refused = parseSessionStateEntries([
      { entryKey: 'a', entry: {} },
      { entryKey: 'a', entry: {} },
    ]);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.reason).toMatch(/appears twice/u);
  });

  it('stores an entry verbatim, including fields the platform has never heard of', () => {
    const parsed = parseSessionStateEntries([{ entry: { type: 'user', anUnknownField: [1, 2] } }]);
    expect(parsed).toEqual({
      ok: true,
      value: [{ entry: { type: 'user', anUnknownField: [1, 2] } }],
    });
  });
});
