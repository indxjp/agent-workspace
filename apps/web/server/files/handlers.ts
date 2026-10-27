/**
 * The files operations, as functions of the catalog service and already-parsed input.
 *
 * Mirrors `apps/web/server/agents/handlers.ts`'s split: nothing here touches `Request` or
 * `Response` (that is `http.ts`), and nothing here is a Next.js route file (that is
 * `apps/web/app/api/files/**`). A handler is testable by calling it with a fake catalog service.
 *
 * ## What spec §16 asks for, and what this covers
 *
 * §16's list, quoted in full — all eight bullets, not the first six:
 *
 *   > upload · download · delete · rename · folders · preview metadata ·
 *   > assign folders/files to an agent · read-only or read-write access
 *
 * Six of the eight are here. `list` covers folders and preview metadata (every entry it returns
 * already carries `sizeBytes`/`contentType`/`lastModified`); `put`/`get`/`delete` cover
 * upload/download/delete directly. `rename` updates catalog rows and copies no object.
 *
 * **Declared gap — §16's last two bullets are not implemented anywhere in this task.**
 * "Assign folders/files to an agent" and "read-only or read-write access" are both *per-principal
 * authorisation over a path*, and this module has no principal: `http.ts`'s
 * `withCatalogService` resolves a workspace and nothing finer, so every member of a
 * workspace has identical, read-write reach over every key in it. Implementing either needs a
 * grant table and the agent/permission repositories in `packages/core/src/db/repositories/**`
 * (W2-DB-02's) plus W2-CP-06's RBAC decision point — none of them in this task's `Owns` globs.
 * An earlier revision of this header quoted §16's bullet list truncated at "preview metadata" and
 * presented that as the whole of what §16 asks for; it is not, and the missing two are a gap, not
 * an omission from the specification.
 *
 * **Declared gap**: creating an *empty* folder — one with nothing under it yet — is not supported.
 * `packages/core/src/db/schema/files.ts` already models a folder as a row with
 * `kind: 'folder'` for exactly this reason ("an empty folder has no file under it to imply it"),
 * but that table's repository is `packages/core/src/db/repositories/**`, outside this task's
 * `Owns` globs. `list()` reports a folder once something is `put` under it; an explicitly empty
 * one is future work for whoever wires this API to that table.
 *
 * ## Downloads are served as inert attachments, never as the uploader's chosen media type
 *
 * See {@link downloadContentType}. Verification round 1 demonstrated stored XSS through this
 * route: `GET /api/files/:id` echoed the uploader's own `Content-Type` verbatim, so any workspace
 * member could upload `<script>…</script>` as `text/html` and have the application's own origin
 * serve it as active content to another member.
 */
import { PRESIGNED_URL_DEFAULT_TTL_SECONDS } from '@indx-workspace/contracts/files';

import { problemBody } from '../http/result';
import { log } from '../telemetry/logger';
import { SKILL_REVISIONS_PREFIX, SKILL_ROWS_ROOT } from '../skills/keys';
import { decodeFileId, encodeFileId } from './file-id';
import { isUploadInProgress } from './store';
import {
  toObjectKey,
  toObjectPrefix,
  UnsafeObjectKeyError,
} from '@agent-workspace/core/storage/keys';
import {
  SignedUrlUnsupportedError,
  type SignedUrl,
  type SignedUrlRequest,
} from '@agent-workspace/core/storage';

import type { StorageContext, StorageService } from '../storage/service';
import type { CatalogFile, CatalogPort } from '../storage/store';

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

const revisionsImmutable = (): FileResult =>
  problem(400, 'reserved_path', 'Published skill revisions are immutable.');

/** A status and a body, before either becomes an HTTP `Response`. `kind` tags the json, binary and empty arms. */
export type FileResult =
  | { readonly status: number; readonly kind: 'json'; readonly body: unknown }
  | {
      readonly status: number;
      readonly kind: 'binary';
      readonly body: Uint8Array;
      /** Already reduced to an inert type by {@link downloadContentType}; never caller text. */
      readonly contentType: string;
      /** The file's own name, for `http.ts`'s `Content-Disposition: attachment`. */
      readonly filename: string;
    }
  | {
      readonly status: number;
      readonly kind: 'stream';
      /** Handed to the response as is: the object is never held whole in memory. */
      readonly body: ReadableStream<Uint8Array>;
      readonly sizeBytes: number;
      /** Reduced by {@link downloadContentType}, as for the binary arm. */
      readonly contentType: string;
      readonly filename: string;
    }
  | { readonly status: 204; readonly kind: 'empty' };

export function problem(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): FileResult {
  return { status, kind: 'json', body: problemBody(code, message, details) };
}

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

function json(status: number, body: unknown): FileResult {
  return { status, kind: 'json', body };
}

/** One file or folder, as the API represents it. `id` is what `/api/files/:id` takes. */
export interface FileResource {
  readonly id: string;
  readonly path: string;
  readonly kind: 'file' | 'folder';
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
  readonly lastModified: string | null;
}

export function toResource(
  entry:
    | {
        readonly kind: 'file';
        readonly key: string;
        readonly sizeBytes: number;
        readonly contentType: string | null;
        readonly lastModified: Date;
      }
    | { readonly kind: 'folder'; readonly key: string },
): FileResource {
  return entry.kind === 'file'
    ? {
        id: encodeFileId(entry.key),
        path: entry.key,
        kind: 'file',
        sizeBytes: entry.sizeBytes,
        contentType: entry.contentType,
        lastModified: entry.lastModified.toISOString(),
      }
    : {
        id: encodeFileId(entry.key),
        path: entry.key,
        kind: 'folder',
        sizeBytes: null,
        contentType: null,
        lastModified: null,
      };
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

/**
 * Every media type this route will name in a download response. A stored content type is looked up
 * in this table and the **table's own string** is returned; a type that is not in it becomes
 * `application/octet-stream`. That is the ADR-0015 shape — a positive assertion over a closed set,
 * with an explicit rejecting `else` — and it is deliberately not "reject the dangerous ones": a
 * blocklist of active types has to be complete to be safe, and `text/html`, `image/svg+xml`,
 * `application/xhtml+xml`, `text/xml` and `application/xml` are only the ones anyone remembers.
 *
 * Nothing here executes in a browsing context when it is served with `nosniff` and
 * `Content-Disposition: attachment`, which `http.ts` adds to every binary response. The three
 * defences are independent on purpose: any one of them alone closes the hole verification round 1
 * found, and none of them depends on this table being exhaustive.
 */
const DOWNLOADABLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/octet-stream',
  'application/pdf',
  // The two office formats spec §16's own tree illustration names (`pricing.xlsx`,
  // `report-template.docx`).
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
]);

/** What this route serves as `Content-Type` for a stored object. See the table above. */
export function downloadContentType(stored: string | null): string {
  if (stored === null) return 'application/octet-stream';
  // Parse before comparing (ADR-0015): a stored value is a full header line, so strip any
  // parameters (`; charset=…`) and case-fold before the lookup rather than matching the raw text.
  const essence = stored.split(';')[0]?.trim().toLowerCase() ?? '';
  if (DOWNLOADABLE_CONTENT_TYPES.has(essence)) return essence;
  return 'application/octet-stream';
}

/**
 * `GET /api/files?path=…` from the catalog: the ready files of the area one level under `path`, and
 * the folders between (an explicit folder row, or one implied by a file beneath it). Pending and
 * removed rows are not ready, so they never appear. A catalog row carries no timestamp, so
 * `lastModified` is `null`.
 *
 * ponytail: reads every ready row at or under `path` to build one level (twice: files through the
 * service, folder rows through the catalog); a one-level `list` on the catalog port if a folder
 * holds many.
 */
// @story US-STO-01
export async function listCatalogFolder(
  storage: StorageService,
  catalog: CatalogPort,
  ctx: StorageContext,
  rawPath: string | null,
): Promise<FileResult> {
  let folder: string;
  try {
    folder = toObjectPrefix(rawPath ?? '');
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) {
      return problem(
        400,
        'invalid_path',
        `The "path" query parameter is not valid: ${error.message}`,
      );
    }
    throw error;
  }
  const base = folder === '' ? '' : `${folder}/`;
  const entries = new Map<string, FileResource>();
  const folderAt = (path: string, id: string): FileResource => ({
    id,
    path,
    kind: 'folder',
    sizeBytes: null,
    contentType: null,
    lastModified: null,
  });

  let cursor: string | undefined;
  do {
    const page = await storage.list(
      ctx,
      'files',
      folder,
      cursor === undefined ? undefined : { cursor },
    );
    for (const row of page.rows) {
      if (!row.path.startsWith(base)) continue;
      const rest = row.path.slice(base.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.set(row.path, {
          id: row.id,
          path: row.path,
          kind: 'file',
          sizeBytes: row.sizeBytes,
          contentType: row.contentType,
          lastModified: null,
        });
      } else {
        const directory = `${base}${rest.slice(0, slash)}`;
        if (!entries.has(directory))
          entries.set(directory, folderAt(directory, encodeFileId(directory)));
      }
    }
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);

  cursor = undefined;
  do {
    const page = await catalog.list(folder, cursor === undefined ? undefined : { cursor });
    for (const row of page.rows) {
      if (row.kind !== 'folder' || !row.path.startsWith(base)) continue;
      // Saving a skill adds folder rows above it; a user's file under `.skills/` still implies its
      // folder through the files loop above.
      // @story US-STO-08
      if (isUnderSkillRows(row.path)) continue;
      const rest = row.path.slice(base.length);
      if (rest !== '' && !rest.includes('/')) entries.set(row.path, folderAt(row.path, row.id));
    }
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);

  const files = [...entries.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return json(200, { files });
}

/**
 * `GET /api/files/:id` from the catalog: the ready file's object as a stream, or a folder's
 * metadata. A pending, removed or other-area row answers `404`, as does a row whose object is gone.
 */
// @story US-STO-05
export async function downloadCatalogRow(
  storage: StorageService,
  catalog: CatalogPort,
  ctx: StorageContext,
  path: string,
): Promise<FileResult> {
  const notFound = () => problem(404, 'file_not_found', 'No file has that id.');
  const row = await storage.get(ctx, 'files', path);
  if (row === null) {
    const folder = await catalog.get(path);
    if (folder?.kind !== 'folder') return notFound();
    return json(200, {
      file: {
        id: folder.id,
        path: folder.path,
        kind: 'folder',
        sizeBytes: null,
        contentType: null,
        lastModified: null,
      } satisfies FileResource,
    });
  }
  const opened = await storage.open(ctx, row);
  if (opened === null) return notFound();
  return {
    status: 200,
    kind: 'stream',
    body: opened.body,
    sizeBytes: opened.meta.sizeBytes,
    contentType: downloadContentType(row.contentType),
    filename: path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path,
  };
}

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
  if (!renamed.ok) {
    switch (renamed.code) {
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
  // ponytail: a file added under the folder between this listing and `remove` goes too, unlisted.
  const deleted: string[] = [];
  if (row?.kind === 'folder' && recursive) {
    let cursor: string | undefined;
    do {
      const page = await catalog.list(path, cursor === undefined ? undefined : { cursor });
      for (const found of page.rows) if (found.kind === 'file') deleted.push(found.path);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
  }
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
    ? json(200, { status: 'ok', deleted })
    : { status: 204, kind: 'empty' };
}

function catalogResource(row: CatalogFile): FileResource {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    sizeBytes: row.kind === 'file' ? row.sizeBytes : null,
    contentType: row.kind === 'file' ? row.contentType : null,
    lastModified: null,
  };
}

/**
 * `Content-Disposition` for a download, in the two-form shape RFC 6266 §4.3 specifies: a quoted
 * ASCII `filename` every client understands, and a `filename*` carrying the real name in
 * `UTF-8''`-percent-encoded form for the ones that do.
 *
 * The ASCII form is built from a positive character set — letters, digits and a short list of
 * punctuation — with everything else replaced, rather than by deleting the characters that would
 * break the quoting. A key is a caller-supplied string, so a name containing `"`, `\`, a newline or
 * a `;` must not be able to close the quoted string and add a header parameter of its own, and a
 * substitution that starts from what is *allowed* cannot miss a case the way one that starts from
 * what is forbidden can (ADR-0015).
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  // `filename` comes from a key that passed `key-safety.ts`, so it is never empty and has no `/`;
  // the fallback is here because this function must produce a well-formed header regardless.
  const quoted = ascii === '' ? 'download' : ascii;
  return `attachment; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

/** Whether `path` is under `.skills/`, where the catalog keeps the files of skills (US-STO-08). */
function isUnderSkillRows(path: string): boolean {
  try {
    return toObjectKey(path).split('/', 1)[0]?.toLowerCase() === SKILL_ROWS_ROOT;
  } catch {
    return false;
  }
}

/** `400 reserved_path` under `.skills/`: a skill's rows move only through `/api/skills`. */
function skillRowsReserved(): FileResult {
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

/**
 * Whether a skill row sits at or under `path`: a rename or recursive delete there would carry it
 * with the user's rows, so the files API refuses it.
 */
// @story US-STO-08
async function holdsSkillRows(catalog: CatalogPort, path: string): Promise<boolean> {
  if (!isUnderSkillRows(path)) return false;
  let cursor: string | undefined;
  do {
    const page = await catalog.list(path, cursor === undefined ? undefined : { cursor });
    if (page.rows.some((row) => row.area === 'skills')) return true;
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return false;
}

export function directTransferUnsupported(): FileResult {
  return problem(
    501,
    'direct_transfer_unsupported',
    'This deployment’s object store cannot sign URLs; use the upload and download routes instead.',
  );
}

/** What a presign request carries once parsed against its contract. */
export interface PresignInput {
  readonly ttlSeconds?: number | undefined;
}

export interface PresignUploadInput extends PresignInput {
  readonly contentType?: string | null | undefined;
  readonly sizeBytes: number;
}

/**
 * Signs `path` through `sign` and answers the `201` link, or a typed refusal. A store that cannot
 * sign what was asked (Azure Blob cannot bind a required upload length) is the same `501` as one that
 * cannot sign at all; any other failure is `502 storage_unavailable`, logged by the error's name
 * only, because a provider's message can carry the very link being signed (storage design §05).
 */
async function presigned(
  sign: (key: string, request: SignedUrlRequest) => Promise<SignedUrl | null>,
  path: string,
  request: SignedUrlRequest & { readonly expiresInSeconds: number; readonly now: Date },
): Promise<FileResult> {
  let signed: SignedUrl | null;
  try {
    signed = await sign(path, request);
  } catch (error) {
    if (error instanceof SignedUrlUnsupportedError) return directTransferUnsupported();
    log.error('[files] signing failed', {
      name: error instanceof Error ? error.name : typeof error,
    });
    return problem(502, 'storage_unavailable', 'The object store could not sign a link; retry.');
  }
  if (signed === null) return problem(404, 'file_not_found', 'No file has that id.');
  return json(201, {
    url: signed.url,
    method: request.method,
    headers: signed.headers,
    expiresAt: new Date(request.now.getTime() + request.expiresInSeconds * 1000).toISOString(),
    path,
  });
}

/**
 * `POST /api/files/:id/download-urls` from the catalog: the ready file's own object, signed by the
 * store that holds it. A pending, removed, other-area or absent row answers `404`, as does a
 * legacy row with no storage key or no legacy store for its area. A presign does not check that
 * the object exists, so a link to a vanished object is still minted and fails only when fetched.
 * The link forces the same inert delivery the relay does: a type from the closed table and
 * `Content-Disposition: attachment`.
 */
// @story US-STO-05
export async function presignCatalogDownload(
  storage: StorageService,
  ctx: StorageContext,
  path: string,
  input: PresignInput,
  now: Date = new Date(),
): Promise<FileResult> {
  const row = await storage.get(ctx, 'files', path);
  if (row === null) return problem(404, 'file_not_found', 'No file has that id.');
  const ttl = input.ttlSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS;
  return presigned(
    () =>
      storage.signDownload(ctx, row, {
        ttlSeconds: ttl,
        responseContentType: downloadContentType(row.contentType),
        responseDisposition: contentDisposition(path.slice(path.lastIndexOf('/') + 1)),
        now,
      }),
    path,
    { method: 'GET', expiresInSeconds: ttl, now },
  );
}
