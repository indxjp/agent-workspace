import crypto from 'node:crypto';

import { afterAll, beforeAll } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createInMemorySessionStateBlobs } from './memory-session-state-blobs.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { describeSessionStateBlobConformance } from './session-state-blobs.contract.js';
import { createDatabaseSessionStateRepositoryProvider } from './session-state.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

describeSessionStateBlobConformance('the in-memory rows', () => {
  const provider = createInMemorySessionStateBlobs();
  const workspaceIds = { a: crypto.randomUUID(), b: crypto.randomUUID() };
  return Promise.resolve({
    blobs: (workspace) => provider.forWorkspace(workspaceIds[workspace]),
    sessionId: crypto.randomUUID(),
  });
});

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_session_state_blobs_contract');
}, 180_000);

afterAll(async () => isolated?.close());

async function workspace(): Promise<{ readonly id: string; readonly scope: WorkspaceScope }> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const id = crypto.randomUUID();
  await isolated.db.insert(workspaces).values({ id, slug: `s-${id}`, name: 'blob rows' });
  const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(id);
  if (scope === null) throw new Error('the workspace did not resolve');
  return { id, scope };
}

describeSessionStateBlobConformance('PostgreSQL', async () => {
  if (isolated === undefined) throw new Error('the test database did not start');
  const { db } = isolated;
  const a = await workspace();
  const b = await workspace();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await db.transaction(async (tx) => {
    await tx
      .insert(memberships)
      .values({ id: membershipId, workspaceId: a.id, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId: a.id, kind: 'membership', membershipId });
  });
  await db.insert(agents).values({
    id: agentId,
    workspaceId: a.id,
    name: 'blob rows',
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
    .values({ id: sessionId, workspaceId: a.id, userId, ownerPrincipalId: principalId, agentId });
  const provider = createDatabaseSessionStateRepositoryProvider(db);
  return {
    blobs: (which) => provider.forScope(which === 'a' ? a.scope : b.scope),
    sessionId,
  };
});
