import crypto from 'node:crypto';

import { afterAll, beforeAll, expect } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider, type RunRepository } from './runs.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

export const CALL = { toolName: 'send_email', canonicalCall: '{"to":"a@example.test"}' } as const;

export const READ_ONLY = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

export type RunsApprovalFixture = ReturnType<typeof createRunsApprovalFixture>;

async function resolveScope(isolated: IsolatedTestDatabase, workspaceId: string) {
  const resolved = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
    workspaceId,
  );
  if (resolved === null) throw new Error('fixture workspace did not resolve');
  return resolved;
}

/** The fixture workspace, its owner and their membership principal, and the agent its sessions use. */
async function seedOwnedWorkspace(
  isolated: IsolatedTestDatabase,
  ids: { workspaceId: string; userId: string; principalId: string; agentId: string },
): Promise<void> {
  const { workspaceId, userId, principalId, agentId } = ids;
  const membershipId = crypto.randomUUID();
  await isolated.db
    .insert(workspaces)
    .values({ id: workspaceId, slug: workspaceId, name: 'Approvals' });
  await isolated.db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await isolated.db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  await isolated.db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: 'Approval agent',
    instructions: '',
    ownerPrincipalId: principalId,
    createdBy: userId,
    permissions: READ_ONLY,
  });
}

/** A second, empty workspace and the run repository scoped to it. */
async function otherWorkspaceRepository(
  isolated: IsolatedTestDatabase,
): Promise<{ workspaceId: string; repository: RunRepository }> {
  const otherWorkspaceId = crypto.randomUUID();
  await isolated.db
    .insert(workspaces)
    .values({ id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Elsewhere' });
  const otherScope = await resolveScope(isolated, otherWorkspaceId);
  return {
    workspaceId: otherWorkspaceId,
    repository: createDatabaseRunRepositoryProvider(isolated.db).forScope(otherScope),
  };
}

/** One workspace with an owner and an agent, and seeders for runs in its sessions. */
export function createRunsApprovalFixture() {
  let isolated: IsolatedTestDatabase;
  let scope: WorkspaceScope;
  let repository: RunRepository;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();

  async function seedSession(): Promise<string> {
    const id = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    return id;
  }

  /** A running run in a fresh session. */
  async function seedRunning(): Promise<{ runId: string; sessionId: string }> {
    const sessionId = await seedSession();
    const runId = crypto.randomUUID();
    const created = await repository.create({ id: runId, sessionId, engine: 'claude-agent-sdk' });
    expect(created.kind).toBe('created');
    expect((await repository.markRunning(runId)).kind).toBe('moved');
    return { runId, sessionId };
  }

  async function seedPaused(): Promise<{ runId: string; sessionId: string }> {
    const seeded = await seedRunning();
    expect((await repository.awaitApproval(seeded.runId, CALL)).kind).toBe('moved');
    return seeded;
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_runs_approval');
    await seedOwnedWorkspace(isolated, { workspaceId, userId, principalId, agentId });
    scope = await resolveScope(isolated, workspaceId);
    repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
  }, 180_000);

  afterAll(async () => isolated.close());

  return {
    get isolated() {
      return isolated;
    },
    get scope() {
      return scope;
    },
    get repository() {
      return repository;
    },
    userId,
    principalId,
    seedSession,
    seedRunning,
    seedPaused,
    otherWorkspaceRepository: () => otherWorkspaceRepository(isolated),
  };
}
