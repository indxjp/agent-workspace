import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { sessions } from '../schema/sessions.js';
import { sessionStateBlobs } from '../schema/session-state-blobs.js';
import { sessionStateEntries } from '../schema/session-state-entries.js';
import { sessionStateStreams } from '../schema/session-state-streams.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import {
  createDatabaseSessionStateRepositoryProvider,
  type SessionStateStreamKey,
} from './session-state.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/**
 * The engine-scoped session store, against real PostgreSQL (ENG-06, #305).
 *
 * What is being checked is the set of properties #305's acceptance criteria name, each against the
 * database rather than against a fake: idempotency by `entry_key`, delete-last, replace-all, the
 * tenant boundary, and the cascade from a deleted session.
 */
describe.skipIf(!hasDatabase)('SessionStateRepository', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const deletableSessionId = crypto.randomUUID();

  const key = (streamKey: string, id = sessionId): SessionStateStreamKey => ({
    sessionId: id,
    engine: 'claude-agent-sdk',
    streamKey,
  });

  async function repository() {
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scope = await resolver.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseSessionStateRepositoryProvider(isolated.db).forScope(scope);
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_session_state');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'State workspace' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other workspace' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'State owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'State agent',
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
    await isolated.db.insert(sessions).values([
      { id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId },
      { id: deletableSessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId },
    ]);
  }, 180_000);

  afterAll(async () => isolated.close());

  it('distinguishes an empty stream from a stream that was never written', async () => {
    const store = await repository();
    const stream = key('empty/');
    await expect(store.list(stream, {})).resolves.toBeNull();
    await store.append(stream, []);
    await expect(store.list(stream, {})).resolves.toEqual([]);
  });

  it('upserts on entry_key in place, so a redelivery never reorders the stream', async () => {
    const store = await repository();
    const stream = key('idempotent/');
    await store.append(stream, [
      { entryKey: 'a', entry: { type: 'user', index: 0 } },
      { entryKey: 'b', entry: { type: 'assistant', index: 1 } },
    ]);
    await store.append(stream, [{ entryKey: 'a', entry: { type: 'user', index: 'corrected' } }]);

    const entries = await store.list(stream, {});
    expect(entries).toEqual([
      { sequence: 1, entryKey: 'a', entry: { type: 'user', index: 'corrected' } },
      { sequence: 2, entryKey: 'b', entry: { type: 'assistant', index: 1 } },
    ]);
    // One row per key, proved against the table rather than against the read: a fold that happened
    // only on the way out would satisfy the assertion above and still grow without bound.
    const rows = await isolated.db.select().from(sessionStateEntries);
    expect(rows.filter((row) => row.streamKey === 'idempotent/')).toHaveLength(2);
  });

  it('stores a mastra stream beside a claude one, since migration 0031 widened the engine CHECK', async () => {
    // ENG-10 (#309, ADR-0084): before 0031 the `session_state_*` CHECKs admitted three engines and
    // this insert failed with a constraint violation, so it is the regression test for the widening.
    const store = await repository();
    const mastra: SessionStateStreamKey = { sessionId, engine: 'mastra', streamKey: 'mastra/' };
    await store.append(mastra, [
      { entryKey: 'thread', entry: { type: 'mastra.thread', thread: { id: sessionId } } },
    ]);
    await expect(store.list(mastra, {})).resolves.toEqual([
      {
        sequence: 1,
        entryKey: 'thread',
        entry: { type: 'mastra.thread', thread: { id: sessionId } },
      },
    ]);
    await expect(store.list(key('mastra/'), {})).resolves.toBeNull();
  });

  it('appends every keyless entry, because an entry with no identity cannot be deduped', async () => {
    const store = await repository();
    const stream = key('keyless/');
    await store.append(stream, [{ entry: { type: 'summary' } }]);
    await store.append(stream, [{ entry: { type: 'summary' } }]);
    await expect(store.list(stream, {})).resolves.toHaveLength(2);
  });

  it('serialises concurrent appends and keeps the sequence dense', async () => {
    const store = await repository();
    const stream = key('concurrent/');
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.append(stream, [{ entryKey: `u-${String(index)}`, entry: { type: 'user', index } }]),
      ),
    );
    const entries = await store.list(stream, {});
    expect(entries?.map((entry) => entry.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it('pages from a cursor', async () => {
    const store = await repository();
    const stream = key('paged/');
    await store.append(stream, [
      { entryKey: 'p1', entry: { type: 'user' } },
      { entryKey: 'p2', entry: { type: 'assistant' } },
      { entryKey: 'p3', entry: { type: 'user' } },
    ]);
    await expect(store.list(stream, { afterSequence: 1, limit: 1 })).resolves.toEqual([
      { sequence: 2, entryKey: 'p2', entry: { type: 'assistant' } },
    ]);
  });

  it('removes exactly the last entry, and reports an empty stream as zero', async () => {
    const store = await repository();
    const stream = key('pop/');
    await store.append(stream, [
      { entryKey: 'x', entry: { type: 'user' } },
      { entryKey: 'y', entry: { type: 'assistant' } },
    ]);
    await expect(store.deleteLast(stream)).resolves.toBe(1);
    await expect(store.list(stream, {})).resolves.toEqual([
      { sequence: 1, entryKey: 'x', entry: { type: 'user' } },
    ]);
    await expect(store.deleteLast(stream)).resolves.toBe(1);
    await expect(store.deleteLast(stream)).resolves.toBe(0);
  });

  it('replaces every entry with exactly the ones given, renumbered from 1', async () => {
    const store = await repository();
    const stream = key('replace/');
    await store.append(stream, [{ entryKey: 'old', entry: { type: 'user' } }]);
    await store.replaceAll(stream, [{ entryKey: 'new', entry: { type: 'system' } }]);
    await expect(store.list(stream, {})).resolves.toEqual([
      { sequence: 1, entryKey: 'new', entry: { type: 'system' } },
    ]);
  });

  it('lists the streams of one session and not another session’s', async () => {
    const store = await repository();
    await store.append(key('listed/a'), []);
    await store.append(key('listed/b'), []);
    await store.append(key('listed/c', deletableSessionId), []);
    const streams = await store.listStreams(sessionId);
    const listed = streams.map((stream) => stream.streamKey);
    expect(listed).toContain('listed/a');
    expect(listed).toContain('listed/b');
    expect(listed).not.toContain('listed/c');
  });

  it('keeps one workspace’s state unreachable from another’s scope', async () => {
    const store = await repository();
    await store.append(key('tenant/'), [{ entryKey: 't', entry: { type: 'user' } }]);
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const otherScope = await resolver.forWorkspaceId(otherWorkspaceId);
    if (otherScope === null) throw new Error('other workspace did not resolve');
    const other = createDatabaseSessionStateRepositoryProvider(isolated.db).forScope(otherScope);
    // The same session id, read through another tenant's scope: `null`, not the entries. The
    // `where` clause is built from the scope inside the repository, so there is no parameter at
    // which the filter could have been forgotten (spec §25).
    await expect(other.list(key('tenant/'), {})).resolves.toBeNull();
    await expect(other.listStreams(sessionId)).resolves.toEqual([]);
  });

  it('records a blob and reads its location and digest back', async () => {
    const store = await repository();
    await store.putBlob(sessionId, {
      engine: 'claude-agent-sdk',
      blobKey: 'state.tar',
      storageKey: `session-state/${sessionId}/claude-agent-sdk/state.tar`,
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
    });
    await store.putBlob(sessionId, {
      engine: 'claude-agent-sdk',
      blobKey: 'state.tar',
      storageKey: `session-state/${sessionId}/claude-agent-sdk/state.tar`,
      sizeBytes: 4,
      sha256: 'b'.repeat(64),
    });
    await expect(store.getBlob(sessionId, 'claude-agent-sdk', 'state.tar')).resolves.toEqual({
      blobKey: 'state.tar',
      storageKey: `session-state/${sessionId}/claude-agent-sdk/state.tar`,
      sizeBytes: 4,
      sha256: 'b'.repeat(64),
    });
    await expect(store.getBlob(sessionId, 'claude-agent-sdk', 'absent')).resolves.toBeNull();
  });

  it('purges streams, entries and blobs last written before the cutoff, and nothing newer', async () => {
    const store = await repository();
    await store.append(key('retained/'), [{ entryKey: 'r', entry: { type: 'user' } }]);
    await store.append(key('expired/'), [
      { entryKey: 'e1', entry: { type: 'user' } },
      { entryKey: 'e2', entry: { type: 'assistant' } },
    ]);
    await store.putBlob(sessionId, {
      engine: 'claude-agent-sdk',
      blobKey: 'expired.tar',
      storageKey: `session-state/${sessionId}/claude-agent-sdk/expired.tar`,
      sizeBytes: 1,
      sha256: 'd'.repeat(64),
    });
    const longAgo = new Date('2000-01-01T00:00:00Z');
    await isolated.db
      .update(sessionStateStreams)
      .set({ updatedAt: longAgo })
      .where(
        and(
          eq(sessionStateStreams.workspaceId, workspaceId),
          eq(sessionStateStreams.streamKey, 'expired/'),
        ),
      );
    await isolated.db
      .update(sessionStateBlobs)
      .set({ updatedAt: longAgo })
      .where(
        and(
          eq(sessionStateBlobs.workspaceId, workspaceId),
          eq(sessionStateBlobs.blobKey, 'expired.tar'),
        ),
      );

    const purged = await store.purgeBefore(new Date('2001-01-01T00:00:00Z'));
    expect(purged).toEqual({
      streams: 1,
      entries: 2,
      blobs: [
        {
          blobKey: 'expired.tar',
          storageKey: `session-state/${sessionId}/claude-agent-sdk/expired.tar`,
          sizeBytes: 1,
          sha256: 'd'.repeat(64),
        },
      ],
    });
    await expect(store.list(key('expired/'), {})).resolves.toBeNull();
    await expect(store.list(key('retained/'), {})).resolves.toHaveLength(1);
    await expect(store.getBlob(sessionId, 'claude-agent-sdk', 'expired.tar')).resolves.toBeNull();
    await expect(store.getBlob(sessionId, 'claude-agent-sdk', 'state.tar')).resolves.not.toBeNull();
  });

  it('cascades every stream, entry and blob when the session is deleted', async () => {
    const store = await repository();
    await store.append(key('cascade/', deletableSessionId), [
      { entryKey: 'c', entry: { type: 'user' } },
    ]);
    await store.putBlob(deletableSessionId, {
      engine: 'claude-agent-sdk',
      blobKey: 'state.tar',
      storageKey: 'session-state/x',
      sizeBytes: 1,
      sha256: 'c'.repeat(64),
    });
    await isolated.db.delete(sessions).where(eq(sessions.id, deletableSessionId));
    await expect(store.listStreams(deletableSessionId)).resolves.toEqual([]);
    await expect(store.listBlobs(deletableSessionId)).resolves.toEqual([]);
    await expect(store.list(key('cascade/', deletableSessionId), {})).resolves.toBeNull();
  });
});
