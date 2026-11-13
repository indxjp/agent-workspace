import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import type { StorageContext, StorageService } from '../storage/service';
import type { CatalogPort } from '../storage/store';
import {
  holdsSkillRows,
  pathIsPending,
  reservedFileWriteRefusal,
  revisionsImmutable,
  skillRowsReserved,
  targetsPublishedSkillRevisions,
  targetsRunnerPrivateDirectory,
  uploadInProgress,
} from './file-path-policy';
import { catalogResource } from './file-resource';
import { json, problem, type FileResult } from './file-result';

/** `a` and `b` name the same key except for letter case, a rename this module refuses. */
function isCaseOnlyRename(a: string, b: string): boolean {
  return a !== b && a.toLowerCase() === b.toLowerCase();
}

/** `true` when `candidate` is `base` itself or lies under it (`base` or `${base}/…`). */
function isPathOrDescendant(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}/`);
}

/**
 * `PATCH /api/files/:id` through the catalog service: a rename or move updates rows and copies no
 * object (the storage design, §06 Phase 3 "Done when"). The guards the object-store rename applied
 * are kept; `rename` itself refuses a taken destination, a pending upload under the source and a
 * missing source. The ownership decision was made by the route before this runs.
 */
// @story US-STO-03
export async function renameCatalogPath(
  storage: StorageService,
  catalog: CatalogPort,
  ctx: StorageContext,
  from: string,
  rawNewPath: string,
): Promise<FileResult> {
  let to: string;
  try {
    to = toObjectKey(rawNewPath);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) {
      return problem(400, 'invalid_path', `"newPath" is not a valid path: ${error.message}`);
    }
    throw error;
  }
  const pathRefusal = renamePathRefusal(from, to);
  if (pathRefusal !== null) return pathRefusal;
  // A pending upload owns its path until it is confirmed: neither move onto it nor from it.
  if ((await pathIsPending(catalog, to)) || (await pathIsPending(catalog, from))) {
    return uploadInProgress();
  }
  if (await holdsSkillRows(catalog, from)) return skillRowsReserved();

  const row = await catalog.get(from);
  if (from === to) {
    if (row === null) return problem(404, 'file_not_found', 'No file has that id.');
    return json(
      200,
      row.kind === 'file' ? { file: catalogResource(row) } : { status: 'ok', moved: 0 },
    );
  }
  const renamed = await storage.rename(ctx, 'files', from, to);
  if (!renamed.ok) return renameFailure(renamed.code, to);
  const moved = row?.kind === 'file' ? await storage.get(ctx, 'files', to) : null;
  return json(
    200,
    moved === null ? { status: 'ok', moved: renamed.moved } : { file: catalogResource(moved) },
  );
}

/**
 * `DELETE /api/files/:id` through the catalog service: the object goes with the row (the storage
 * design, §04 "File states", §05). A file or a missing path answers `204`; a folder answers the
 * `200` outcome naming the files it held. A delete that could not remove an object leaves the row
 * `deleting` for the cleanup job, so it is not reported as partial.
 */
// @story US-STO-04
export async function removeCatalogPath(
  storage: StorageService,
  catalog: CatalogPort,
  ctx: StorageContext,
  path: string,
  recursive: boolean,
): Promise<FileResult> {
  if (targetsPublishedSkillRevisions(path)) return revisionsImmutable();
  if (recursive && (await holdsSkillRows(catalog, path))) return skillRowsReserved();
  const row = await catalog.get(path);
  const removed = await storage.remove(ctx, 'files', path, { recursive });
  if (!removed.ok) {
    switch (removed.code) {
      case 'not_empty':
        return problem(
          409,
          'folder_not_empty',
          `${path} is not empty. Pass ?recursive=true to delete it and its contents.`,
        );
      case 'not_found':
        // Nothing at this path: the same idempotent answer as a delete that finds it already gone.
        return { status: 204, kind: 'empty' };
      case 'invalid_path':
        return problem(400, 'invalid_path', 'The file path is not valid.');
    }
  }
  return row?.kind === 'folder'
    ? json(200, { status: 'ok', deleted: removed.files })
    : { status: 204, kind: 'empty' };
}

function renamePathRefusal(from: string, to: string): FileResult | null {
  if (targetsPublishedSkillRevisions(from)) return revisionsImmutable();
  if (targetsRunnerPrivateDirectory(from)) {
    return problem(400, 'reserved_path', 'The .claude directory is reserved for runner state.');
  }
  const reserved = reservedFileWriteRefusal(to);
  if (reserved !== null) return reserved;
  if (isCaseOnlyRename(from, to)) {
    return problem(
      409,
      'name_conflict',
      'A rename that differs only in letter case is not supported.',
    );
  }
  if (from !== to && isPathOrDescendant(from, to)) {
    return problem(409, 'self_descendant', `${to} is inside ${from}, so it cannot be moved there.`);
  }

  return null;
}

function renameFailure(
  code: Extract<Awaited<ReturnType<StorageService['rename']>>, { ok: false }>['code'],
  to: string,
): FileResult {
  switch (code) {
    case 'path_taken':
      return problem(409, 'name_conflict', `${to} already exists.`);
    case 'upload_in_progress':
      return uploadInProgress();
    case 'not_found':
      return problem(404, 'file_not_found', 'No file has that id.');
    case 'invalid_path':
      return problem(400, 'invalid_path', '"newPath" is not a valid path.');
  }
}
