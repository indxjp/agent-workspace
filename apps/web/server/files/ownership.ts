import { UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import type { ObjectStore } from '@agent-workspace/core/storage';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';

import type { Ownership } from '../rbac/decide';
import type { OwnershipOutcome, OwnershipResolver } from '../rbac/http';
import { applicationContext } from '../application-context';
import { EMPTY_FOLDER_MARKER } from './handlers';

type CatalogRow = Awaited<
  ReturnType<Awaited<ReturnType<ResourceCatalogStoreProvider['forWorkspace']>>['listFiles']>
>[number];

/** The caller's workspace catalog rows and object store, or `null` when no catalog is wired. */
async function catalogView(workspaceId: string): Promise<{
  catalog: Awaited<ReturnType<ResourceCatalogStoreProvider['forWorkspace']>>;
  rows: readonly CatalogRow[];
  store: ObjectStore;
} | null> {
  const files = applicationContext()?.files;
  if (files?.kind !== 'serving' || files.runtime.catalog === undefined) return null;
  const catalog = await files.runtime.catalog.forWorkspace(workspaceId);
  return {
    catalog,
    rows: await catalog.listFiles(),
    store: files.runtime.store.forWorkspace(workspaceId),
  };
}

/**
 * Whether the store holds an object at or under `path` that no catalog row accounts for — e.g. a
 * signed upload, whose row appears only on the next list. Nobody can be proven to own such an
 * object, so a path holding one is `unknown` (ADR-0031: an undetermined owner denies). An unsafe
 * path holds nothing; the route itself refuses it.
 */
async function holdsRowlessObject(
  store: ObjectStore,
  rows: readonly CatalogRow[],
  path: string,
): Promise<boolean> {
  let entries;
  try {
    entries = await store.listPrefix(path);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) return false;
    throw error;
  }
  const catalogued = new Set(rows.flatMap((row) => [row.path, row.storageKey]));
  return entries.some(
    (entry) =>
      (entry.key === path || entry.key.startsWith(`${path}/`)) &&
      !entry.key.endsWith(`/${EMPTY_FOLDER_MARKER}`) &&
      !catalogued.has(entry.key),
  );
}

function outcome(ownership: Ownership): OwnershipOutcome {
  return { kind: 'ownership', ownership };
}

/**
 * Issue #117: load the file's catalog row within the caller's workspace and compare its
 * `created_by` against the caller. A path with no catalog row — the object exists only in the
 * `ObjectStore`, e.g. because it predates the catalog or its sync failed — answers `unknown`
 * rather than `other`: the route cannot prove who created it, and an undetermined owner denies
 * rather than passes (ADR-0031), the same rule the route applied to every row before this task.
 *
 * A folder's recursive delete and its move act on every descendant too, so the path is `own` only
 * when every catalog row at or under it is the caller's and every object under it has a row:
 * owning a shared folder must not let an `own` grant delete or move other members' files inside
 * it, catalogued or not. A plain file has no descendants, so this is the same single-row comparison
 * for it.
 *
 * `GET /api/files/:id` and `POST /api/files/:id/download-urls` both gate on it, so a URL is minted
 * for exactly the files the relay would serve.
 */
export function ownershipOfPath(path: string): OwnershipResolver {
  return async (principal) => {
    const view = await catalogView(principal.workspaceId);
    if (view === null) return outcome('unknown');
    if (!view.rows.some((file) => file.path === path)) return outcome('unknown');
    const subtree = view.rows.filter(
      (file) => file.path === path || file.path.startsWith(`${path}/`),
    );
    if (!subtree.every((file) => file.ownerPrincipalId === principal.ownerPrincipalId))
      return outcome('other');
    return outcome((await holdsRowlessObject(view.store, view.rows, path)) ? 'unknown' : 'own');
  };
}

/**
 * The target of a file write — `POST /api/files` and `POST /api/files/:id/upload-urls` — so a
 * Builder replaces only its own files (ADR-0031). An existing file is another member's or the
 * caller's, and so is a pending upload's reserved row; an object with no row is nobody's provably,
 * so `unknown`; a path nobody has written yet is nobody's.
 */
export function ownershipOfWriteTarget(path: string): OwnershipResolver {
  return async (principal) => {
    const view = await catalogView(principal.workspaceId);
    if (view === null) return outcome('not-applicable');
    const row = await view.catalog.get(path, { includePending: true });
    if (row !== null)
      return outcome(row.ownerPrincipalId === principal.ownerPrincipalId ? 'own' : 'other');
    return outcome(
      (await holdsRowlessObject(view.store, view.rows, path)) ? 'unknown' : 'not-applicable',
    );
  };
}
