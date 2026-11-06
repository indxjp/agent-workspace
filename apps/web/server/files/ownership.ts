import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';

import type { Ownership } from '../rbac/decide';
import type { OwnershipOutcome, OwnershipResolver } from '../rbac/http';
import { applicationContext } from '../application-context';
import { listCatalogFiles, type CatalogFile } from '../storage/store';

/** The caller's workspace catalog, or `null` when no catalog is wired. */
async function catalogOf(
  workspaceId: string,
): Promise<Awaited<ReturnType<ResourceCatalogStoreProvider['forWorkspace']>> | null> {
  const files = applicationContext()?.files;
  if (files?.kind !== 'serving' || files.runtime.catalog === undefined) return null;
  return files.runtime.catalog.forWorkspace(workspaceId);
}

function outcome(ownership: Ownership): OwnershipOutcome {
  return { kind: 'ownership', ownership };
}

/**
 * Issue #117: load the file's catalog row within the caller's workspace and compare its
 * `created_by` against the caller. A path with no catalog row answers `unknown` rather than
 * `other`: the route cannot prove who created it, and an undetermined owner denies rather than
 * passes (ADR-0031).
 *
 * A folder's recursive delete and its move act on every descendant too, so the path is `own` only
 * when every catalog row at or under it is the caller's: owning a shared folder must not let an
 * `own` grant delete or move other members' files inside it. A plain file has no descendants, so
 * this is the same single-row comparison for it.
 *
 * `GET /api/files/:id` and `POST /api/files/:id/download-urls` both gate on it, so a URL is minted
 * for exactly the files the relay would serve.
 */
export function ownershipOfPath(path: string): OwnershipResolver {
  return async (principal) => {
    const catalog = await catalogOf(principal.workspaceId);
    if (catalog === null) return outcome('unknown');
    const rows: readonly CatalogFile[] = await listCatalogFiles(catalog);
    if (!rows.some((file) => file.path === path)) return pendingOwnership(catalog, path, principal);
    const subtree = rows.filter((file) => file.path === path || file.path.startsWith(`${path}/`));
    return outcome(
      subtree.every((file) => file.ownerPrincipalId === principal.ownerPrincipalId)
        ? 'own'
        : 'other',
    );
  };
}

/**
 * A path with no ready row may still hold a pending upload. Its uploader owns it, so an `own` grant
 * may delete it (STO-111 #2); another member's is `other`. With no pending row either, the owner
 * is `unknown`.
 */
async function pendingOwnership(
  catalog: NonNullable<Awaited<ReturnType<typeof catalogOf>>>,
  path: string,
  principal: { readonly ownerPrincipalId: string },
): Promise<OwnershipOutcome> {
  const row = await catalog.get(path, { includePending: true });
  if (row?.status !== 'pending') return outcome('unknown');
  return outcome(row.ownerPrincipalId === principal.ownerPrincipalId ? 'own' : 'other');
}

/**
 * The target of a file write — `POST /api/files` and `POST /api/files/:id/upload-urls` — so a
 * Builder replaces only its own files (ADR-0031). An existing file is another member's or the
 * caller's, and so is a pending upload's reserved row; a path nobody has written yet is nobody's.
 */
export function ownershipOfWriteTarget(path: string): OwnershipResolver {
  return async (principal) => {
    const catalog = await catalogOf(principal.workspaceId);
    if (catalog === null) return outcome('not-applicable');
    const row = await catalog.get(path, { includePending: true });
    if (row !== null)
      return outcome(row.ownerPrincipalId === principal.ownerPrincipalId ? 'own' : 'other');
    return outcome('not-applicable');
  };
}

/**
 * The owner of one catalog row the caller is about to replace: the ready file a reservation read
 * under its lock (`ReserveOutcome.replaces`). Decided on that row, not by reading its path again,
 * which a rename and a new file can make name another file meanwhile (#1991 C1).
 */
export function ownershipOfFileOwner(row: {
  readonly ownerPrincipalId: string;
}): OwnershipResolver {
  return (principal) =>
    Promise.resolve(outcome(row.ownerPrincipalId === principal.ownerPrincipalId ? 'own' : 'other'));
}
