import type { EngineId } from '@indx-workspace/contracts/engines';
import type { AuditAction } from '@indx-workspace/contracts/observability';
import {
  type ByteRange,
  type ObjectStore,
  type ObjectStream,
  type SignedUrl,
  type StorageArea,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';
import {
  type CatalogFile,
  type CatalogPort,
  type SessionStateBlobCatalog,
  type SessionStateBlobClaim,
} from './store';
export type { SessionStateBlobCatalog } from './store';

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

/** The object a row names: enough to find its bytes, new naming or old. */
export type ObjectRow = Pick<CatalogFile, 'area' | 'objectId' | 'storageKey'>;

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
export type ReplacePolicy = (target: CatalogFile) => Promise<boolean>;

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

export type RemoveResult =
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
export type CompleteUploadResult =
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

export interface StorageDependencies {
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
}
