/**
 * The one catalog service. `save` is the four steps of the storage design, §04 "Saving a file":
 * reserve a pending row, write the object under a new id, confirm the row, clean up what was
 * replaced. Web uploads, API uploads, chat attachments, skill imports and run outputs all save
 * through it, and a signed-link upload takes the same steps split in two: `reserveUpload` signs a
 * `PUT` on the new object, `completeUpload` verifies and confirms it. `list`, `get`, `open` and
 * `signDownload` read by catalog row, `rename` changes the row alone (a legacy row's object moves
 * with it), and `remove` deletes the object, not just the row (the storage design, §04 "File
 * states", §05).
 */
import { SESSION_STATE_BLOB_MAX_BYTES } from '@agent-workspace/engine';
import type { EngineId } from '@indx-workspace/contracts/engines';
import type { AuditAction } from '@indx-workspace/contracts/observability';
import {
  inferContentType,
  newObjectId,
  ObjectConflictError,
  SignedUrlUnsupportedError,
  storageObjectName,
  toObjectKey,
  UnsafeObjectKeyError,
  type ByteRange,
  type ObjectStoreProvider,
  type ObjectStore,
  type ObjectStream,
  type SignedUrl,
  type StorageArea,
} from '@agent-workspace/core/storage';
import {
  MAX_PENDING_UPLOADS_PER_WORKSPACE,
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  PRESIGNED_URL_MAX_TTL_SECONDS,
  PRESIGNED_URL_MIN_TTL_SECONDS,
} from '@indx-workspace/contracts/files';
import type { Logger } from '@agent-workspace/core/telemetry';

import { CLEANUP_MIN_AGE_MS } from './cleanup';
import { BodyTooLargeError, measure } from './measure';
import { promoteUpload } from './promote-upload';
import {
  isPathPending,
  isPathTaken,
  renamedKey,
  type CatalogFile,
  type CatalogPort,
} from './store';

/** Who acted, for the audit row: the signed-in principal, never a request field. */
interface StorageActor {
  readonly principalId: string;
  readonly userId: string | null;
  readonly label: string;
}

/** One row of the audit trail for a file action (the storage design, §05). No URL, ever. */
export interface StorageAuditEvent {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action: Extract<
    AuditAction,
    'file-uploaded' | 'file-downloaded' | 'file-link-created' | 'file-moved' | 'file-deleted'
  >;
  /** The file's row id. */
  readonly subjectId: string;
  /** Its path; `from -> to` for a move. */
  readonly subjectLabel: string;
}

export interface StorageContext {
  /** From the signed-in principal only — never from the request body or a header (the storage design, §04). */
  readonly workspaceId: string;
  /** The owner stamped on new rows. */
  readonly principalId: string;
  readonly userId: string | null;
  /**
   * Set by a caller that acts for a signed-in principal; only then is a file action audited. A
   * system caller (retention, the run-output promotion) leaves it out.
   */
  readonly actor?: StorageActor;
}

/** A session-state blob's catalog row (`session_state_blobs`), as far as a save needs it. */
export interface SessionStateBlobCatalog {
  putBlob(
    sessionId: string,
    blob: {
      readonly engine: EngineId;
      readonly blobKey: string;
      readonly objectId: string;
      readonly storageKey: string;
      readonly sizeBytes: number;
      readonly sha256: string;
    },
  ): Promise<{
    readonly replaced: { readonly objectId: string | null; readonly storageKey: string } | null;
  }>;
}

/** The object a row names: enough to find its bytes, new naming or old. */
type ObjectRow = Pick<CatalogFile, 'area' | 'objectId' | 'storageKey'>;

export interface SaveInput {
  readonly area: StorageArea;
  /** The catalog path, checked with `toObjectKey`. */
  readonly path: string;
  readonly body: ReadableStream<Uint8Array>;
  /** The caller's one limit constant. */
  readonly maxBytes: number;
  /** The type the uploader declared; absent or `null`, the path's extension decides. */
  readonly contentType?: string | null | undefined;
  /**
   * `false`: a ready row at the path answers `path_taken`. A policy is asked about that row and
   * answers the same `path_taken` when it refuses.
   */
  readonly replace: boolean | ReplacePolicy;
}

/**
 * May this caller overwrite `target`? `target` is the ready file the reservation will replace, as
 * the catalog read it under its path lock (`ReserveOutcome.replaces`), never a fresh read of the
 * path: a path can be renamed away and reused between the two, and the replacement follows the
 * file it was reserved against.
 */
type ReplacePolicy = (target: CatalogFile) => Promise<boolean>;

/**
 * `path_taken`: a row at the path cannot be replaced, by this save's `replace`. `path_changed`: the
 * pending row was removed or moved while the bytes were written, so nothing was confirmed; the
 * object is gone and the caller may retry.
 */
export type SaveResult =
  | { readonly ok: true; readonly row: CatalogFile }
  | {
      readonly ok: false;
      readonly code:
        'path_taken' | 'upload_in_progress' | 'too_large' | 'invalid_path' | 'path_changed';
    };

/** `too_large`: the body passed the limit; the object and its staging row are gone. */
type StageResult =
  | { readonly ok: true; readonly row: CatalogFile }
  | { readonly ok: false; readonly code: 'too_large' };

type CreateFolderResult =
  | { readonly ok: true; readonly row: CatalogFile }
  | {
      readonly ok: false;
      readonly code: 'invalid_path' | 'name_conflict' | 'upload_in_progress';
    };

type RenameResult =
  // `moved`: the files moved. A folder's own rows move too but are not counted.
  | { readonly ok: true; readonly moved: number }
  | {
      readonly ok: false;
      readonly code: 'not_found' | 'path_taken' | 'upload_in_progress' | 'invalid_path';
    };

type RemoveResult =
  /** `files`: the real path of every file this call removed, in path order. */
  | { readonly ok: true; readonly removed: number; readonly files: readonly string[] }
  | { readonly ok: false; readonly code: 'not_found' | 'not_empty' | 'invalid_path' };

interface SignDownloadRequest {
  /** Defaults to the contract's default lifetime. */
  readonly ttlSeconds?: number | undefined;
  /** The closed content type the link answers with, whatever was stored. */
  readonly responseContentType: string;
  /** The `Content-Disposition` the link answers with: an attachment. */
  readonly responseDisposition: string;
  readonly now?: Date;
}

interface ReserveUploadRequest {
  readonly path: string;
  /** Declared by the caller; completion accepts exactly this many bytes. */
  readonly sizeBytes: number;
  /** The type the signed `PUT` is bound to, when the caller named one. */
  readonly contentType?: string | null | undefined;
  /** Defaults to the contract's default lifetime. */
  readonly ttlSeconds?: number | undefined;
  readonly now?: Date;
  /** Asked only when the upload would replace a ready file: may this caller overwrite it? */
  readonly mayReplace: ReplacePolicy;
}

/**
 * `upload_in_progress`: another member's pending upload holds the path. `name_conflict`: a folder
 * or a ready row we cannot replace does. `too_many_pending`: the workspace is at its pending-upload
 * cap. `replace_refused`: the path holds a ready file the caller may not overwrite.
 * `sign_unsupported` / `sign_failed`: the store cannot sign, or failed to. A refusal leaves no
 * row of this call behind.
 */
type ReserveUploadResult =
  | { readonly ok: true; readonly url: SignedUrl; readonly expiresAt: Date }
  | {
      readonly ok: false;
      readonly code:
        | 'invalid_path'
        | 'upload_in_progress'
        | 'name_conflict'
        | 'too_many_pending'
        | 'replace_refused'
        | 'sign_unsupported'
        | 'sign_failed';
    };

/**
 * `not_found`: no upload and no file at the path. `not_verified`: the object is missing, or the
 * path holds a ready file that is not this upload; the row stays pending so the `PUT` can be
 * retried. `size_mismatch`: the object is smaller than declared, the row stays pending.
 * `too_large`: the object was over the declared size or the limit, so it and its pending row are
 * gone and the ready file, if any, is untouched. `upload_in_progress`: the pending row is a relay
 * save in flight, or another principal's upload; nothing is read or deleted.
 */
type CompleteUploadResult =
  | { readonly ok: true; readonly row: CatalogFile }
  | {
      readonly ok: false;
      readonly code:
        | 'invalid_path'
        | 'not_found'
        | 'not_verified'
        | 'size_mismatch'
        | 'too_large'
        | 'upload_in_progress';
    };

export interface StorageService {
  /**
   * Reserve a pending row under a new object id and sign a `PUT` for it. A ready file at the path
   * is never written to: the row waits at a side path and completion swaps it in. Signs with the
   * length bound when the store can bind it. Throws only catalog failures.
   */
  reserveUpload(ctx: StorageContext, request: ReserveUploadRequest): Promise<ReserveUploadResult>;
  /**
   * Verify the object a signed `PUT` wrote (size, then SHA-256 while copying it to an object no
   * link names, `promote-upload.ts`) and confirm the pending row on that copy, deleting the object
   * it replaced. Completing a file that is already ready with its object in place answers it again.
   */
  completeUpload(
    ctx: StorageContext,
    request: { readonly path: string; readonly maxBytes: number },
  ): Promise<CompleteUploadResult>;
  save(ctx: StorageContext, input: SaveInput): Promise<SaveResult>;
  /**
   * Write a temporary object in area `staging` under a pending row that is never confirmed, so no
   * list shows it (the storage design, §04 "Where files live"). The caller ends it with `unstage`;
   * the cleanup job deletes one that was left.
   */
  stage(
    ctx: StorageContext,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
  ): Promise<StageResult>;
  /** Delete a staged object, then its row; a failed delete keeps the row for the cleanup job. */
  unstage(ctx: StorageContext, row: CatalogFile): Promise<void>;
  /**
   * A folder is a catalog row and nothing else: no marker object is written. A path any row holds
   * is `name_conflict`, or `upload_in_progress` when that row is a pending upload.
   */
  createFolder(ctx: StorageContext, path: string): Promise<CreateFolderResult>;
  /** Ready files of `area` at or under `folder`. A page may be short: other areas are filtered out of it. */
  list(
    ctx: Pick<StorageContext, 'workspaceId'>,
    area: StorageArea,
    folder: string,
    page?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<{ readonly rows: readonly CatalogFile[]; readonly cursor: string | null }>;
  /** A ready file only: never a pending upload or a removed row. */
  get(ctx: StorageContext, area: StorageArea, path: string): Promise<CatalogFile | null>;
  /** The row's object, or `null` when it has none (or no store for its old naming is configured). */
  open(
    ctx: Pick<StorageContext, 'workspaceId' | 'actor'>,
    row: ObjectRow & { readonly id?: string; readonly path?: string },
    range?: ByteRange,
  ): Promise<ObjectStream | null>;
  /**
   * Saves one session-state blob the same four steps: the bytes go to a new object under
   * `session-state`, the blob row is confirmed in one transaction after the write, and the replaced
   * blob's object is deleted last. Over {@link SESSION_STATE_BLOB_MAX_BYTES} nothing is left behind.
   */
  saveSessionState(
    ctx: Pick<StorageContext, 'workspaceId'>,
    ref: { readonly sessionId: string; readonly engine: EngineId; readonly blobKey: string },
    body: ReadableStream<Uint8Array>,
  ): Promise<
    | { readonly ok: true; readonly sizeBytes: number; readonly sha256: string }
    | { readonly ok: false; readonly code: 'too_large' }
  >;
  /** Deletes the row's object, new naming or old; a failure is logged and left to the cleanup job. */
  deleteObject(ctx: Pick<StorageContext, 'workspaceId'>, row: ObjectRow): Promise<void>;
  /**
   * A short-lived `GET` link on the row's own object, signed by the store that holds it (new or
   * legacy naming, as `open`), so it points at the storage domain and not at this app. `null` only
   * when no store locates the row (no object id, or no store for its old naming is configured);
   * whether the object itself still exists is not checked, signing is offline. Throws {@link SignedUrlUnsupportedError} when that store cannot sign or
   * the lifetime is outside the contract's bounds. The link is returned, never logged.
   */
  signDownload(
    ctx: StorageContext,
    row: CatalogFile,
    request: SignDownloadRequest,
  ): Promise<SignedUrl | null>;
  /**
   * Row update only for rows with an object id: no object is read, written or copied. A legacy
   * row's object is copied to its new key first, and its old key deleted after. A folder moves
   * every row under it.
   */
  rename(ctx: StorageContext, area: StorageArea, from: string, to: string): Promise<RenameResult>;
  /** Marks the rows `deleting`, deletes each object, then drops the row; a failed delete keeps it. */
  remove(
    ctx: Pick<StorageContext, 'workspaceId' | 'actor'>,
    area: StorageArea,
    path: string,
    opts: { readonly recursive: boolean },
  ): Promise<RemoveResult>;
}

/** The lifetime a link is signed for, or `null` when it is outside the contract's bounds. */
function linkLifetime(ttlSeconds: number | undefined): number | null {
  const seconds = ttlSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS;
  return Number.isInteger(seconds) &&
    seconds >= PRESIGNED_URL_MIN_TTL_SECONDS &&
    seconds <= PRESIGNED_URL_MAX_TTL_SECONDS
    ? seconds
    : null;
}

/**
 * Whether a pending replacement may overwrite `target`, the ready file its reserve locked. A
 * replacement the catalog named no target for is refused rather than decided on a path.
 */
async function mayReplace(
  replace: boolean | ReplacePolicy,
  target: CatalogFile | undefined,
): Promise<boolean> {
  if (target === undefined) return false;
  return typeof replace === 'boolean' ? replace : replace(target);
}

/**
 * Whether a row answers a read for `area`. A `staging` row is never listed. An `artifacts` row
 * (a run output) lists as `files`: the area only decides which folder its object sits in.
 */
function listedIn(row: CatalogFile, area: StorageArea): boolean {
  const own = row.area ?? 'files';
  return own !== 'staging' && (own === area || (own === 'artifacts' && area === 'files'));
}

export function createStorageService(deps: {
  readonly catalog: (workspaceId: string) => Promise<CatalogPort>;
  /** Unscoped, rooted at the `AW_STORAGE_URL` prefix. */
  readonly objects: ObjectStore;
  /** The area stores of the old naming, for rows without an object id. */
  readonly legacy?: Partial<Readonly<Record<StorageArea, ObjectStoreProvider>>>;
  /** The session-state blob catalog of a workspace; absent where no database holds one. */
  readonly sessionState?: (workspaceId: string) => Promise<SessionStateBlobCatalog>;
  /**
   * Appends one audit row. Awaited after the action committed, and a rejection reaches the caller:
   * what was done is never rolled back or deleted, but a download or a link is not handed out
   * unaudited, and an upload, move or delete answers an error the caller can see and retry. This
   * is how the other domains behave (`composition/services.ts`). Honest limit: a retry after a
   * failed audit write does not re-audit an upload complete, a move or a delete that already
   * committed (the retry finds nothing left to do), so such an action can stay unaudited; the
   * caller sees the error, nothing more. Absent where no database holds a trail (tests of other
   * features).
   */
  readonly audit?: (event: StorageAuditEvent) => Promise<void>;
  readonly log: Logger;
}): StorageService {
  const { objects, log } = deps;

  /** Record `action` on `row` for the acting principal, if the caller named one. */
  async function audit(
    ctx: Pick<StorageContext, 'workspaceId' | 'actor'>,
    action: StorageAuditEvent['action'],
    row: Pick<CatalogFile, 'id' | 'path'>,
    label: string = row.path,
  ): Promise<void> {
    const { actor } = ctx;
    if (deps.audit === undefined || actor === undefined) return;
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorPrincipalId: actor.principalId,
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action,
      subjectId: row.id,
      subjectLabel: label,
    });
  }

  const deleteObject = (name: string, store: ObjectStore = objects): Promise<boolean> =>
    store.delete(name).then(
      () => true,
      (error: unknown) => {
        log.warn('[storage] could not delete an object; the cleanup job will', {
          name,
          error,
        });
        return false;
      },
    );

  /** Where a row's bytes are: the root store by object id, or the old area store by storage key. */
  function locate(workspaceId: string, row: ObjectRow) {
    const area = row.area ?? 'files';
    const objectId = row.objectId ?? null;
    if (objectId !== null) {
      return { store: objects, name: storageObjectName(workspaceId, area, objectId) };
    }
    // storage-bridge(#1699): dual read of rows still in the old naming
    const legacy = deps.legacy?.[area];
    if (legacy === undefined || row.storageKey === null) return null;
    return { store: legacy.forWorkspace(workspaceId), name: row.storageKey };
  }

  // storage-bridge(#1699): legacy rows still carry their path in the object key
  /** The legacy objects a rename of `from` to `to` moves: old and new key, on the row's area store. */
  async function legacyMoves(catalog: CatalogPort, workspaceId: string, from: string, to: string) {
    const moves: { store: ObjectStore; from: string; to: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await catalog.list(from, cursor === undefined ? undefined : { cursor });
      for (const row of page.rows) {
        if (row.kind !== 'file' || (row.objectId ?? null) !== null) continue;
        const object = locate(workspaceId, row);
        if (object === null) continue;
        moves.push({ ...object, from: object.name, to: renamedKey(object.name, from, to) });
      }
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    return moves;
  }

  // storage-bridge(#1699): a row the copy stage switched keeps its old key and its old object
  /**
   * The old object of a file row that was switched to the new naming, if one may still be there.
   * It goes with the row: a row-less old file would be adopted again and bring a removed file back.
   * A legacy row that now holds that key (a one-step write at the old path after a rename) owns
   * those bytes, so the twin is then `null`, as it is when that lookup fails.
   */
  async function oldTwin(workspaceId: string, row: ObjectRow) {
    const objectId = row.objectId ?? null;
    const area = row.area ?? 'files';
    const legacy = deps.legacy?.[area];
    if (objectId === null || area !== 'files' || row.storageKey === null || legacy === undefined) {
      return null;
    }
    const name = row.storageKey;
    if (name === `${area}/${objectId}`) return null;
    const held = await deps
      .catalog(workspaceId)
      .then((catalog) => catalog.referencing({ objectIds: [], storageKeys: [name] }))
      .then(
        (rows) => rows.length > 0,
        (error: unknown) => {
          log.warn('[storage] could not check an old-naming object; it is left in place', {
            error,
          });
          return true;
        },
      );
    return held ? null : { store: legacy.forWorkspace(workspaceId), name };
  }

  /** Delete a row's object, new naming or old; a failure is logged and left to the cleanup job. */
  async function deleteRowObject(workspaceId: string, row: ObjectRow) {
    const object = locate(workspaceId, row);
    if (object === null) {
      log.warn(
        "[storage] no store for a replaced or purged row's old-naming object; it is left in place",
      );
      return;
    }
    await deleteObject(object.name, object.store);
    const twin = await oldTwin(workspaceId, row);
    if (twin !== null) await deleteObject(twin.name, twin.store);
  }

  /**
   * Claim a pending row for deletion before its object goes (`remove` with the snapshot): only the
   * unchanged reservation `row` saw is claimed, so a row confirmed or reserved again since keeps
   * its bytes. `null` when nothing was claimed; a failed claim is logged and left to the cleanup job.
   */
  async function claimPending(catalog: CatalogPort, row: CatalogFile): Promise<CatalogFile | null> {
    try {
      const [claimed] = await catalog.remove(row.targetPath ?? row.path, { pending: row });
      return claimed ?? null;
    } catch (error) {
      log.warn('[storage] could not claim a pending row; the cleanup job will', {
        rowId: row.id,
        error,
      });
      return null;
    }
  }

  /**
   * Remove the upload pending at `path` when no ready file holds it: its reservation is claimed,
   * then its object and row go, as for a removed file. The route has already decided the caller
   * may (STO-111 #2). `not_found` when nothing is pending there either.
   */
  async function removePending(
    ctx: Pick<StorageContext, 'workspaceId' | 'actor'>,
    catalog: CatalogPort,
    area: StorageArea,
    path: string,
  ): Promise<RemoveResult> {
    const pending = await catalog.get(path, { includePending: true });
    if (pending?.status !== 'pending' || !listedIn(pending, area)) {
      return { ok: false, code: 'not_found' };
    }
    const claimed = await catalog.remove(path, { pending });
    // Nothing claimed: the upload completed, or another delete took it, since it was read.
    if (claimed.length === 0) return { ok: false, code: 'not_found' };
    for (const r of claimed) await discard(catalog, ctx.workspaceId, r);
    if (area === 'files') await audit(ctx, 'file-deleted', pending, path);
    return { ok: true, removed: claimed.length, files: [path] };
  }

  /**
   * Delete a removed row's object, then drop the row; a failure leaves it `deleting` for the cleanup
   * job. A pending row is claimed first, and left alone when it changed since it was read.
   */
  async function discard(catalog: CatalogPort, workspaceId: string, row: CatalogFile) {
    const object = locate(workspaceId, row);
    if (object === null) {
      log.warn("[storage] no store for a removed row's object; the cleanup job will", {
        rowId: row.id,
      });
      return;
    }
    const doomed = row.status === 'pending' ? await claimPending(catalog, row) : row;
    if (doomed === null) return;
    if (!(await deleteObject(object.name, object.store))) return;
    const twin = await oldTwin(workspaceId, doomed);
    if (twin !== null && !(await deleteObject(twin.name, twin.store))) return;
    await catalog.forget(doomed).catch((error: unknown) => {
      log.warn('[storage] could not forget a removed row; the cleanup job will', {
        rowId: row.id,
        error,
      });
    });
  }

  /**
   * Remove the pending row of a save or link that did not finish, then the object `name` it wrote.
   * Only the reservation `row` saw is forgotten, and the object goes only when no live row
   * references it by object id, which no rename changes: a row another caller confirmed keeps its
   * bytes, and a removed (`deleting`) row's object goes with that row anyway. A failed `forget` or
   * lookup keeps the object for the cleanup job.
   */
  async function abandon(catalog: CatalogPort, row: CatalogFile, name: string | null) {
    await catalog.forget(row).catch((error: unknown) => {
      log.warn('[storage] could not forget a pending row; the cleanup job will', {
        rowId: row.id,
        error,
      });
    });
    const objectId = row.objectId ?? null;
    if (name === null || objectId === null) return;
    const held = await catalog.referencing({ objectIds: [objectId], storageKeys: [] }).then(
      (rows) => rows.some((other) => other.status !== 'deleting'),
      (error: unknown) => {
        log.warn('[storage] could not check a saved object; the cleanup job will', { error });
        return true;
      },
    );
    if (!held) await deleteObject(name);
  }

  return {
    // @story US-STO-02
    async reserveUpload(ctx, request) {
      let path: string;
      try {
        path = toObjectKey(request.path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const expiresInSeconds = linkLifetime(request.ttlSeconds);
      if (expiresInSeconds === null || objects.createSignedUrl === undefined) {
        return { ok: false, code: 'sign_unsupported' };
      }
      const catalog = await deps.catalog(ctx.workspaceId);

      let reserved;
      try {
        reserved = await catalog.reserve(path, {
          area: 'files',
          objectId: newObjectId(),
          ownerPrincipalId: ctx.principalId,
          uploadMode: 'signed',
          createdBy: ctx.userId,
          sizeBytes: request.sizeBytes,
          contentType: inferContentType(path),
        });
      } catch (error) {
        if (isPathPending(error)) return { ok: false, code: 'upload_in_progress' };
        throw error;
      }
      const row = reserved.row;
      if (reserved.kind === 'taken' && (row.kind === 'folder' || row.status !== 'pending')) {
        return { ok: false, code: 'name_conflict' };
      }
      // Only a row this call added is undone on a refusal; the caller's own earlier pending row stays.
      const added = reserved.kind === 'reserved';
      const undo = () => (added ? abandon(catalog, row, null) : Promise.resolve());

      const now = request.now ?? new Date();
      // Counted after the reserve, so re-minting a pending path never counts twice. A reservation
      // older than the longest link plus an hour can no longer be uploaded to, so it does not
      // count, whether or not the cleanup job has removed it yet (the storage design, §05).
      // Each mint counts after its own reservation commits, so the last one admitted counts every
      // admitted row and the cap is never exceeded.
      // ponytail: near the cap, concurrent mints can refuse each other until one undoes its row;
      // count inside reserve's transaction under a workspace lock if that matters.
      const fresh = new Date(now.getTime() - CLEANUP_MIN_AGE_MS);
      if (added && (await catalog.countPending(fresh)) > MAX_PENDING_UPLOADS_PER_WORKSPACE) {
        await undo();
        return { ok: false, code: 'too_many_pending' };
      }
      // A pending row at a side path replaces a ready file. Decided after the reserve, on the file
      // it read under its lock, so a file that appears or moves around the check is never
      // overwritten by mistake. A policy that fails releases this reservation and rethrows.
      if ((row.targetPath ?? null) !== null) {
        const allowed = await mayReplace(request.mayReplace, reserved.replaces).catch(
          async (error: unknown) => {
            await undo();
            throw error;
          },
        );
        if (!allowed) {
          await undo();
          return { ok: false, code: 'replace_refused' };
        }
      }
      const object = locate(ctx.workspaceId, row);
      if (object === null || object.store.createSignedUrl === undefined) {
        await undo();
        return { ok: false, code: 'sign_unsupported' };
      }

      let url: SignedUrl;
      try {
        url = await object.store.createSignedUrl(object.name, {
          method: 'PUT',
          expiresInSeconds,
          contentType: request.contentType ?? null,
          contentLength: request.sizeBytes,
          // Where the store cannot bind the length (Azure Blob), completion deletes an oversize object.
          requireBoundContentLength: object.store.capabilities.boundLengthSign,
          now,
        });
      } catch (error) {
        await undo();
        if (error instanceof SignedUrlUnsupportedError) {
          return { ok: false, code: 'sign_unsupported' };
        }
        // The name only: a provider's message can carry the very link being signed.
        log.error('[storage] signing an upload link failed', {
          name: error instanceof Error ? error.name : typeof error,
        });
        return { ok: false, code: 'sign_failed' };
      }
      // The storage design, §05: the row names the file, never the link or its signature.
      await audit(ctx, 'file-link-created', { id: row.id, path });
      return { ok: true, url, expiresAt: new Date(now.getTime() + expiresInSeconds * 1000) };
    },

    // @story US-STO-02
    async completeUpload(ctx, request) {
      let path: string;
      try {
        path = toObjectKey(request.path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const row = await catalog.pending(path);
      if (row === null) {
        // Completed already (a retry after a lost reply): the ready file answers again, if its
        // object is the one the row records.
        const ready = await catalog.get(path);
        if (ready === null || ready.kind !== 'file') return { ok: false, code: 'not_found' };
        const held = locate(ctx.workspaceId, ready);
        const meta = held === null ? null : await held.store.head(held.name);
        return meta !== null && meta.sizeBytes === ready.sizeBytes
          ? { ok: true, row: ready }
          : { ok: false, code: 'not_verified' };
      }

      // A relay row has no declared size until its save confirms, and the save owns its object:
      // measuring or discarding it here would delete an upload in flight.
      if (row.uploadMode === 'relay' || row.ownerPrincipalId !== ctx.principalId) {
        return { ok: false, code: 'upload_in_progress' };
      }
      const object = locate(ctx.workspaceId, row);
      const meta = object === null ? null : await object.store.head(object.name);
      if (object === null || meta === null) return { ok: false, code: 'not_verified' };
      // Only the new object and its pending row go: a ready file's bytes are never touched.
      const refuseLarge = async (): Promise<CompleteUploadResult> => {
        await discard(catalog, ctx.workspaceId, row);
        return { ok: false, code: 'too_large' };
      };
      if (meta.sizeBytes > row.sizeBytes || meta.sizeBytes > request.maxBytes) return refuseLarge();
      if (meta.sizeBytes !== row.sizeBytes) return { ok: false, code: 'size_mismatch' };

      // The checksum is of the bytes in the store, not of what the caller says it sent, and of the
      // copy no link can write, not of the object the link names (`promote-upload.ts`).
      const objectId = row.objectId ?? null;
      if (objectId === null) return { ok: false, code: 'not_verified' };
      const promoted = await promoteUpload(
        { objects, catalog, log },
        ctx.workspaceId,
        { ...row, objectId },
        Math.min(request.maxBytes, row.sizeBytes),
      );
      if (promoted.kind !== 'confirmed') {
        if (promoted.kind === 'too_large') return refuseLarge();
        if (promoted.kind === 'missing') return { ok: false, code: 'not_verified' };
        if (promoted.kind === 'size_mismatch') return { ok: false, code: 'size_mismatch' };
        // Confirmed by a concurrent complete, or the path moved while the object was read.
        const current = await catalog.get(path);
        return current !== null && current.id === row.id
          ? { ok: true, row: current }
          : { ok: false, code: 'not_found' };
      }
      const confirmed = promoted.outcome;
      if (confirmed.replaced !== undefined) {
        await discard(catalog, ctx.workspaceId, confirmed.replaced);
      }
      await audit(ctx, 'file-uploaded', confirmed.row);
      return { ok: true, row: confirmed.row };
    },

    // @story US-STO-01
    // @story US-STO-14
    async save(ctx, input) {
      // A refusal before the write releases the body's source instead of leaving it to GC.
      const refuse = async (
        code: 'path_taken' | 'upload_in_progress' | 'invalid_path',
      ): Promise<SaveResult> => {
        await input.body.cancel().catch(() => undefined);
        return { ok: false, code };
      };
      let path: string;
      try {
        path = toObjectKey(input.path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return refuse('invalid_path');
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const objectId = newObjectId();
      const contentType = input.contentType ?? inferContentType(path);

      // 1. Reserve. The database decides who wins the path.
      let reserved;
      try {
        reserved = await catalog.reserve(path, {
          area: input.area,
          objectId,
          ownerPrincipalId: ctx.principalId,
          uploadMode: 'relay',
          createdBy: ctx.userId,
          sizeBytes: 0,
          contentType,
        });
      } catch (error) {
        if (isPathPending(error)) return refuse('upload_in_progress');
        throw error;
      }
      if (reserved.kind === 'taken') {
        const pending = reserved.row.status === 'pending';
        return refuse(pending ? 'upload_in_progress' : 'path_taken');
      }
      const row = reserved.row;
      // A pending row at a side path is a replacement of a ready file. Checked after the reserve,
      // on the file it read under its lock, so a file that appears between the two cannot be
      // replaced by mistake. A policy that fails releases this reservation and the unread body,
      // and its error is the one the caller sees.
      if ((row.targetPath ?? null) !== null) {
        const allowed = await mayReplace(input.replace, reserved.replaces).catch(
          async (error: unknown) => {
            await abandon(catalog, row, null);
            await input.body.cancel().catch((cancelError: unknown) => {
              log.warn('[storage] could not cancel an upload body', { error: cancelError });
            });
            throw error;
          },
        );
        if (!allowed) {
          await abandon(catalog, row, null);
          return refuse('path_taken');
        }
      }

      // 2. Write, measuring in the stream.
      const name = storageObjectName(ctx.workspaceId, input.area, objectId);
      const measured = measure(input.maxBytes);
      try {
        await objects.write(name, input.body.pipeThrough(measured.stream), {
          ifNoneMatch: '*',
          contentType,
        });
      } catch (error) {
        // An object that was already there is not ours to delete.
        await abandon(catalog, row, error instanceof ObjectConflictError ? null : name);
        if (error instanceof BodyTooLargeError || measured.result().sizeBytes > input.maxBytes) {
          return { ok: false, code: 'too_large' };
        }
        throw error;
      }

      // 3. Confirm, in one catalog transaction that swaps the rows on a replace.
      let confirmed;
      try {
        confirmed = await catalog.confirm(row, { ...measured.result(), contentType });
      } catch (error) {
        // The commit may have happened with its reply lost, and the file renamed since: `abandon`
        // keeps an object a row still references.
        await abandon(catalog, row, name);
        throw error;
      }
      if (confirmed === null) {
        await abandon(catalog, row, name);
        return { ok: false, code: 'path_changed' };
      }

      // 4. Clean up the replaced file. A failure is logged, not returned: the cleanup job finishes
      // it, and so it does for a legacy row that has no object id to name.
      const { replaced } = confirmed;
      const replacedObjectId = replaced?.objectId ?? null;
      if (replaced !== undefined && replacedObjectId !== null) {
        const old = storageObjectName(
          ctx.workspaceId,
          replaced.area ?? input.area,
          replacedObjectId,
        );
        // The old twin goes too: a row-less old object would be adopted again as a live file.
        const twin = await oldTwin(ctx.workspaceId, replaced);
        if (
          (await deleteObject(old)) &&
          (twin === null || (await deleteObject(twin.name, twin.store)))
        ) {
          await catalog.forget(replaced).catch((error: unknown) => {
            log.warn('[storage] could not forget a replaced row; the cleanup job will', {
              rowId: replaced.id,
              error,
            });
          });
        }
      }
      // Run outputs (area `artifacts`) and skill files are not user files.
      if (input.area === 'files') await audit(ctx, 'file-uploaded', confirmed.row);
      return { ok: true, row: confirmed.row };
    },

    // @story US-STO-07
    async stage(ctx, body, maxBytes) {
      const catalog = await deps.catalog(ctx.workspaceId);
      const objectId = newObjectId();
      const contentType = 'application/x-tar';
      // One path segment: a deeper path would make the catalog add visible parent folder rows.
      const { row } = await catalog.reserve(`.staging-${objectId}`, {
        area: 'staging',
        objectId,
        ownerPrincipalId: ctx.principalId,
        createdBy: ctx.userId,
        sizeBytes: 0,
        contentType,
      });
      const name = storageObjectName(ctx.workspaceId, 'staging', objectId);
      const measured = measure(maxBytes);
      try {
        await objects.write(name, body.pipeThrough(measured.stream), {
          ifNoneMatch: '*',
          contentType,
        });
      } catch (error) {
        await abandon(catalog, row, name);
        if (error instanceof BodyTooLargeError || measured.result().sizeBytes > maxBytes) {
          return { ok: false, code: 'too_large' };
        }
        throw error;
      }
      return { ok: true, row };
    },

    // @story US-STO-07
    async unstage(ctx, row) {
      const catalog = await deps.catalog(ctx.workspaceId);
      await abandon(catalog, row, locate(ctx.workspaceId, row)?.name ?? null);
    },

    // @story US-STO-01
    async createFolder(ctx, path) {
      let key: string;
      try {
        key = toObjectKey(path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const made = await catalog.createFolder(key, {
        ownerPrincipalId: ctx.principalId,
        createdBy: ctx.userId,
      });
      if (made.kind === 'created') return { ok: true, row: made.row };
      return {
        ok: false,
        code: made.row.status === 'pending' ? 'upload_in_progress' : 'name_conflict',
      };
    },

    // @story US-STO-01
    async list(ctx, area, folder, page) {
      const catalog = await deps.catalog(ctx.workspaceId);
      // ponytail: the catalog pages across areas, so this page may hold fewer than `limit` rows;
      // the cursor is still right. Page by area in the catalog if callers need full pages.
      const found = await catalog.list(folder, page);
      return {
        rows: found.rows.filter((row) => row.kind === 'file' && listedIn(row, area)),
        cursor: found.cursor,
      };
    },

    async get(ctx, area, path) {
      const catalog = await deps.catalog(ctx.workspaceId);
      const row = await catalog.get(path);
      return row !== null && row.kind === 'file' && listedIn(row, area) ? row : null;
    },

    // @story US-STO-09
    async saveSessionState(ctx, ref, body) {
      if (deps.sessionState === undefined) {
        throw new Error('the storage service has no session-state catalog');
      }
      const catalog = await deps.sessionState(ctx.workspaceId);
      // Nothing references this id until the confirm below, so an interrupted write is an orphan
      // the cleanup job reclaims once it is old enough.
      const objectId = newObjectId();
      const name = storageObjectName(ctx.workspaceId, 'session-state', objectId);
      const measured = measure(SESSION_STATE_BLOB_MAX_BYTES);
      try {
        await objects.write(name, body.pipeThrough(measured.stream), {
          ifNoneMatch: '*',
          contentType: 'application/octet-stream',
        });
      } catch (error) {
        // An object that was already there is not ours to delete.
        if (!(error instanceof ObjectConflictError)) await deleteObject(name);
        if (error instanceof BodyTooLargeError) return { ok: false, code: 'too_large' };
        throw error;
      }
      const { sizeBytes, sha256 } = measured.result();
      // ponytail: a failed confirm leaves the new object to the cleanup job, since the commit may
      // have happened with its reply lost and the row would then name a deleted object.
      const { replaced } = await catalog.putBlob(ref.sessionId, {
        engine: ref.engine,
        blobKey: ref.blobKey,
        objectId,
        storageKey: name,
        sizeBytes,
        sha256,
      });
      if (replaced !== null) {
        await deleteRowObject(ctx.workspaceId, { ...replaced, area: 'session-state' });
      }
      return { ok: true, sizeBytes, sha256 };
    },

    deleteObject: (ctx, row) => deleteRowObject(ctx.workspaceId, row),

    // @story US-STO-05
    // A download is audited when the caller names an actor (the relay route); the agent's own
    // reads and the search index pass the workspace only and are not.
    async open(ctx, row, range) {
      const object = locate(ctx.workspaceId, row);
      if (object === null) return null;
      const stream = await object.store.read(
        object.name,
        range === undefined ? undefined : { range },
      );
      const { id, path } = row;
      const owned = row.area === undefined || row.area === 'files' || row.area === 'artifacts';
      if (stream === null || ctx.actor === undefined || !owned) return stream;
      if (id === undefined || path === undefined) return stream;
      try {
        await audit(ctx, 'file-downloaded', { id, path });
      } catch (error) {
        await stream.body.cancel().catch(() => undefined);
        throw error;
      }
      return stream;
    },

    // @story US-STO-05
    async signDownload(ctx, row, request) {
      const object = locate(ctx.workspaceId, row);
      if (object === null) return null;
      if (object.store.createSignedUrl === undefined) {
        throw new SignedUrlUnsupportedError('This object store cannot sign URLs.');
      }
      // The root store is not wrapped by the scoped store's 60..900 s bound, so it is checked here
      // before any I/O (the storage design, §05 "A signed link leaks").
      const expiresInSeconds = linkLifetime(request.ttlSeconds);
      if (expiresInSeconds === null) {
        throw new SignedUrlUnsupportedError('A signed URL lifetime is outside the allowed range.');
      }
      const url = await object.store.createSignedUrl(object.name, {
        method: 'GET',
        expiresInSeconds,
        responseContentType: request.responseContentType,
        responseDisposition: request.responseDisposition,
        ...(request.now === undefined ? {} : { now: request.now }),
      });
      await audit(ctx, 'file-link-created', row);
      return url;
    },

    // @story US-STO-03
    async rename(ctx, area, from, to) {
      let source: string;
      let target: string;
      try {
        source = toObjectKey(from);
        target = toObjectKey(to);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const row = await catalog.get(source);
      if (row !== null && row.kind === 'file' && !listedIn(row, area)) {
        return { ok: false, code: 'not_found' };
      }
      // storage-bridge(#1699): legacy rows still carry their path in the object key
      // storage-bridge(#1699): a legacy row created under the folder during the rename is not
      // copied; old write paths retire in #1662…#1665
      const moves = await legacyMoves(catalog, ctx.workspaceId, source, target);
      // Only the keys this call created, so undoing never deletes another file's bytes.
      const copied: typeof moves = [];
      // storage-bridge(#1699): the adopt stage can give a copy a row before the catalog rename;
      // that copy is then the row's bytes and stays. A failed lookup keeps every copy.
      const undo = async () => {
        if (copied.length === 0) return;
        const held = await catalog
          .referencing({ objectIds: [], storageKeys: copied.map((m) => m.to) })
          .then(
            (rows) => new Set(rows.map((other) => other.storageKey)),
            (error: unknown) => {
              log.warn('[storage] could not check renamed copies; they are left in place', {
                error,
              });
              return null;
            },
          );
        if (held === null) return;
        for (const m of copied) if (!held.has(m.to)) await deleteObject(m.to, m.store);
      };
      let moved: Awaited<ReturnType<CatalogPort['rename']>>;
      try {
        for (const m of moves) {
          const object = await m.store.read(m.from);
          if (object === null) continue;
          // A create, not an overwrite: an occupied key (another row's, a `deleting` row's awaiting
          // the cleanup job, or a concurrent rename's copy) refuses the rename. Every backend
          // declares `conditionalPut`, so no lock is needed around the copy.
          await m.store.write(m.to, object.body, {
            ifNoneMatch: '*',
            contentType: object.meta.contentType,
          });
          copied.push(m);
        }
        moved = await catalog.rename(source, target);
      } catch (error) {
        await undo();
        if (error instanceof ObjectConflictError) return { ok: false, code: 'path_taken' };
        if (isPathPending(error)) return { ok: false, code: 'upload_in_progress' };
        if (isPathTaken(error)) return { ok: false, code: 'path_taken' };
        throw error;
      }
      if (moved.rows === 0) {
        await undo();
        return { ok: false, code: 'not_found' };
      }
      // A failed delete is logged and left for the cleanup job (#1673).
      for (const m of moves) await deleteObject(m.from, m.store);
      if (row !== null && area === 'files') {
        await audit(ctx, 'file-moved', row, `${source} -> ${target}`);
      }
      return { ok: true, moved: moved.files };
    },

    // @story US-STO-04
    async remove(ctx, area, path, { recursive }) {
      let target: string;
      try {
        target = toObjectKey(path);
      } catch (error) {
        if (error instanceof UnsafeObjectKeyError) return { ok: false, code: 'invalid_path' };
        throw error;
      }
      const catalog = await deps.catalog(ctx.workspaceId);
      const row = await catalog.get(target);
      if (row === null) return removePending(ctx, catalog, area, target);
      if (row.kind === 'file' && !listedIn(row, area)) return { ok: false, code: 'not_found' };
      // ponytail: a file added under the folder between this check and `remove` goes with it.
      if (row.kind === 'folder' && !recursive) {
        const inside = await catalog.list(target, { limit: 2 });
        if (inside.rows.length > 1) return { ok: false, code: 'not_empty' };
      }
      const marked = await catalog.remove(target);
      for (let at = 0; at < marked.length; at += 16) {
        await Promise.all(
          marked.slice(at, at + 16).map((r) => discard(catalog, ctx.workspaceId, r)),
        );
      }
      // Nothing marked: a concurrent delete won the race, and it audits its own delete.
      if (area === 'files' && marked.length > 0) await audit(ctx, 'file-deleted', row, target);
      const removedFiles = marked
        .filter((r) => r.kind === 'file')
        .map((r) => r.targetPath ?? r.path)
        .sort();
      return { ok: true, removed: marked.length, files: removedFiles };
    },
  };
}
