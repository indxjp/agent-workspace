import crypto from 'node:crypto';

import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { sessionMessages } from '../schema/session-messages.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createDatabaseSessionTranscriptRepositoryProvider } from './session-transcripts.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('SessionTranscriptRepository', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_durable_transcripts');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'Transcript workspace' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other workspace' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Transcript owner' });
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
      name: 'Transcript agent',
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
  }, 180_000);

  afterAll(async () => isolated.close());

  it('survives repository reconstruction, preserves order, and folds retry UUIDs in place', async () => {
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scope = await resolver.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    const provider = createDatabaseSessionTranscriptRepositoryProvider(isolated.db);
    const firstProcess = provider.forScope(scope);
    const key = { projectKey: workspaceId, sessionId };

    await firstProcess.append(key, []);
    await expect(firstProcess.load(key)).resolves.toEqual([]);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        firstProcess.append(key, [{ type: 'user', uuid: `u-${String(index)}`, index }]),
      ),
    );
    await firstProcess.append(key, [{ type: 'user', uuid: 'u-0', index: 'corrected' }]);

    const afterRestart = createDatabaseSessionTranscriptRepositoryProvider(isolated.db).forScope(
      scope,
    );
    const transcript = await afterRestart.load(key);
    expect(transcript).toHaveLength(12);

    // The concurrent appends race for the per-key lock, so delivery order, not call order, is
    // the order the transcript must preserve.
    const deliveries = await isolated.db
      .select()
      .from(sessionMessages)
      .orderBy(asc(sessionMessages.sequence));
    expect(deliveries).toHaveLength(13);
    const delivered = deliveries.slice(0, 12).map((row) => row.entryUuid);
    expect(transcript?.map((entry) => entry['uuid'])).toEqual(delivered);
    const firstU0 = delivered.indexOf('u-0');
    expect(transcript?.[firstU0]).toMatchObject({ uuid: 'u-0', index: 'corrected' });
    expect(deliveries.at(-1)?.position).toBe(deliveries[firstU0]?.position);
  });

  it('keeps the same session id isolated by workspace scope', async () => {
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const otherScope = await resolver.forWorkspaceId(otherWorkspaceId);
    if (otherScope === null) throw new Error('other workspace did not resolve');
    const other = createDatabaseSessionTranscriptRepositoryProvider(isolated.db).forScope(
      otherScope,
    );
    await expect(other.load({ projectKey: otherWorkspaceId, sessionId })).resolves.toBeNull();
    await expect(other.listSessions(otherWorkspaceId)).resolves.toEqual([]);
  });

  it('removes main and subagent transcript rows when their platform session is deleted', async () => {
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scope = await resolver.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace did not resolve');
    const transcripts = createDatabaseSessionTranscriptRepositoryProvider(isolated.db).forScope(
      scope,
    );
    await transcripts.append({ projectKey: workspaceId, sessionId, subpath: 'subagents/cleanup' }, [
      { type: 'user', uuid: 'cleanup' },
    ]);

    await isolated.db.delete(sessions);

    await expect(transcripts.load({ projectKey: workspaceId, sessionId })).resolves.toBeNull();
    await expect(
      transcripts.load({ projectKey: workspaceId, sessionId, subpath: 'subagents/cleanup' }),
    ).resolves.toBeNull();
  });
});
