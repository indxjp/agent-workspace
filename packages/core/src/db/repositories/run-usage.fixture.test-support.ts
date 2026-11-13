import crypto from 'node:crypto';

import { afterAll, beforeAll } from 'vitest';

import type { Database } from '../client.js';
import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { shares } from '../schema/shares.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

export type RunUsageFixture = ReturnType<typeof createRunUsageFixture>;

/** The ids of a workspace's owner membership, its principal, an agent and one session. */
interface TenantSeed {
  readonly workspaceId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly sessionId: string;
}

/** Seeds the owner membership, an agent and a session into an existing workspace and user. */
export async function seedTenant(db: Database, seed: TenantSeed): Promise<void> {
  const { workspaceId, userId, membershipId, principalId, agentId, sessionId } = seed;
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx.insert(workspacePrincipals).values({
      id: principalId,
      workspaceId,
      kind: 'membership',
      membershipId,
    });
  });
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: seed.agentName,
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
}

export const usage = (providerResponseId: string) => ({
  providerResponseId,
  provider: 'anthropic' as const,
  model: 'claude-fixture',
  inputTokens: 10,
  outputTokens: 4,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 2,
  toolCalls: 1,
  wireProtocol: 'anthropic-messages' as const,
  costUsd: '0.000123',
  costCurrency: 'USD' as const,
  priceTableVersion: 'prices-v1',
});

const fixtureIds = () => ({
  workspaceId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  membershipId: crypto.randomUUID(),
  principalId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  unpricedRunId: crypto.randomUUID(),
  failureRunId: crypto.randomUUID(),
  staysPendingRunId: crypto.randomUUID(),
  publicRunId: crypto.randomUUID(),
  secondPublicRunId: crypto.randomUUID(),
  shareId: crypto.randomUUID(),
});

async function seedUsageWorkspace(db: Database, ids: ReturnType<typeof fixtureIds>) {
  const { workspaceId, userId, principalId, agentId, sessionId, shareId } = ids;
  await db.insert(workspaces).values({ id: workspaceId, slug: workspaceId, name: 'Usage' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
  await seedTenant(db, { ...ids, agentName: 'Usage agent' });
  const { runId, unpricedRunId, failureRunId, publicRunId, secondPublicRunId } = ids;
  for (const id of [runId, unpricedRunId, failureRunId, publicRunId, secondPublicRunId]) {
    await db.insert(runs).values({ id, workspaceId, sessionId });
  }
  await db.insert(shares).values({
    id: shareId,
    workspaceId,
    tokenHash: `pub_${shareId}`,
    subjectType: 'agent',
    subjectId: agentId,
    subjectLabel: 'Usage agent',
    visibility: 'public',
    mode: 'runnable',
    include: {},
    budgetCapUsd: '0.0002',
    publisherPrincipalId: principalId,
    createdBy: userId,
  });
  // Left untouched by every other test: this is the fixture a "never settled" run in the
  // reconciliation query below.
  await db.insert(runs).values({ id: ids.staysPendingRunId, workspaceId, sessionId });
}

export function createRunUsageFixture() {
  let isolated: IsolatedTestDatabase;
  const ids = fixtureIds();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_run_usage');
    await seedUsageWorkspace(isolated.db, ids);
  }, 180_000);

  afterAll(async () => isolated.close());

  const scopeFor = async (id: string) => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(id);
    if (scope === null) throw new Error('workspace did not resolve');
    return scope;
  };

  return {
    ...ids,
    get isolated() {
      return isolated;
    },
    scopeFor,
    repositoryFor: async (id: string) =>
      createDatabaseRunRepositoryProvider(isolated.db).forScope(await scopeFor(id)),
  };
}
