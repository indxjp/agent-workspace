/**
 * Unit tests for `createRunGate` and `guardSessionCreation` against fakes — no database, no
 * `register()`. These prove the two exported factories are internally correct in isolation;
 * `run-gate-integration.test.ts` beside this file is what proves `register.ts`'s call sites still
 * invoke them (see that file's header for why a unit test alone cannot make that second claim).
 *
 * ## Why this file exists (verification round 2, finding 2)
 *
 * `run-gate.ts`'s own header claimed `createRunGate` is "tested directly with a fake `{ get }` in
 * `run-gate.test.ts`" when no such file existed — this file makes that claim true rather than
 * removing it, because `createRunGate` and `guardSessionCreation` are otherwise exercised only
 * through the (correct, but heavier) database-backed integration suite.
 */
import { describe, expect, it } from 'vitest';

import type {
  EnsureSessionOutcome,
  SessionMutationOutcome,
  SessionRecord,
  SessionRepository,
} from '@agent-workspace/core/db';

import { createRunGate, guardSessionCreation, isWorkspaceUsableForRuns } from './run-gate';

const OWNER_PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';

/** A minimal, fully-typed `WorkspaceRecord` fixture — only `archivedAt` varies across tests. */
function fakeWorkspace(archivedAt: Date | null) {
  return {
    id: 'w1',
    slug: 'w1',
    name: 'Workspace 1',
    publicSharingEnabled: false,
    archivedAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('createRunGate', () => {
  it('is usable when the repository returns an unarchived workspace', async () => {
    const gate = createRunGate({ get: () => Promise.resolve(fakeWorkspace(null)) });
    expect(await gate.isUsable('w1')).toBe(true);
  });

  it('is not usable when the repository returns an archived workspace', async () => {
    const gate = createRunGate({ get: () => Promise.resolve(fakeWorkspace(new Date())) });
    expect(await gate.isUsable('w1')).toBe(false);
  });

  it('is not usable when the repository returns null (the workspace is gone)', async () => {
    const gate = createRunGate({ get: () => Promise.resolve(null) });
    expect(await gate.isUsable('missing')).toBe(false);
  });

  it('passes the workspace id it was given straight to the repository', async () => {
    const seen: string[] = [];
    const gate = createRunGate({
      get: (workspaceId: string) => {
        seen.push(workspaceId);
        return Promise.resolve(fakeWorkspace(null));
      },
    });
    await gate.isUsable('w-specific');
    expect(seen).toEqual(['w-specific']);
  });
});

describe('isWorkspaceUsableForRuns', () => {
  it('agrees with createRunGate on all three shapes', () => {
    expect(isWorkspaceUsableForRuns({ archivedAt: null })).toBe(true);
    expect(isWorkspaceUsableForRuns({ archivedAt: new Date() })).toBe(false);
    expect(isWorkspaceUsableForRuns(null)).toBe(false);
  });
});

describe('guardSessionCreation', () => {
  const fakeSessionRecord: SessionRecord = {
    engine: null,
    agentVersionId: null,
    id: 's1',
    workspaceId: 'w1',
    agentId: 'a1',
    userId: 'u1',
    ownerPrincipalId: OWNER_PRINCIPAL_ID,
    projectId: null,
    engineSessionId: null,
    title: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const notFound: SessionMutationOutcome = { kind: 'not-found' };

  function fakeSessions(): SessionRepository & { created: number } {
    const fake = {
      created: 0,
      ensure(): Promise<EnsureSessionOutcome> {
        fake.created += 1;
        return Promise.resolve({ kind: 'created', session: fakeSessionRecord });
      },
      get: () => Promise.resolve(null),
      getByEngineSessionId: () => Promise.resolve(null),
      list: () => Promise.resolve({ items: [], nextCursor: null }),
      update: () => Promise.resolve(notFound),
      archive: () => Promise.resolve(notFound),
      restore: () => Promise.resolve(notFound),
    };
    return fake;
  }

  it('delegates ensure to the real repository when the gate says usable', async () => {
    const sessions = fakeSessions();
    const gate = { isUsable: () => Promise.resolve(true) };
    const guarded = guardSessionCreation(sessions, 'w1', gate);

    const outcome = await guarded.ensure({
      id: 's1',
      agentId: 'a1',
      userId: 'u1',
      ownerPrincipalId: OWNER_PRINCIPAL_ID,
    });

    expect(outcome.kind).toBe('created');
    expect(sessions.created).toBe(1);
  });

  it('refuses ensure without touching the real repository when the gate says not usable', async () => {
    const sessions = fakeSessions();
    const gate = { isUsable: () => Promise.resolve(false) };
    const guarded = guardSessionCreation(sessions, 'w1', gate);

    const outcome = await guarded.ensure({
      id: 's1',
      agentId: 'a1',
      userId: 'u1',
      ownerPrincipalId: OWNER_PRINCIPAL_ID,
    });

    expect(outcome).toEqual({
      kind: 'unknown-principal',
      principalId: OWNER_PRINCIPAL_ID,
    });
    expect(sessions.created).toBe(0);
  });

  it('passes every other method through untouched, regardless of gate state', async () => {
    const sessions = fakeSessions();
    const gate = { isUsable: () => Promise.resolve(false) };
    const guarded = guardSessionCreation(sessions, 'w1', gate);

    expect(await guarded.get('s1')).toBeNull();
    expect(await guarded.list({ visibility: { kind: 'all' } })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await guarded.update('s1', {})).kind).toBe('not-found');
    expect((await guarded.archive('s1')).kind).toBe('not-found');
    expect((await guarded.restore('s1')).kind).toBe('not-found');
  });
});
