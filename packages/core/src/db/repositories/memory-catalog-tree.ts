import { isSidePath, sidePath } from '../side-paths.js';
import { CatalogPathPendingError, CatalogPathTakenError, renamedKey } from './resource-catalogs.js';
import {
  type Row,
  NEW_ROW,
  underPrefix,
  logical,
  byPath,
  assertRowShape,
} from './memory-catalog-model.js';

export function createMemoryFileTree(rows: Map<string, Row>) {
  const under = (prefix: string) =>
    [...rows.values()].filter((r) => underPrefix(logical(r), prefix));

  const ensureParents = (placed: readonly Row[]) => {
    for (const row of placed) {
      const segments = logical(row).split('/');
      for (let end = 1; end < segments.length; end += 1) {
        const path = segments.slice(0, end).join('/');
        if (rows.has(path)) continue;
        rows.set(path, {
          id: crypto.randomUUID(),
          path,
          kind: 'folder',
          storageKey: null,
          sizeBytes: 0,
          contentType: null,
          status: 'ready',
          ...NEW_ROW,
          createdBy: row.createdBy,
          ownerPrincipalId: row.ownerPrincipalId,
          updatedAt: new Date(),
        });
      }
    }
  };

  const renameByPrefix = (oldPrefix: string, newPrefix: string): Row[] => {
    if (isSidePath(newPrefix)) throw new Error(`${newPrefix} is a reserved catalog path.`);
    // A `deleting` row is out of the tree: its object is removed from its own key.
    const moving = under(oldPrefix)
      .filter((row) => row.status !== 'deleting')
      .sort(byPath);
    const destination = (row: Row) => renamedKey(logical(row), oldPrefix, newPrefix);
    const movingIds = new Set(moving.map((row) => row.id));
    const destinations = new Set(moving.map(destination));
    const clash = [...rows.values()].find(
      (row) =>
        row.status !== 'deleting' && !movingIds.has(row.id) && destinations.has(logical(row)),
    );
    if (clash !== undefined) throw new CatalogPathTakenError(logical(clash));
    // storage-bridge(#1657): a folder move refuses while an upload under it is pending.
    if (moving.some((row) => row.status === 'pending')) {
      throw new CatalogPathPendingError(oldPrefix);
    }
    // A file's key names its object, so only the path moves.
    const moved = moving.map((row) => ({
      ...row,
      path: destination(row),
      updatedAt: new Date(),
    }));
    moved.forEach(assertRowShape);
    for (const row of moving) rows.delete(row.path);
    // A legacy `deleting` row still holding a real path meets `files_workspace_path_key`.
    const duplicate = moved.find((row) => rows.has(row.path));
    if (duplicate !== undefined) {
      for (const row of moving) rows.set(row.path, row);
      throw new Error(`duplicate key value violates unique constraint: ${duplicate.path}`);
    }
    for (const row of moved) rows.set(row.path, row);
    ensureParents(moved);
    return moved;
  };

  // A folder cannot be `deleting` (`files_folder_is_ready`) and holds no object, so it is dropped.
  // A file moves to its side path at once, which frees the path to reserve again.
  const markDeleting = (prefix: string): Row[] => {
    const marked: Row[] = [];
    for (const row of under(prefix)) {
      if (row.kind === 'folder') rows.delete(row.path);
      else if (row.status !== 'deleting') {
        const deleting: Row = {
          ...row,
          status: 'deleting',
          path: sidePath(row.id),
          targetPath: logical(row),
          reservationToken: null,
          updatedAt: new Date(),
        };
        rows.delete(row.path);
        rows.set(deleting.path, deleting);
        marked.push(deleting);
      }
    }
    return marked.sort(byPath);
  };
  return { under, ensureParents, renameByPrefix, markDeleting };
}
