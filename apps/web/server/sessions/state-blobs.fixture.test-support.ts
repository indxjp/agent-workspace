import { afterAll, beforeAll } from 'vitest';
import {
  agents,
  createDatabaseSessionStateRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  createInMemorySessionStateBlobs,
  createInMemoryWorkspaceScopeResolver,
  type SessionStateRepository,
  type SessionStateRepositoryProvider,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import type { Logger } from '@agent-workspace/core/telemetry';

export const ENGINE = 'claude-agent-sdk' as const;

export const BLOB_KEY = 'state.tar';

export interface Fixture {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly repositories: SessionStateRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
}

export function memoryFixture(): Promise<Fixture> {
  const workspaceId = crypto.randomUUID();
  const unreachable = (): never => {
    throw new Error('this suite drives only the blob half of the session-state repository');
  };
  const repository: SessionStateRepository = {
    ...createInMemorySessionStateBlobs().forWorkspace(workspaceId),
    append: unreachable,
    list: unreachable,
    deleteLast: unreachable,
    replaceAll: unreachable,
    deleteStream: unreachable,
    listStreams: unreachable,
  };
  return Promise.resolve({
    workspaceId,
    sessionId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    repositories: { forScope: () => repository },
    scopes: createInMemoryWorkspaceScopeResolver([{ id: workspaceId, slug: 'acme' }]),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_session_state_blobs');
}, 180_000);

afterAll(async () => isolated?.close());

export async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'blobs' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: 'blobs',
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
    .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
  return {
    workspaceId,
    sessionId,
    principalId,
    repositories: createDatabaseSessionStateRepositoryProvider(db),
    scopes: createDatabaseWorkspaceScopeResolver(db),
  };
}

export function lazyBody(size: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = Math.min(chunk.byteLength, size - sent);
      if (next === 0) controller.close();
      else controller.enqueue(chunk.subarray(0, next));
      sent += next;
    },
  });
}

export const log: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
};

export function ref(f: Fixture) {
  return {
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    engine: ENGINE,
    blobKey: BLOB_KEY,
  } as const;
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([new Uint8Array(bytes)]).stream();
}
