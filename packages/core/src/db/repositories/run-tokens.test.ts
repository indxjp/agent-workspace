import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseRunEventRepositoryProvider,
  createDatabaseRunRepositoryProvider,
} from './runs.js';
import { createDatabaseRunTokenRepositoryProvider } from './run-tokens.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('RunTokenRepository', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_run_tokens');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Tokens' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
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
      name: 'Token agent',
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
  }, 180_000);

  afterAll(async () => isolated.close());

  it('checks and revokes one token id without storing its bearer', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const tokens = createDatabaseRunTokenRepositoryProvider(isolated.db).forScope(scope);
    const id = crypto.randomUUID();
    await tokens.register({
      id,
      runId,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(tokens.isActive(id, runId, 'a'.repeat(64))).resolves.toBe(true);
    await expect(tokens.isActive(id, runId, 'c'.repeat(64))).resolves.toBe(false);
    await expect(tokens.revoke(id, runId)).resolves.toBe('revoked');
    await expect(tokens.isActive(id, runId, 'a'.repeat(64))).resolves.toBe(false);
    await expect(tokens.revoke(id, runId)).resolves.toBe('already-revoked');
  });

  it('revokes every outstanding token when the run becomes terminal', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const tokens = createDatabaseRunTokenRepositoryProvider(isolated.db).forScope(scope);
    const id = crypto.randomUUID();
    await tokens.register({
      id,
      runId,
      tokenHash: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await createDatabaseRunRepositoryProvider(isolated.db)
      .forScope(scope)
      .finish(runId, 'cancelled', null);
    await expect(tokens.isActive(id, runId, 'b'.repeat(64))).resolves.toBe(false);
  });

  it('serializes event admission against a concurrent terminal transition', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    const runRepository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
    const events = createDatabaseRunEventRepositoryProvider(isolated.db).forScope(scope);
    const racingRunId = crypto.randomUUID();
    await isolated.db.insert(runs).values({ id: racingRunId, workspaceId, sessionId });

    const [appended] = await Promise.all([
      events.append(racingRunId, 'assistant', { text: 'racing' }, 100),
      runRepository.finish(racingRunId, 'completed', null),
    ]);

    // Either the append owned the lock first and committed wholly before termination, or finish
    // owned it first and admission was refused. In neither ordering can an event commit afterward.
    expect(appended === null || appended.id === 1n).toBe(true);
    await expect(
      events.append(racingRunId, 'assistant', { text: 'late' }, 100),
    ).resolves.toBeNull();
  });
});
