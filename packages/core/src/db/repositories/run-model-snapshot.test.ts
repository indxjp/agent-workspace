/**
 * `RunRepository.snapshotModel` against a real PostgreSQL (issue #129).
 *
 * Distinct from `run-usage.test.ts`: that file is about the append-only usage ledger and the
 * counters it accumulates onto a run; this is about the identity triple — `model`, `provider`,
 * `model_connection_id` — written once, before launch, so a queued or failed run still says what
 * it attempted. `snapshotModel` must never touch `run_usage_records` or the numeric counters.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { modelConnections } from '../schema/model-connections.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider, type RunRepository } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/run-model-snapshot.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

async function expectConstraintViolation(
  statement: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await statement;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${constraint} to reject the statement, but it succeeded`).toBeDefined();
  const names = [...postgresViolations(thrown)].map((violation) => violation.constraint);
  expect(names, `the rejection named no constraint; error was: ${String(thrown)}`).toContain(
    constraint,
  );
}

describe.skipIf(!hasDatabase)('RunRepository.snapshotModel', () => {
  let isolated: IsolatedTestDatabase;
  let repository: RunRepository;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const otherWorkspaceConnectionId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w9model129_run_snapshot');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: 'run-snapshot', name: 'Run Snapshot' },
      { id: otherWorkspaceId, slug: 'run-snapshot-other', name: 'Run Snapshot Other' },
    ]);
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
    await isolated.db.insert(modelConnections).values([
      { id: connectionId, workspaceId, name: 'Claude', provider: 'anthropic', config: {} },
      {
        id: otherWorkspaceConnectionId,
        workspaceId: otherWorkspaceId,
        name: 'Other workspace Claude',
        provider: 'anthropic',
        config: {},
      },
    ]);
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Snapshot agent',
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
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    await isolated.db.insert(runs).values({ id: runId, workspaceId, sessionId });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
  }, 180_000);

  afterAll(async () => isolated.close());

  it('writes model, provider and connection id together, and reads them back', async () => {
    await expect(
      repository.snapshotModel(runId, {
        connectionId,
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
      }),
    ).resolves.toEqual({ kind: 'updated' });
    const run = await repository.get(runId);
    expect(run).toMatchObject({
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      modelConnectionId: connectionId,
    });
  });

  it('overwrites a previous snapshot rather than accumulating (unlike recordUsage)', async () => {
    await repository.snapshotModel(runId, {
      connectionId,
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
    });
    await expect(
      repository.snapshotModel(runId, {
        connectionId,
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      }),
    ).resolves.toEqual({ kind: 'updated' });
    const run = await repository.get(runId);
    expect(run?.model).toBe('claude-opus-4-5');
  });

  it('does not touch the run_usage_records ledger or its counters', async () => {
    await repository.snapshotModel(runId, {
      connectionId,
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
    });
    const run = await repository.get(runId);
    expect(run?.inputTokens).toBe(0);
    expect(run?.outputTokens).toBe(0);
    expect(run?.costUsd).toBe('0.000000');
  });

  it('answers not-found for a run id this workspace does not have', async () => {
    await expect(
      repository.snapshotModel(crypto.randomUUID(), {
        connectionId,
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
      }),
    ).resolves.toEqual({ kind: 'not-found' });
  });

  it('refuses a connection from another workspace (§25, runs_model_connection_workspace_fk)', async () => {
    await expectConstraintViolation(
      repository.snapshotModel(runId, {
        connectionId: otherWorkspaceConnectionId,
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
      }),
      'runs_model_connection_workspace_fk',
    );
  });

  it("nulls the run's model_connection_id, but keeps its model/provider history, once the connection is deleted", async () => {
    const disposableConnectionId = crypto.randomUUID();
    await isolated.db.insert(modelConnections).values({
      id: disposableConnectionId,
      workspaceId,
      name: 'Disposable',
      provider: 'openai',
      config: {},
    });
    const disposableRunId = crypto.randomUUID();
    await isolated.db.insert(runs).values({ id: disposableRunId, workspaceId, sessionId });
    await repository.snapshotModel(disposableRunId, {
      connectionId: disposableConnectionId,
      model: 'gpt-5.1',
      provider: 'openai',
    });

    await isolated.db
      .delete(modelConnections)
      .where(eq(modelConnections.id, disposableConnectionId));

    const run = await repository.get(disposableRunId);
    expect(run).toMatchObject({ modelConnectionId: null, model: 'gpt-5.1', provider: 'openai' });
  });
});
