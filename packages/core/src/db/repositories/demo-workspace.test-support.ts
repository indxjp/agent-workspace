import crypto from 'node:crypto';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { runUsageRecords } from '../schema/run-usage-records.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import type { IsolatedTestDatabase } from './testing.js';

/** A workspace with an owner, an agent, and runs with usage: what a demo workspace holds. */
export interface DemoWorkspaceFixture {
  readonly workspaceId: string;
  readonly userId: string;
  /** Add a run with one usage row of `costUsd` at `at`; `accounting` is the run's state. */
  readonly addUsage: (input: {
    readonly costUsd: string;
    readonly at: Date;
    readonly accounting?: 'complete' | 'failed';
  }) => Promise<void>;
}

/**
 * Insert a workspace (a demo one when `demoExpiresAt` is given) that holds a user, an agent, a
 * session, and a way to add runs with usage.
 */
export async function insertDemoWorkspace(
  isolated: IsolatedTestDatabase,
  input: { readonly createdAt: Date; readonly demoExpiresAt: Date | null },
): Promise<DemoWorkspaceFixture> {
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  await isolated.db.insert(workspaces).values({
    id: workspaceId,
    slug: `w-${workspaceId}`,
    name: 'Fixture',
    createdAt: input.createdAt,
    demoExpiresAt: input.demoExpiresAt,
  });
  await isolated.db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: 'Guest' });
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
    name: 'Fixture agent',
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
    workspaceId,
    userId,
    async addUsage({ costUsd, at, accounting = 'complete' }) {
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
        createdAt: at,
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
        costUsd,
        priceTableVersion: accounting === 'complete' ? 'test-prices' : null,
        createdAt: at,
      });
    },
  };
}
