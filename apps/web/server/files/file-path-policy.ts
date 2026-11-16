import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import { SKILL_REVISIONS_PREFIX, SKILL_ROWS_ROOT } from '../agents';
import type { CatalogPort } from '../storage/store';
import { decodeFileId } from './file-id';
import { problem, type FileResult } from './file-result';
import { isUploadInProgress } from './store';

/**
 * The name an old per-area store kept an explicit empty folder under. No route writes it any more;
 * it stays a reserved path segment so it is never created as a file name.
 */
export const EMPTY_FOLDER_MARKER = '.agent-workspace-empty-folder';

/**
 * Exported so the PATCH/DELETE routes can apply the same reservation to a subtree's own path.
 *
 * `.claude` is spelled here, and not asked of an engine adapter, on purpose (ADR-0072 D2). This is a
 * rule about the **workspace file tree**: `packages/contracts/src/files.ts` publishes `.claude/**`
 * as reserved, so a tenant cannot store a file there and cannot be surprised by one disappearing.
 * Making it depend on which engine an agent happens to run on would change `GET`/`PUT /api/files`
 * behaviour per agent, on a published contract, for a directory the run sandbox derives separately.
 * Generalising the *contract* belongs to the unit that adds a second engine's directory to it.
 */
export function targetsRunnerPrivateDirectory(path: string): boolean {
  const first = path.split('/', 1)[0];
  return first?.toLowerCase() === '.claude';
}

/**
 * The workspace's published skill revisions live in this same object store, so the files routes must
 * not be able to write, move or delete anything in them: a published revision never changes (SDK-19).
 */
export function targetsPublishedSkillRevisions(path: string): boolean {
  return path.split('/', 1)[0]?.toLowerCase() === SKILL_REVISIONS_PREFIX;
}
export const revisionsImmutable = (): FileResult =>
  problem(400, 'reserved_path', 'Published skill revisions are immutable.');

/**
 * `409 upload_in_progress`: a pending upload holds the path, or a path under the folder being
 * moved, until it is confirmed or removed. Nothing was written (FX-7).
 */
export function uploadInProgress(): FileResult {
  return problem(
    409,
    'upload_in_progress',
    'An upload to this path is still in progress; retry once it has finished.',
  );
}

/** `409 upload_in_progress` when a catalog write failed on a pending upload, else `null` (FX-7). */
export function uploadInProgressRefusal(error: unknown): FileResult | null {
  return isUploadInProgress(error) ? uploadInProgress() : null;
}

/** Whether a pending upload holds `path` in the catalog (FX-7). */
export async function pathIsPending(
  catalog: Pick<CatalogPort, 'get'>,
  path: string,
): Promise<boolean> {
  return (await catalog.get(path, { includePending: true }))?.status === 'pending';
}

/**
 * Decode and validate the `:id` path segment. `null`/unparseable is `404`, never `400`: an id this
 * route did not itself mint names nothing, which is the same fact as "no such file" from this
 * route's point of view, and a `400` would invite a caller to "fix" an opaque id it never chose.
 */
export function requireFilePath(
  rawId: unknown,
): { ok: true; path: string } | { ok: false; result: FileResult } {
  if (typeof rawId !== 'string') {
    return { ok: false, result: problem(404, 'file_not_found', 'No file has that id.') };
  }
  const decoded = decodeFileId(rawId);
  if (decoded === null) {
    return { ok: false, result: problem(404, 'file_not_found', 'No file has that id.') };
  }
  try {
    return { ok: true, path: toObjectKey(decoded) };
  } catch (error) {
    // A decoded id that is not a legal key (a `..` segment, an absolute path, ...) is refused the
    // same way a raw one would be — see `key-safety.ts`. Reported as `404`, not `400`, for the
    // same reason as above: this route minted every id it will accept as valid, so one that is
    // not is unknown, not malformed-by-the-caller.
    if (error instanceof UnsafeObjectKeyError) {
      return { ok: false, result: problem(404, 'file_not_found', 'No file has that id.') };
    }
    throw error;
  }
}

/**
 * The refusal for a write to a reserved path, or `null`. One admission for the relay and presigned
 * uploads and for both rename destinations; the marker is refused in any segment, so no write can
 * nest under a key that reads as a folder marker.
 */
export function reservedFileWriteRefusal(key: string): FileResult | null {
  if (targetsPublishedSkillRevisions(key)) return revisionsImmutable();
  if (targetsRunnerPrivateDirectory(key))
    return problem(400, 'reserved_path', 'The .claude directory is reserved for runner state.');
  if (key.split('/').includes(EMPTY_FOLDER_MARKER))
    return problem(400, 'reserved_path', 'That file path is reserved for internal metadata.');
  return null;
}

/** ADR-0146 decision 6: a visitor's files live under `.attachments/<sessionId>/`. */
export function isUnderSessionPrefix(path: string, sessionId: string): boolean {
  const prefix = `.attachments/${sessionId}/`;
  return sessionId !== '' && path.startsWith(prefix) && path.length > prefix.length;
}

/**
 * A session-scoped browser token reaches only its own session's files; any other path is concealed
 * as `404` rather than refused, so a token cannot probe what other sessions hold. `null` for every
 * other principal, whose reach `decide()` has already settled.
 */
export function concealOutsideSession(
  scope: { readonly kind: string; readonly id: string } | null,
  path: string,
): FileResult | null {
  if (scope === null || scope.kind !== 'session') return null;
  return isUnderSessionPrefix(path, scope.id)
    ? null
    : problem(404, 'file_not_found', 'No file has that id.');
}

/** ADR-0146 decision 6: whether `path` is under the reserved `.attachments/` directory. */
export function isReservedAttachmentPath(path: string): boolean {
  try {
    return toObjectKey(path).split('/', 1)[0]?.toLowerCase() === '.attachments';
  } catch {
    return false;
  }
}
export function isUnderSkillRows(path: string): boolean {
  try {
    return toObjectKey(path).split('/', 1)[0]?.toLowerCase() === SKILL_ROWS_ROOT;
  } catch {
    return false;
  }
}
export function skillRowsReserved(): FileResult {
  return problem(400, 'reserved_path', 'The .skills directory holds skills; use /api/skills.');
}

/**
 * ADR-0146 decision 6: `.attachments/` holds surface visitors' uploads. For any principal but a
 * session token, writing into it (a rename to it, a delete of a file or folder under it) is `400
 * reserved_path` and reading it is the concealed `404`. Renaming a file out of it (promotion) is the
 * one operation it admits, so the rename route checks only the destination. A session token is
 * confined to its own prefix by `concealOutsideSession`, so it passes here.
 *
 * A `write` (a create, an upload, a rename's destination) under `.skills/` is `400` for every
 * token, so no file row can collide with a skill row. Reads and deletes pass: skill rows are kept
 * out of them by their area, so a user's older file under `.skills/` still reads and deletes.
 */
export function attachmentsRefusal(
  scope: { readonly kind: string } | null,
  path: string,
  access: 'read' | 'write' | 'delete',
): FileResult | null {
  if (access === 'write' && isUnderSkillRows(path)) return skillRowsReserved();
  if (scope?.kind === 'session') return null;
  if (!isReservedAttachmentPath(path)) return null;
  return access === 'read'
    ? problem(404, 'file_not_found', 'No file has that id.')
    : problem(400, 'reserved_path', 'The .attachments directory holds surface visitors’ uploads.');
}
export async function holdsSkillRows(catalog: CatalogPort, path: string): Promise<boolean> {
  if (!isUnderSkillRows(path)) return false;
  let cursor: string | undefined;
  do {
    const page = await catalog.list(path, cursor === undefined ? undefined : { cursor });
    if (page.rows.some((row) => row.area === 'skills')) return true;
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return false;
}
