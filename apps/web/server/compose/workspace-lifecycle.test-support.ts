import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createInMemoryObjectStore, streamToBytes } from '@agent-workspace/core/storage';
import { bytesToStream, decodeUstar } from '@agent-workspace/runtime/transfer';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import type { LaunchContext } from '../runs/environment';
import { createStorageService, type StorageContext } from '../storage/service';
import { type RunFileSource } from './resource-loader';
import type { RuntimeLaunchTarget } from './runtime-profile';
export const context = {
  run: { id: 'run-1' },
  agent: { id: 'agent-1', workspaceId: 'workspace-1' },
  session: { id: 'session-1', agentId: 'agent-1' },
  principal: { userId: 'user-1', workspaceId: 'workspace-1' },
  prompt: 'work',
} as LaunchContext;

export const NOTHING_GRANTED = () => Promise.resolve({ files: [], skills: [] });

export const sha256Of = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export function referenced(path: string, text: string, access: 'read' | 'read-write' = 'read') {
  const source: RunFileSource = {
    objectId: null,
    open: () => Promise.resolve(bytesToStream(Buffer.from(text))),
  };
  return {
    file: {
      kind: 'file' as const,
      path,
      access,
      size: Buffer.byteLength(text),
      sha256: sha256Of(text),
    },
    source: [path, source] as const,
  };
}

export async function members(archive: ReadableStream<Uint8Array> | null) {
  return archive === null ? null : decodeUstar(await streamToBytes(archive));
}

export const quietLog = { info() {}, warn() {}, error() {}, child: () => quietLog };

export function memoryStorage() {
  // The object store names keys by workspace, and only a lowercase UUID is a valid workspace id.
  const workspaceId = '22222222-2222-4222-8222-222222222222';
  const catalog = createInMemoryCatalog().forWorkspace(workspaceId);
  const objects = createInMemoryObjectStore();
  const storage = createStorageService({
    catalog: () => Promise.resolve(catalog),
    objects,
    log: quietLog,
  });
  const ctx: StorageContext = { workspaceId, principalId: 'owner-1', userId: 'user-1' };
  const launch = {
    ...context,
    principal: { ...context.principal, workspaceId, ownerPrincipalId: 'owner-1' },
  } as LaunchContext;
  return { catalog, objects, storage, ctx, launch };
}

export const target = {
  driver: 'docker',
  runnerUrl: 'http://runner',
  workspaceRoot: '/workspace',
  fileTransfer: 'push-archive',
} as RuntimeLaunchTarget;

export interface Fixture {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
  readonly catalog: ResourceCatalogRepository;
}

export function memoryFixture(): Promise<Fixture> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    workspaceId,
    principalId: crypto.randomUUID(),
    userId: null,
    catalog: createInMemoryCatalog().forWorkspace(workspaceId),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_workspace_lifecycle');
}, 180_000);

afterAll(async () => isolated?.close());

export async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'outputs' });
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('catalog scope did not resolve');
  return {
    workspaceId,
    principalId,
    userId,
    catalog: createDatabaseResourceCatalogRepositoryProvider(db).forScope(scope),
  };
}
