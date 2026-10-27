/**
 * A run reads back the number of the agent version its session pins (issue #1571, #612,
 * ADR-0101), through `get()` and `listRuns()`, against a real PostgreSQL.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentVersions } from '../../schema/agent-versions.js';
import { agents } from '../../schema/agents.js';
import { memberships } from '../../schema/memberships.js';
import { sessions } from '../../schema/sessions.js';
import { users } from '../../schema/users.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import { workspaces } from '../../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider, type RunRepository } from '../runs.js';
import { createDatabaseWorkspaceScopeResolver } from '../scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/runs/agent-version.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

describe.skipIf(!hasDatabase)('a run reads the agent version its session pins', () => {
  let isolated: IsolatedTestDatabase;
  let repository: RunRepository;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const versionIds = [crypto.randomUUID(), crypto.randomUUID()];

  /** One run in a fresh session that pins `agentVersionId` (a session holds one active run). */
  async function createRun(agentVersionId: string | null): Promise<string> {
    const sessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await isolated.db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      userId,
      ownerPrincipalId: principalId,
      agentId,
      agentVersionId,
    });
    const created = await repository.create({ id, sessionId, engine: 'claude-agent-sdk' });
    expect(created.kind).toBe('created');
    return id;
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_1571_run_agent_version');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: 'run-agent-version', name: 'Run Agent Version' });
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
      name: 'Versioned agent',
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
    await isolated.db.insert(agentVersions).values(
      versionIds.map((id, index) => ({
        id,
        workspaceId,
        agentId,
        number: index + 1,
        summary: `version ${String(index + 1)}`,
        via: 'api' as const,
        body: {},
        createdByPrincipalId: principalId,
      })),
    );
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
  }, 180_000);

  afterAll(async () => isolated.close());

  it('reads back the number of the version its session pins; a legacy session reads null', async () => {
    const [, second] = versionIds;
    if (second === undefined) throw new Error('fixture versions missing');
    const pinned = await createRun(second);
    const legacy = await createRun(null);

    expect((await repository.get(pinned))?.agentVersion).toBe(2);
    expect((await repository.get(legacy))?.agentVersion).toBeNull();

    const page = await repository.listRuns({ limit: 200 });
    expect(page.items.find((run) => run.id === pinned)?.agentVersion).toBe(2);
    expect(page.items.find((run) => run.id === legacy)?.agentVersion).toBeNull();
  });
});
