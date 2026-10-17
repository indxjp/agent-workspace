/**
 * The pure predicate and the gate over a fake repository — fast, no database.
 *
 * This file deliberately does NOT claim the call sites are gated: proving a predicate correct in
 * isolation is exactly the mistake `docs/adr/W9-WS-119-run-gate-module-and-project-sessions.md`
 * finding 2 records, where deleting the two lines that *called* the predicate left every test
 * green. `archive-gate-integration.test.ts` beside this file drives the closures `register()`
 * installs; this one only fixes what those closures are supposed to answer.
 */
import type {
  EnsureSessionInput,
  ProjectRecord,
  SessionRepository,
} from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import {
  createProjectRunGate,
  guardProjectSessionCreation,
  isProjectUsableForNewWork,
} from './archive-gate';

const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const BUILDER_PRINCIPAL_ID = '66666666-6666-4666-8666-666666666666';

function project(id: string, archivedAt: Date | null): ProjectRecord {
  return {
    id,
    workspaceId: WORKSPACE,
    name: `Project ${id}`,
    instructions: null,
    defaultAgentId: null,
    defaultModelConnectionId: null,
    defaultModel: null,
    visibility: 'private',
    createdBy: 'builder@example.test',
    ownerPrincipalId: BUILDER_PRINCIPAL_ID,
    archivedAt,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const ROWS = new Map<string, ProjectRecord>([
  ['active', project('active', null)],
  ['archived', project('archived', new Date('2026-09-13T00:00:00.000Z'))],
]);

const gate = createProjectRunGate({ get: (id) => Promise.resolve(ROWS.get(id) ?? null) });

describe('isProjectUsableForNewWork', () => {
  it('accepts an active project and refuses an archived one', () => {
    expect(isProjectUsableForNewWork(ROWS.get('active')!)).toBe(true);
    expect(isProjectUsableForNewWork(ROWS.get('archived')!)).toBe(false);
  });

  it('refuses a project this workspace cannot resolve, like the workspace gate does', () => {
    expect(isProjectUsableForNewWork(null)).toBe(false);
  });
});

describe('createProjectRunGate', () => {
  it('answers from the repository row, and treats "no project" as usable', async () => {
    expect(await gate.isUsableForNewWork('active')).toBe(true);
    expect(await gate.isUsableForNewWork('archived')).toBe(false);
    expect(await gate.isUsableForNewWork('nonexistent')).toBe(false);
    // A session started outside `/api/projects/:id/sessions` belongs to no project at all; that
    // is not work in an archived one, and refusing it would stop every ordinary run.
    expect(await gate.isUsableForNewWork(null)).toBe(true);
  });
});

describe('guardProjectSessionCreation', () => {
  function spyRepository(): { calls: EnsureSessionInput[]; sessions: SessionRepository } {
    const calls: EnsureSessionInput[] = [];
    const sessions = {
      ensure: (input: EnsureSessionInput) => {
        calls.push(input);
        return Promise.resolve({
          kind: 'unknown-principal' as const,
          principalId: input.ownerPrincipalId,
        });
      },
      get: () => Promise.resolve(null),
      getByEngineSessionId: () => Promise.reject(new Error('unused')),
      list: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      archive: () => Promise.reject(new Error('unused')),
      restore: () => Promise.reject(new Error('unused')),
    } satisfies SessionRepository;
    return { calls, sessions };
  }

  it('refuses ensure for an archived project without reaching the repository', async () => {
    const { calls, sessions } = spyRepository();
    const outcome = await guardProjectSessionCreation(sessions, gate).ensure({
      id: 'session-1',
      agentId: 'agent-1',
      userId: 'builder@example.test',
      ownerPrincipalId: BUILDER_PRINCIPAL_ID,
      projectId: 'archived',
    });
    expect(outcome).toEqual({
      kind: 'unknown-principal',
      principalId: BUILDER_PRINCIPAL_ID,
    });
    expect(calls).toEqual([]);
  });

  it('passes an active project and a project-less session straight through', async () => {
    const { calls, sessions } = spyRepository();
    const guarded = guardProjectSessionCreation(sessions, gate);
    await guarded.ensure({
      id: 'session-2',
      agentId: 'agent-1',
      userId: 'builder@example.test',
      ownerPrincipalId: BUILDER_PRINCIPAL_ID,
      projectId: 'active',
    });
    await guarded.ensure({
      id: 'session-3',
      agentId: 'agent-1',
      userId: 'builder@example.test',
      ownerPrincipalId: BUILDER_PRINCIPAL_ID,
    });
    expect(calls.map((call) => call.id)).toEqual(['session-2', 'session-3']);
  });

  it('leaves every method but ensure untouched — archiving does not close existing work', async () => {
    const { sessions } = spyRepository();
    const guarded = guardProjectSessionCreation(sessions, gate);
    expect(await guarded.get('anything')).toBeNull();
  });
});
