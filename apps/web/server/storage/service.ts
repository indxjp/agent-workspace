/**
 * The one catalog service. `save` is the four steps of the storage design, §04 "Saving a file":
 * reserve a pending row, write the object under a new id, confirm the row, clean up what was
 * replaced. Web uploads, API uploads, chat attachments, skill imports and run outputs all save
 * through it, and a signed-link upload takes the same steps split in two: `reserveUpload` signs a
 * `PUT` on the new object, `completeUpload` verifies and confirms it. `list`, `get`, `open` and
 * `signDownload` read by catalog row, `rename` changes the row alone, and `remove` deletes the
 * object, not just the row (the storage design, §04 "File states", §05).
 */
import { createHash, randomUUID } from 'node:crypto';

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
  type CatalogFile,
  type CatalogPort,
  type SessionStateBlobCatalog,
  type SessionStateBlobClaim,
} from './store';

/** Who acted, for the audit row: the signed-in principal, never a request field. */
interface StorageActor {
  readonly principalId: string;
  readonly userId: string | null;
  readonly label: string;
}

/**
 * One row of the audit trail for a file action (the storage design, §05). No URL, ever.
 *
 * `id` is the row's audit key: the trail keeps one row per key (its primary key, written with
 * `on conflict do nothing`), so a retried write is idempotent. It is a name-based UUID of the
 * workspace, the action, the file row and the occurrence of the action:
 *
 * - `file-uploaded`: the object id the upload confirmed. One object id is confirmed once, so a
 *   retried complete of the same upload writes the same key, and a second upload to the same path
 *   (a new object id) is a second row.
 * - `file-deleted`: the removed row's id. A row is removed once.
 * - `file-downloaded`, `file-link-created`, `file-moved`: one per request. Each read, link and
 *   move is its own event, so the key is minted once per call and reused only by that call's retry.
 *   A ranged read is a read: every `Range` request is one `file-downloaded` row, so no read of a
 *   file goes unaudited.
 */
export interface StorageAuditEvent {
  /** The audit key; see above. */
  readonly id: string;
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

export type { SessionStateBlobCatalog };

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
  /** The row's object, or `null` when it has none (a folder). */
  open(
    ctx: Pick<StorageContext, 'workspaceId' | 'actor'>,
    row: ObjectRow & { readonly id?: string; readonly path?: string },
    range?: ByteRange,
  ): Promise<ObjectStream | null>;
  /**
   * Saves one session-state blob the same four steps as a file: a `pending` row under a new object
   * id first, then the body streamed to that object through {@link measure}, then one transaction
   * that confirms the row against its reservation token and moves the replaced row aside as
   * `deleting`, and last the replaced object and row. Over {@link SESSION_STATE_BLOB_MAX_BYTES}
   * nothing is left behind. `reservation_lost`: the pending row was purged, claimed or cascaded away
   * while the bytes were written, so nothing was saved and the object is gone.
   */
  saveSessionState(
    ctx: Pick<StorageContext, 'workspaceId'>,
    ref: { readonly sessionId: string; readonly engine: EngineId; readonly blobKey: string },
    body: ReadableStream<Uint8Array>,
  ): Promise<
    | { readonly ok: true; readonly sizeBytes: number; readonly sha256: string }
    | { readonly ok: false; readonly code: 'too_large' | 'reservation_lost' }
  >;
  /**
   * Deletes a `deleting` session-state row's object, then forgets the row. A failed delete is
   * logged and leaves the row `deleting` for the cleanup job.
   */
  discardSessionState(
    ctx: Pick<StorageContext, 'workspaceId'>,
    row: SessionStateBlobClaim,
  ): Promise<void>;
  /**
   * A short-lived `GET` link on the row's own object, signed by the root store, so it points at the
   * storage domain and not at this app. `null` only for a row with no object id (a folder);
   * whether the object itself still exists is not checked, signing is offline. Throws {@link SignedUrlUnsupportedError} when that store cannot sign or
   * the lifetime is outside the contract's bounds. The link is returned, never logged.
   */
  signDownload(
    ctx: StorageContext,
    row: CatalogFile,
    request: SignDownloadRequest,
  ): Promise<SignedUrl | null>;
  /**
   * Row update only: no object is read, written or copied. A folder moves every row under it.
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

/**
 * A name-based UUID (RFC 9562 version 8, from SHA-256 of `parts`): the same parts give the same
 * id, so an audit write retried under it is the same row.
 */
function auditKey(parts: readonly string[]): string {
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x80, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What makes an upload one event: the object id it confirmed (a row with none: its id). */
const uploadOccurrence = (row: Pick<CatalogFile, 'id' | 'objectId'>): string =>
  row.objectId ?? row.id;

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
  /** The session-state blob catalog of a workspace; absent where no database holds one. */
  readonly sessionState?: (workspaceId: string) => Promise<SessionStateBlobCatalog>;
  /**
   * Appends one audit row, idempotently by `event.id` (the audit key, {@link StorageAuditEvent}).
   * Awaited after the action committed and tried twice under the same key, so a transient failure
   * or a lost reply still records the action once. A second failure reaches the caller: what was
   * done is never rolled back or deleted, but a download or a link is not handed out unaudited,
   * and an upload, move or delete answers an error the caller can see and retry. This is how the
   * other domains behave (`composition/services.ts`). A retried upload complete re-audits under
   * the same key. Honest limit: a retried move or delete finds nothing left to do and does not
   * re-audit, so such an action can stay unaudited after two failed writes; the caller sees the
   * error. Absent where no database holds a trail (tests of other features).
   */
  readonly audit?: (event: StorageAuditEvent) => Promise<void>;
  readonly log: Logger;
}): StorageService {
  const { objects, log } = deps;

  /**
   * Record `action` on `row` for the acting principal, if the caller named one, under the audit key
   * of `occurrence` (`null`: this request). Written twice at most, under the same key.
   */
  async function audit(
    ctx: Pick<StorageContext, 'workspaceId' | 'actor'>,
    action: StorageAuditEvent['action'],
    row: Pick<CatalogFile, 'id' | 'path'>,
    occurrence: string | null,
    label: string = row.path,
  ): Promise<void> {
    const { actor } = ctx;
    const write = deps.audit;
    if (write === undefined || actor === undefined) return;
    const event: StorageAuditEvent = {
      id: auditKey([ctx.workspaceId, action, row.id, occurrence ?? randomUUID()]),
      workspaceId: ctx.workspaceId,
      actorPrincipalId: actor.principalId,
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action,
      subjectId: row.id,
      subjectLabel: label,
    };
    await write(event).catch(() => write(event));
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

  /** Where a row's bytes are: the root store, by object id. `null` for a row with none (a folder). */
  function locate(workspaceId: string, row: ObjectRow) {
    const objectId = row.objectId ?? null;
    if (objectId === null) return null;
    return { store: objects, name: storageObjectName(workspaceId, row.area ?? 'files', objectId) };
  }

  /** Delete a row's object; `false` when it is left (a failure is logged and left to the cleanup job). */
  async function deleteRowObject(workspaceId: string, row: ObjectRow): Promise<boolean> {
    const object = locate(workspaceId, row);
    if (object === null) {
      log.warn('[storage] a replaced or purged row names no object; nothing is deleted');
      return false;
    }
    return deleteObject(object.name, object.store);
  }

  /** The session-state blob rows of a workspace. */
  async function sessionStateRows(workspaceId: string): Promise<SessionStateBlobCatalog> {
    if (deps.sessionState === undefined) {
      throw new Error('the storage service has no session-state catalog');
    }
    return deps.sessionState(workspaceId);
  }

  /**
   * Remove the reservation of a session-state save that did not confirm, then the object `name` it
   * wrote, as {@link abandon} does for a file: only the reservation `pending` names is forgotten,
   * and the object goes unless the blob's ready row names it (a confirm that committed with its
   * reply lost). A row that moved it aside as `deleting` deletes it anyway. A failed lookup keeps
   * the object for the cleanup job.
   */
  async function abandonBlob(
    rows: SessionStateBlobCatalog,
    pending: SessionStateBlobClaim,
    blobKey: string,
    name: string | null,
  ) {
    await rows.forgetBlob(pending).catch((error: unknown) => {
      log.warn('[storage] could not forget a session-state reservation; the cleanup job will', {
        error,
      });
    });
    const objectId = pending.objectId;
    if (name === null) return;
    const held = await rows.getBlob(pending.sessionId, pending.engine, blobKey).then(
      (ready) => ready?.objectId === objectId,
      (error: unknown) => {
        log.warn('[storage] could not check a saved session-state object; the cleanup job will', {
          error,
        });
        return true;
      },
    );
    if (!held) await deleteObject(name);
  }

  /** Delete a `deleting` session-state row's object, then forget the row; a failure keeps it. */
  async function discardBlob(
    workspaceId: string,
    rows: SessionStateBlobCatalog,
    row: SessionStateBlobClaim,
  ) {
    const object = { area: 'session-state' as const, ...row };
    if (!(await deleteRowObject(workspaceId, object))) return;
    await rows.forgetBlob(row).catch((error: unknown) => {
      log.warn('[storage] could not forget a deleted session-state row; the cleanup job will', {
        error,
      });
    });
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
    if (area === 'files') await audit(ctx, 'file-deleted', pending, pending.id, path);
    return { ok: true, removed: claimed.length, files: [path] };
  }

  /**
   * Delete a removed row's object, then drop the row; a failure leaves it `deleting` for the cleanup
   * job. A pending row is claimed first, and left alone when it changed since it was read.
   */
  async function discard(catalog: CatalogPort, workspaceId: string, row: CatalogFile) {
    const object = locate(workspaceId, row);
    if (object === null) {
      log.warn('[storage] a removed row names no object; the cleanup job will', {
        rowId: row.id,
      });
      return;
    }
    const doomed = row.status === 'pending' ? await claimPending(catalog, row) : row;
    if (doomed === null) return;
    if (!(await deleteObject(object.name, object.store))) return;
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
    const held = await catalog.referencing({ objectIds: [objectId] }).then(
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
      await audit(ctx, 'file-link-created', { id: row.id, path }, null);
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
        if (meta === null || meta.sizeBytes !== ready.sizeBytes) {
          return { ok: false, code: 'not_verified' };
        }
        // A retry after a failed audit write records the upload now, under the key the first
        // complete used, so an upload whose row was written is still one row.
        await audit(ctx, 'file-uploaded', ready, uploadOccurrence(ready));
        return { ok: true, row: ready };
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
      await audit(ctx, 'file-uploaded', confirmed.row, uploadOccurrence(confirmed.row));
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
      // it.
      const { replaced } = confirmed;
      const replacedObjectId = replaced?.objectId ?? null;
      if (replaced !== undefined && replacedObjectId !== null) {
        const old = storageObjectName(
          ctx.workspaceId,
          replaced.area ?? input.area,
          replacedObjectId,
        );
        if (await deleteObject(old)) {
          await catalog.forget(replaced).catch((error: unknown) => {
            log.warn('[storage] could not forget a replaced row; the cleanup job will', {
              rowId: replaced.id,
              error,
            });
          });
        }
      }
      // Run outputs (area `artifacts`) and skill files are not user files.
      if (input.area === 'files') {
        await audit(ctx, 'file-uploaded', confirmed.row, uploadOccurrence(confirmed.row));
      }
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
      let rows: SessionStateBlobCatalog;
      let pending: SessionStateBlobClaim;
      const objectId = newObjectId();
      const name = storageObjectName(ctx.workspaceId, 'session-state', objectId);
      // 1. Reserve: the row holds the object before its first byte, against the cleanup job.
      try {
        rows = await sessionStateRows(ctx.workspaceId);
        pending = await rows.reserveBlob(ref.sessionId, {
          engine: ref.engine,
          objectId,
          storageKey: name,
        });
      } catch (error) {
        await body.cancel().catch(() => undefined);
        throw error;
      }

      // 2. Write, measuring in the stream: no byte of the body is held whole.
      const measured = measure(SESSION_STATE_BLOB_MAX_BYTES);
      try {
        await objects.write(name, body.pipeThrough(measured.stream), {
          ifNoneMatch: '*',
          contentType: 'application/octet-stream',
        });
      } catch (error) {
        // An object that was already there is not ours to delete.
        await abandonBlob(
          rows,
          pending,
          ref.blobKey,
          error instanceof ObjectConflictError ? null : name,
        );
        if (error instanceof BodyTooLargeError) return { ok: false, code: 'too_large' };
        throw error;
      }

      // 3. Confirm against the reservation, swapping the rows in one transaction.
      const { sizeBytes, sha256 } = measured.result();
      let confirmed;
      try {
        confirmed = await rows.confirmBlob(pending, { blobKey: ref.blobKey, sizeBytes, sha256 });
      } catch (error) {
        // The commit may have happened with its reply lost: `abandonBlob` keeps an object the
        // blob's ready row names.
        await abandonBlob(rows, pending, ref.blobKey, name);
        throw error;
      }
      if (confirmed === null) {
        await abandonBlob(rows, pending, ref.blobKey, name);
        return { ok: false, code: 'reservation_lost' };
      }

      // 4. Clean up the replaced blob: object first, then its `deleting` row.
      if (confirmed.replaced !== null) {
        await discardBlob(ctx.workspaceId, rows, confirmed.replaced);
      }
      return { ok: true, sizeBytes, sha256 };
    },

    async discardSessionState(ctx, row) {
      await discardBlob(ctx.workspaceId, await sessionStateRows(ctx.workspaceId), row);
    },

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
        await audit(ctx, 'file-downloaded', { id, path }, null);
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
      await audit(ctx, 'file-link-created', row, null);
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
      let moved: Awaited<ReturnType<CatalogPort['rename']>>;
      try {
        moved = await catalog.rename(source, target);
      } catch (error) {
        if (isPathPending(error)) return { ok: false, code: 'upload_in_progress' };
        if (isPathTaken(error)) return { ok: false, code: 'path_taken' };
        throw error;
      }
      if (moved.rows === 0) return { ok: false, code: 'not_found' };
      if (row !== null && area === 'files') {
        await audit(ctx, 'file-moved', row, null, `${source} -> ${target}`);
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
      if (area === 'files' && marked.length > 0) {
        await audit(ctx, 'file-deleted', row, row.id, target);
      }
      const removedFiles = marked
        .filter((r) => r.kind === 'file')
        .map((r) => r.targetPath ?? r.path)
        .sort();
      return { ok: true, removed: marked.length, files: removedFiles };
    },
  };
}
