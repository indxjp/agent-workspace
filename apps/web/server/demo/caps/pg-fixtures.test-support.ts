import {
  agents,
  memberships,
  runs,
  runUsageRecords,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

/** One usage row to put in a fixture workspace: its own run, and one ledger row. */
export interface UsageFixture {
  readonly at: Date;
  readonly costUsd: number;
  /** `complete` is priced; `pending` is a settlement that has no price yet; `failed` left no price. */
  readonly accounting?: 'complete' | 'pending' | 'failed';
}

/**
 * Insert a workspace (a demo one when `demoExpiresAt` is set) with an owner, an agent, and one
 * session and run per usage row, for the adapters' PostgreSQL legs.
 */
export async function insertWorkspaceWithUsage(
  isolated: IsolatedTestDatabase,
  input: {
    readonly createdAt: Date;
    readonly demoExpiresAt: Date | null;
    readonly usage?: readonly UsageFixture[];
  },
): Promise<{ readonly workspaceId: string; readonly userId: string }> {
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  await isolated.db.insert(workspaces).values({
    id: workspaceId,
    slug: `w-${workspaceId}`,
    name: 'Demo fixture',
    createdAt: input.createdAt,
    demoExpiresAt: input.demoExpiresAt,
  });
  await isolated.db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: 'Guest' });
  await isolated.db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  await isolated.db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: 'Demo fixture agent',
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
  for (const row of input.usage ?? []) {
    const accounting = row.accounting ?? 'complete';
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    await isolated.db.insert(runs).values({
      id: runId,
      workspaceId,
      sessionId,
      accountingState: accounting,
      createdAt: row.at,
      ...(accounting === 'complete' ? { priceTableVersion: 'test-prices' } : {}),
    });
    await isolated.db.insert(runUsageRecords).values({
      workspaceId,
      runId,
      providerResponseId: crypto.randomUUID(),
      provider: 'anthropic',
      model: 'fixture-model',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: row.costUsd.toFixed(6),
      createdAt: row.at,
    });
  }
  return { workspaceId, userId };
}
