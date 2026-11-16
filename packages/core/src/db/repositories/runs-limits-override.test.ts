/**
 * `runs.limits_override` against a real PostgreSQL (issue #1963, SPD-01): the lower-only limits a
 * trusted caller started a run under are stored with the run, so an approval continuation, which
 * is built from the stored row, keeps the cap instead of silently getting the agent's full limits.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider, type RunRepository } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn(
    '[repositories/runs-limits-override.test.ts] SKIPPED — TEST_DATABASE_URL is not set.',
  );
}

describe.skipIf(!hasDatabase)('runs.limits_override', () => {
  let isolated: IsolatedTestDatabase;
  let repository: RunRepository;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();

  /** One run in a fresh session (a session holds one active run at a time). */
  async function createRun(limitsOverride?: { maxTurns?: number; maxBudgetUsd?: number }) {
    const sessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    const created = await repository.create({
      id,
      sessionId,
      engine: 'claude-agent-sdk',
      ...(limitsOverride === undefined ? {} : { limitsOverride }),
    });
    expect(created.kind).toBe('created');
    return id;
  }

  async function stored(runId: string) {
    const rows = await isolated.db
      .select({ limitsOverride: runs.limitsOverride })
      .from(runs)
      .where(eq(runs.id, runId));
    return rows[0];
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_run_limits_override');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: 'run-limits', name: 'Run Limits' });
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
      name: 'Limits agent',
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
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
  }, 180_000);

  afterAll(async () => isolated.close());

  it('stores the override exactly, and NULL when the run was started without one', async () => {
    const capped = await createRun({ maxBudgetUsd: 0.3, maxTurns: 5 });
    const budgetOnly = await createRun({ maxBudgetUsd: 0.3 });
    const uncapped = await createRun();
    expect(await stored(capped)).toEqual({ limitsOverride: { maxBudgetUsd: 0.3, maxTurns: 5 } });
    expect(await stored(budgetOnly)).toEqual({ limitsOverride: { maxBudgetUsd: 0.3 } });
    expect(await stored(uncapped)).toEqual({ limitsOverride: null });
  });

  it('reads the override back from get(), null when none, and not on listed runs', async () => {
    const capped = await createRun({ maxBudgetUsd: 0.3 });
    const uncapped = await createRun();
    expect((await repository.get(capped))?.limitsOverride).toEqual({ maxBudgetUsd: 0.3 });
    expect((await repository.get(uncapped))?.limitsOverride).toBeNull();
    const page = await repository.listRuns({ limit: 200 });
    expect(page.items.find((run) => run.id === capped)?.limitsOverride).toBeUndefined();
  });

  it('refuses to read a stored override that is not a lower-only limits object', async () => {
    const runId = await createRun();
    await isolated.db
      .update(runs)
      .set({ limitsOverride: { maxBudgetUsd: -1 } })
      .where(eq(runs.id, runId));
    await expect(repository.get(runId)).rejects.toThrow(/runs\.limits_override/u);
    // Leave the shared database readable for the list test.
    await isolated.db.update(runs).set({ limitsOverride: null }).where(eq(runs.id, runId));
  });
});
