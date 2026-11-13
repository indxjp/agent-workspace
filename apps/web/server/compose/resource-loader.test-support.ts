import { type WorkspaceScopeResolver } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  streamToBytes,
} from '@agent-workspace/core/storage';
import { createHash } from 'node:crypto';
import { type ResourceCatalogStoreProvider } from '../storage/store';
import { createStorageService, type StorageContext, type StorageService } from '../storage/service';
import { type RunFileSource } from './resource-loader';
export const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const OWNER_PRINCIPAL = '44444444-4444-4444-8444-444444444444';

export const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The text a run would receive for `key`, read through the loader's non-serialised sources. */
export async function sourceText(
  loaded: { readonly sources?: ReadonlyMap<string, RunFileSource> },
  key: string,
): Promise<string | null> {
  const body = await loaded.sources?.get(key)?.open();
  return body === null || body === undefined
    ? null
    : Buffer.from(await streamToBytes(body)).toString('utf8');
}

export function seededId(ids: Record<string, string>, key: string): string {
  const id = ids[key];
  if (id === undefined) throw new Error(`no seeded id for ${key}`);
  return id;
}

/** The catalog service over `catalogs` and an in-memory object store. */
export function storageOver(catalogs: ResourceCatalogStoreProvider): StorageService {
  return createStorageService({
    catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
}

/**
 * Saves `paths` through the catalog service, in order (a trailing `/` is a folder); each file holds
 * `texts[path]`, or its own path when none is given. Returns each path's id.
 */
export async function seedFiles(
  storage: StorageService,
  paths: readonly string[],
  texts: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> {
  const ctx: StorageContext = {
    workspaceId: WORKSPACE,
    principalId: OWNER_PRINCIPAL,
    userId: null,
  };
  const ids: Record<string, string> = {};
  for (const entry of paths) {
    const folder = entry.endsWith('/');
    const path = folder ? entry.slice(0, -1) : entry;
    if (folder) {
      const made = await storage.createFolder(ctx, path);
      if (!made.ok) throw new Error(`folder ${path} refused: ${made.code}`);
      ids[path] = made.row.id;
      continue;
    }
    const saved = await storage.save(ctx, {
      area: 'files',
      path,
      body: bytesToStream(new TextEncoder().encode(texts[path] ?? path)),
      maxBytes: 1024,
      replace: true,
    });
    if (!saved.ok) throw new Error(`save ${path} refused: ${saved.code}`);
    ids[path] = saved.row.id;
  }
  return ids;
}

export interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
}

export interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly a: Member;
  readonly b: Member;
}

export const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

export const ctxOf = (member: Member): StorageContext => ({
  workspaceId: member.workspaceId,
  principalId: member.principalId,
  userId: member.userId,
});
