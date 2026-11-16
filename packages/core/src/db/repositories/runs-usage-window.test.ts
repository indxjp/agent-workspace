/**
 * The daily-cost window and the indexes it and the archive sweep read through (#1963 SPD-12,
 * SPD-15; #1851 B3-05), against a real PostgreSQL.
 */
import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { runUsageRecords } from '../schema/run-usage-records.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/runs-usage-window.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

describe.skipIf(!hasDatabase)('usageCostUsd and the indexes behind it', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();

  async function newRun(values: Partial<typeof runs.$inferInsert>): Promise<string> {
    const sessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    await isolated.db.insert(runs).values({ id, workspaceId, sessionId, ...values });
    return id;
  }

  async function usageWindow(from: string, to: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    return createDatabaseRunRepositoryProvider(isolated.db)
      .forScope(scope)
      .usageCostUsd(new Date(from), new Date(to));
  }

  async function indexDefinition(name: string): Promise<string | undefined> {
    const result = await isolated.db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}`,
    );
    return result.rows[0]?.indexdef;
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_run_usage_window');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: 'usage-window', name: 'Usage Window' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
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
      name: 'Usage window agent',
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
  }, 180_000);

  afterAll(async () => isolated.close());

  it('counts a run whose settlement failed as unpriced even when it left no ledger row in the window (SPD-12)', async () => {
    const settled = await newRun({
      accountingState: 'complete',
      priceTableVersion: 'test-prices',
      createdAt: new Date('2002-01-02T08:00:00Z'),
    });
    await isolated.db.insert(runUsageRecords).values({
      workspaceId,
      runId: settled,
      providerResponseId: 'settled-1',
      provider: 'anthropic',
      model: 'claude-fixture',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: '1.5',
      createdAt: new Date('2002-01-02T08:01:00Z'),
    });
    expect(await usageWindow('2002-01-02T00:00:00Z', '2002-01-03T00:00:00Z')).toEqual({
      costUsd: '1.500000',
      unpricedUsage: false,
    });

    // The gateway's settlement write failed: the run spent real money and has no ledger row.
    await newRun({
      status: 'failed',
      accountingState: 'failed',
      accountingError: 'settlement write failed',
      createdAt: new Date('2002-01-02T09:00:00Z'),
      endedAt: new Date('2002-01-02T09:05:00Z'),
    });
    expect(await usageWindow('2002-01-02T00:00:00Z', '2002-01-03T00:00:00Z')).toEqual({
      costUsd: '1.500000',
      unpricedUsage: true,
    });
    // It belongs to its own day only.
    expect(await usageWindow('2002-01-03T00:00:00Z', '2002-01-04T00:00:00Z')).toEqual({
      costUsd: '0',
      unpricedUsage: false,
    });
  });

  it('does not count a run that merely has not settled yet as unpriced (a queued or running run has spent nothing the ledger lacks)', async () => {
    await newRun({
      status: 'running',
      accountingState: 'pending',
      createdAt: new Date('2002-02-02T09:00:00Z'),
    });
    expect(await usageWindow('2002-02-02T00:00:00Z', '2002-02-03T00:00:00Z')).toEqual({
      costUsd: '0',
      unpricedUsage: false,
    });
  });

  it('indexes the usage ledger by workspace and time for the daily-cost window (SPD-15)', async () => {
    const definition = await indexDefinition('run_usage_records_workspace_created_idx');
    expect(definition).toMatch(/\(workspace_id, created_at\)/u);
  });

  it('indexes the archive sweep restore lookup on the audit log (B3-05)', async () => {
    const definition = await indexDefinition('audit_events_agent_restore_idx');
    expect(definition).toMatch(/\(workspace_id, subject_id, created_at\)/u);
    expect(definition).toMatch(/agent-changed/u);
    expect(definition).toMatch(/archived/u);
  });
});
