/**
 * One contract suite, run against every {@link SessionStateStore} the control plane has, plus the
 * half of the durable one that is `apps/web`'s own (ENG-06, #305).
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
import { afterAll, describe, expect, it } from 'vitest';

import { createLocalFilesystemObjectStoreProvider } from '../files/object-store-bridge';
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
import { DatabaseSessionStateStore } from './state-store';

const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';
const SESSION = '11111111-2222-4333-8444-555555555555';
const REF: SessionStateStreamRef = {
  workspaceId: WORKSPACE,
  sessionId: SESSION,
  engine: 'claude-agent-sdk',
  streamKey: `${WORKSPACE}/`,
};

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
        storageKey: blob.storageKey,
        sizeBytes: blob.sizeBytes,
        sha256: blob.sha256,
      });
      return Promise.resolve();
    },
    getBlob: (sessionId, engine, blobKey) =>
      Promise.resolve(rows.get(`${sessionId}/${engine}/${blobKey}`) ?? null),
    listBlobs: () => Promise.resolve([...rows.values()]),
    // Every row this fake holds counts as expired: the cutoff itself is the repository's concern
    // and is proved against PostgreSQL in `packages/core`.
    purgeBefore: () => {
      const blobs = [...rows.values()];
      rows.clear();
      return Promise.resolve({ streams: 0, entries: 0, blobs });
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

const implementations: { name: string; open: () => SessionStateStore }[] = [
  { name: 'InMemorySessionStateStore', open: () => new InMemorySessionStateStore() },
];

describe.each(implementations)('$name — the session-state contract', ({ open }) => {
  it('tells an empty stream apart from one that was never written', async () => {
    // The distinction a resume turns on: `[]` says the session exists and has no turns yet, `null`
    // says nothing was ever stored, and only the first resumes.
    const store = open();
    await expect(store.list(REF, {})).resolves.toBeNull();
    await store.append(REF, []);
    await expect(store.list(REF, {})).resolves.toEqual([]);
  });

  it('upserts on entryKey in place, so a redelivery never reorders the stream', async () => {
    const store = open();
    await store.append(REF, [
      { entryKey: 'a', entry: { index: 0 } },
      { entryKey: 'b', entry: { index: 1 } },
    ]);
    await store.append(REF, [{ entryKey: 'a', entry: { index: 'corrected' } }]);
    await expect(store.list(REF, {})).resolves.toEqual([
      { sequence: 1, entryKey: 'a', entry: { index: 'corrected' } },
      { sequence: 2, entryKey: 'b', entry: { index: 1 } },
    ]);
  });

  it('appends every keyless entry, because one with no identity cannot be deduped', async () => {
    const store = open();
    await store.append(REF, [{ entry: { type: 'summary' } }]);
    await store.append(REF, [{ entry: { type: 'summary' } }]);
    await expect(store.list(REF, {})).resolves.toHaveLength(2);
  });

  it('numbers a stream densely from 1, and renumbers on replace-all', async () => {
    const store = open();
    await store.append(REF, [
      { entryKey: 'a', entry: {} },
      { entryKey: 'b', entry: {} },
    ]);
    await store.replaceAll(REF, [{ entryKey: 'z', entry: {} }]);
    await expect(store.list(REF, {})).resolves.toEqual([{ sequence: 1, entryKey: 'z', entry: {} }]);
  });

  it('removes exactly the last entry, and reports an empty stream as zero', async () => {
    const store = open();
    await store.append(REF, [
      { entryKey: 'a', entry: {} },
      { entryKey: 'b', entry: {} },
    ]);
    await expect(store.deleteLast(REF)).resolves.toBe(1);
    await expect(store.list(REF, {})).resolves.toEqual([{ sequence: 1, entryKey: 'a', entry: {} }]);
    await expect(store.deleteLast(REF)).resolves.toBe(1);
    await expect(store.deleteLast(REF)).resolves.toBe(0);
  });

  it('pages from a cursor', async () => {
    const store = open();
    await store.append(REF, [
      { entryKey: 'a', entry: {} },
      { entryKey: 'b', entry: {} },
      { entryKey: 'c', entry: {} },
    ]);
    await expect(store.list(REF, { afterSequence: 1, limit: 1 })).resolves.toEqual([
      { sequence: 2, entryKey: 'b', entry: {} },
    ]);
  });

  it('deleting a stream is not the same as emptying it', async () => {
    const store = open();
    await store.append(REF, [{ entryKey: 'a', entry: {} }]);
    await store.deleteStream(REF);
    await expect(store.list(REF, {})).resolves.toBeNull();
  });

  it('lists a session’s streams, newest write first', async () => {
    const store = open();
    await store.append(REF, []);
    await store.append({ ...REF, streamKey: `${WORKSPACE}/subagents/agent-1` }, []);
    const streams = await store.listStreams({ workspaceId: WORKSPACE, sessionId: SESSION });
    expect(streams.map((stream) => stream.streamKey)).toEqual([
      `${WORKSPACE}/subagents/agent-1`,
      `${WORKSPACE}/`,
    ]);
  });
});

describe('DatabaseSessionStateStore — the blob half, which is only this file’s', () => {
  it('writes the bytes before the row, so a failed row never claims a snapshot exists', async () => {
    const { store, rows, objects } = databaseStore();
    await expect(store.putBlob(BLOB, new Uint8Array([1, 2, 3]))).resolves.toEqual({ ok: true });

    const storageKey = sessionStateBlobStorageKey(BLOB);
    const object = await objects.forWorkspace(WORKSPACE).get(storageKey);
    // `Uint8Array.from`, because the local-filesystem backend hands back a Node `Buffer` — a
    // `Uint8Array` subclass that vitest's structural comparison reports as a different type.
    expect(Uint8Array.from(object?.body ?? [])).toEqual(new Uint8Array([1, 2, 3]));
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
      .put(sessionStateBlobStorageKey(BLOB), { body: new Uint8Array([9, 9, 9]) });
    await expect(store.getBlob(BLOB)).rejects.toThrow(/Refusing to replay a snapshot/u);
  });

  it('reports "no blob backend" rather than pretending to have stored something', async () => {
    const { store } = databaseStore({ blobs: false });
    const put = await store.putBlob(BLOB, new Uint8Array([1]));
    expect(put.ok).toBe(false);
    expect(put.ok ? '' : put.reason).toMatch(/AW_SESSION_TRANSCRIPT_ROOT/u);
    const read = await store.getBlob(BLOB);
    expect(read.ok).toBe(false);
  });

  it('purges a blob row and then its bytes, and reports the counts', async () => {
    const { store, objects } = databaseStore();
    await store.putBlob(BLOB, new Uint8Array([1, 2, 3]));
    await expect(store.purgeBefore(WORKSPACE, new Date())).resolves.toEqual({
      entries: 0,
      blobs: 1,
    });
    await expect(store.getBlob(BLOB)).resolves.toEqual({ ok: true, content: null });
    await expect(
      objects.forWorkspace(WORKSPACE).get(sessionStateBlobStorageKey(BLOB)),
    ).resolves.toBeNull();
  });

  it('derives the object key from values the platform produced, never from a request', () => {
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
