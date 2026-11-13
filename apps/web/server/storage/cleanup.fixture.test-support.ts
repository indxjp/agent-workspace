import { afterAll, beforeAll } from 'vitest';

import { type ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  agents,
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseSessionStateRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createInMemorySessionStateBlobs,
  createIsolatedTestDatabase,
  memberships,
  sessions,
  sessionStateBlobs,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { storageObjectName } from '@agent-workspace/core/storage';

import { type CleanupDependencies } from './cleanup';

type BlobStatus = 'pending' | 'ready' | 'deleting';

export interface CleanupFixture {
  readonly workspace: () => Promise<{ readonly id: string; readonly principalId: string }>;
  readonly catalog: (workspaceId: string) => Promise<ResourceCatalogRepository>;
  /** The session-state blob rows of a workspace, as the cleanup job reads them. */
  readonly sessionState: CleanupDependencies['sessionState'];
  /** A session-state blob row holding `objectId` in `status`. */
  readonly stateBlob: (workspaceId: string, objectId: string, status: BlobStatus) => Promise<void>;
}

export function memoryCleanupFixture(): Promise<CleanupFixture> {
  const provider = createInMemoryCatalog();
  const blobs = createInMemorySessionStateBlobs();
  return Promise.resolve({
    workspace: () => Promise.resolve({ id: crypto.randomUUID(), principalId: crypto.randomUUID() }),
    catalog: (workspaceId) => Promise.resolve(provider.forWorkspace(workspaceId)),
    sessionState: (workspaceId) => Promise.resolve(blobs.forWorkspace(workspaceId)),
    stateBlob: async (workspaceId, objectId, status) => {
      const rows = blobs.forWorkspace(workspaceId);
      const pending = await rows.reserveBlob(crypto.randomUUID(), {
        engine: 'claude-agent-sdk',
        objectId,
        storageKey: storageObjectName(workspaceId, 'session-state', objectId),
      });
      if (status === 'deleting') await rows.claimBlob(pending);
      if (status !== 'ready') return;
      const blob = { blobKey: crypto.randomUUID(), sizeBytes: 7, sha256: '0'.repeat(64) };
      await rows.confirmBlob(pending, blob);
    },
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_storage_cleanup');
}, 180_000);

afterAll(async () => isolated?.close());

export function postgresCleanupFixture(): Promise<CleanupFixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const provider = createDatabaseResourceCatalogRepositoryProvider(db);
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  const sessionsOf = new Map<string, string>();
  return Promise.resolve({
    workspace: async () => {
      const { id, principalId, sessionId } = await createPostgresCleanupWorkspace(db);
      sessionsOf.set(id, sessionId);
      return { id, principalId };
    },
    catalog: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
      return provider.forScope(scope);
    },
    sessionState: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
      return createDatabaseSessionStateRepositoryProvider(db).forScope(scope);
    },
    stateBlob: async (workspaceId, objectId, status) => {
      const sessionId = sessionsOf.get(workspaceId);
      if (sessionId === undefined) throw new Error('the workspace has no session');
      await db.insert(sessionStateBlobs).values({
        workspaceId,
        sessionId,
        engine: 'claude-agent-sdk',
        blobKey: crypto.randomUUID(),
        storageKey: storageObjectName(workspaceId, 'session-state', objectId),
        objectId,
        status,
        sizeBytes: 7,
        sha256: '0'.repeat(64),
      });
    },
  });
}

async function createPostgresCleanupWorkspace(db: IsolatedTestDatabase['db']) {
  const id = crypto.randomUUID();
  await db.insert(workspaces).values({ id, slug: `s-${id}`, name: 'cleanup' });
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await db.transaction(async (tx) => {
    await tx
      .insert(memberships)
      .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId: id, kind: 'membership', membershipId });
  });
  // A session-state blob row hangs off a session, which hangs off an agent.
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await db.insert(agents).values({
    id: agentId,
    workspaceId: id,
    name: 'cleanup',
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
    .values({ id: sessionId, workspaceId: id, userId, ownerPrincipalId: principalId, agentId });
  return { id, principalId, sessionId };
}
