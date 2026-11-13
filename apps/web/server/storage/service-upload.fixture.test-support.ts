import { afterAll, beforeAll } from 'vitest';
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
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  storageObjectName,
  type ObjectStore,
  type SignedUrlRequest,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';
import { createStorageService, type StorageContext } from './service';

export interface Fixture {
  readonly workspace: () => Promise<{ readonly id: string; readonly principalId: string }>;
  readonly catalog: (workspaceId: string) => Promise<ResourceCatalogRepository>;
}
export function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  return Promise.resolve({
    workspace: () => Promise.resolve({ id: crypto.randomUUID(), principalId: crypto.randomUUID() }),
    catalog: (workspaceId) => Promise.resolve(provider.forWorkspace(workspaceId)),
  });
}
let isolated: IsolatedTestDatabase | undefined;
beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_storage_service_upload');
}, 180_000);
afterAll(async () => isolated?.close());
export function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const provider = createDatabaseResourceCatalogRepositoryProvider(db);
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return Promise.resolve({
    workspace: async () => {
      const id = crypto.randomUUID();
      await db.insert(workspaces).values({ id, slug: `s-${id}`, name: 'service upload' });
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
      return { id, principalId };
    },
    catalog: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
      return provider.forScope(scope);
    },
  });
}
const noLog: Logger = { info() {}, warn() {}, error() {}, child: () => noLog };
export const bytesOf = (text: string) => new TextEncoder().encode(text);
export async function createUploadHarness(setup: () => Promise<Fixture>, bindsLength = true) {
  const f = await setup();
  const ws = await f.workspace();
  const requests: SignedUrlRequest[] = [];
  const inner = createInMemoryObjectStore();
  const objects: ObjectStore = {
    ...inner,
    capabilities: { ...inner.capabilities, sign: true, boundLengthSign: bindsLength },
    createSignedUrl: (key, request) => {
      requests.push(request);
      return Promise.resolve({ url: `https://store.invalid/${key}`, headers: {} });
    },
  };
  const storage = createStorageService({ catalog: f.catalog, objects, log: noLog });
  const ctx: StorageContext = { workspaceId: ws.id, principalId: ws.principalId, userId: null };
  const catalog = await f.catalog(ws.id);
  const nameOf = (objectId: string | null | undefined) =>
    storageObjectName(ws.id, 'files', objectId ?? '');
  const save = async (path: string, text: string) => {
    const saved = await storage.save(ctx, {
      area: 'files',
      path,
      body: bytesToStream(bytesOf(text)),
      maxBytes: 1024,
      replace: true,
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    return saved.row;
  };
  const mint = (path: string, sizeBytes: number, mayReplace = true) =>
    storage.reserveUpload(ctx, {
      path,
      sizeBytes,
      mayReplace: () => Promise.resolve(mayReplace),
    });
  /** The bytes a `PUT` to the signed link would land on its object. */
  const put = async (path: string, text: string) => {
    const pending = await catalog.pending(path);
    if (pending === null) throw new Error(`${path} has no pending upload`);
    await objects.write(nameOf(pending.objectId), bytesOf(text), { contentType: null });
    return pending;
  };
  const complete = (path: string, maxBytes = 1024) =>
    storage.completeUpload(ctx, { path, maxBytes });
  const reservePending = async (count: number, prefix = 'seed') => {
    for (let index = 0; index < count; index += 1) {
      await catalog.reserve(`${prefix}/${index}.bin`, {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ws.principalId,
        sizeBytes: 1,
        contentType: null,
      });
    }
  };
  return {
    ws,
    ctx,
    catalog,
    objects,
    requests,
    storage,
    nameOf,
    save,
    mint,
    put,
    complete,
    reservePending,
  };
}
export type UploadHarnessFactory = (
  bindsLength?: boolean,
) => ReturnType<typeof createUploadHarness>;

export const sha256Of = async (text: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', bytesOf(text))).toString('hex');
