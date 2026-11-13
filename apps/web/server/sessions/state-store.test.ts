import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createInMemorySessionStateBlobs,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import type {
  SessionStateRepository,
  SessionStateRepositoryProvider,
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
} from '@agent-workspace/core/storage';
import {
  parseBlobKey,
  parseEngineId,
  parsePageLimit,
  parseSequenceCursor,
  parseSessionStateEntries,
  parseStreamKey,
  type SessionStateStore,
} from './state';
import { InMemorySessionStateStore } from './state-memory-store';
import { DatabaseSessionStateStore } from './store';
import { describeSessionStateStoreConformance } from './state-store.conformance.test-support';
const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';

const SESSION = '11111111-2222-4333-8444-555555555555';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fakeRepositoryProvider(): {
  provider: SessionStateRepositoryProvider;
  repository: SessionStateRepository;
} {
  const unreachable = (): never => {
    throw new Error('this suite drives only the blob half of the database store');
  };
  const repository: SessionStateRepository = {
    ...createInMemorySessionStateBlobs().forWorkspace(WORKSPACE),
    append: () => unreachable(),
    list: () => unreachable(),
    deleteLast: () => unreachable(),
    replaceAll: () => unreachable(),
    deleteStream: () => unreachable(),
    listStreams: () => unreachable(),
  };
  return { provider: { forScope: () => repository }, repository };
}

function databaseStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'aw-session-state-'));
  roots.push(root);
  const { provider, repository } = fakeRepositoryProvider();
  const objects = createLocalFilesystemObjectStoreProvider(root);
  const store = new DatabaseSessionStateStore({
    repositories: provider,
    scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
  });
  return { store, repository, objects };
}

const BLOB = {
  workspaceId: WORKSPACE,
  sessionId: SESSION,
  engine: 'claude-agent-sdk',
  blobKey: 'state.tar',
} as const;

describeSessionStateStoreConformance('InMemorySessionStateStore — the session-state contract', () =>
  Promise.resolve({
    store: new InMemorySessionStateStore(),
    workspaceA: crypto.randomUUID(),
    workspaceB: crypto.randomUUID(),
    session: () => Promise.resolve(crypto.randomUUID()),
  }),
);

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

  describeSessionStateStoreConformance(
    'over a real PostgreSQL, against the same suite',
    async () => {
      const a = await workspace(isolated);
      const b = await workspace(isolated);
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
  // @story US-STO-13
  it('[US-STO-13][unit][cli] a blob is never saved without the storage service', async () => {
    const h = databaseStore();

    const put = await h.store.putBlob(BLOB, bytesToStream(new Uint8Array([1, 2, 3])));

    if (put.ok || !('reason' in put)) throw new Error('the blob was not refused as unavailable');
    // Both causes are named: the variable may be set while the storage service failed to open.
    expect(put.reason).toMatch(/AW_STORAGE_URL is not set/u);
    expect(put.reason).toMatch(/storage service failed to open/u);
    await expect(h.repository.listBlobs(SESSION)).resolves.toEqual([]);
    await expect(h.repository.unsettledBlobs(new Date(Date.now() + 60_000))).resolves.toEqual([]);
    await expect(
      h.objects
        .forWorkspace(WORKSPACE)
        .head(`session-state/${SESSION}/${BLOB.engine}/${BLOB.blobKey}`),
    ).resolves.toBeNull();
  });

  it('reports "no blob backend" rather than pretending to have stored something', async () => {
    const { store } = databaseStore();
    const put = await store.putBlob(BLOB, bytesToStream(new Uint8Array([1])));
    if (put.ok || !('reason' in put)) throw new Error('the blob was not refused as unavailable');
    expect(put.reason).toMatch(/AW_STORAGE_URL/u);
    const read = await store.getBlob(BLOB);
    expect(read.ok).toBe(false);
  });
});

describe('parsing — every rejection is by name, and the last arm rejects (ADR-0015)', () => {
  registerStateKeyParserTests();
  registerStateEntryParserTests();
});

async function workspace(
  isolated: IsolatedTestDatabase,
): Promise<{ id: string; session: () => Promise<string> }> {
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

function registerStateKeyParserTests() {
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
}
function registerStateEntryParserTests() {
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
}
