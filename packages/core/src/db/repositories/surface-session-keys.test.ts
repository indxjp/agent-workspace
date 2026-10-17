import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { sessions } from '../schema/sessions.js';
import { surfaceSessionKeys } from '../schema/surface-session-keys.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createDatabaseSurfaceSessionKeyRepositoryProvider } from './surface-session-keys.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

describe.skipIf(!hasDatabase)('SurfaceSessionKeyRepository (issue #538)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const otherPrincipalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const otherAgentId = crypto.randomUUID();
  const otherSessionId = crypto.randomUUID();

  async function principalIn(workspace: string, id: string): Promise<void> {
    const membershipId = crypto.randomUUID();
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId: workspace, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id, workspaceId: workspace, kind: 'membership', membershipId });
    });
  }

  async function newSession(): Promise<string> {
    const id = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    return id;
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_surface_session_keys');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'Keys' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
    await principalIn(workspaceId, principalId);
    await principalIn(otherWorkspaceId, otherPrincipalId);
    await isolated.db.insert(agents).values([
      {
        id: agentId,
        workspaceId,
        name: 'Desk',
        instructions: '',
        ownerPrincipalId: principalId,
        createdBy: userId,
        permissions: PERMISSIONS,
      },
      {
        id: otherAgentId,
        workspaceId: otherWorkspaceId,
        name: 'Desk',
        instructions: '',
        ownerPrincipalId: otherPrincipalId,
        createdBy: userId,
        permissions: PERMISSIONS,
      },
    ]);
    await isolated.db.insert(sessions).values({
      id: otherSessionId,
      workspaceId: otherWorkspaceId,
      userId,
      ownerPrincipalId: otherPrincipalId,
      agentId: otherAgentId,
    });
  }, 180_000);

  afterAll(async () => isolated.close());

  async function keysFor(workspace: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(workspace);
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseSurfaceSessionKeyRepositoryProvider(isolated.db).forScope(scope);
  }

  it('records a key and finds it by session, only in its own workspace', async () => {
    const sessionId = await newSession();
    const keys = await keysFor(workspaceId);
    const record = { sessionId, surfaceName: 'main', agentId, keyHash: 'a'.repeat(64) };
    await keys.record(record);

    await expect(keys.find(sessionId)).resolves.toEqual(record);
    await expect(keys.find(crypto.randomUUID())).resolves.toBeNull();
    await expect((await keysFor(otherWorkspaceId)).find(sessionId)).resolves.toBeNull();
  });

  it('refuses a second key for the same session', async () => {
    const sessionId = await newSession();
    const keys = await keysFor(workspaceId);
    await keys.record({ sessionId, surfaceName: 'main', agentId, keyHash: 'b'.repeat(64) });
    await expect(
      keys.record({ sessionId, surfaceName: 'main', agentId, keyHash: 'c'.repeat(64) }),
    ).rejects.toThrow();
    await expect(keys.find(sessionId)).resolves.toMatchObject({ keyHash: 'b'.repeat(64) });
  });

  it('refuses a session or an agent of another workspace (tenant-paired FKs)', async () => {
    const keys = await keysFor(workspaceId);
    await expect(
      keys.record({
        sessionId: otherSessionId,
        surfaceName: 'main',
        agentId,
        keyHash: 'd'.repeat(64),
      }),
    ).rejects.toThrow();
    await expect(
      keys.record({
        sessionId: await newSession(),
        surfaceName: 'main',
        agentId: otherAgentId,
        keyHash: 'e'.repeat(64),
      }),
    ).rejects.toThrow();
  });

  it('is deleted with its session', async () => {
    const sessionId = await newSession();
    const keys = await keysFor(workspaceId);
    await keys.record({ sessionId, surfaceName: 'main', agentId, keyHash: 'f'.repeat(64) });
    await isolated.db.delete(sessions).where(eq(sessions.id, sessionId));
    await expect(keys.find(sessionId)).resolves.toBeNull();
    const rows = await isolated.db
      .select()
      .from(surfaceSessionKeys)
      .where(eq(surfaceSessionKeys.sessionId, sessionId));
    expect(rows).toEqual([]);
  });
});
