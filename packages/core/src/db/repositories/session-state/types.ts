import type { EngineId } from '../../schema/agents.js';

/** Which stream: the platform's session row, the engine that wrote it, and the opaque key. */
export interface SessionStateStreamKey {
  readonly sessionId: string;
  readonly engine: EngineId;
  /** Adapter-defined. Claude: `projectKey` + `/` + `subpath`. Never interpreted here. */
  readonly streamKey: string;
}

/** One entry as a caller appends it. `entryKey` absent means "this entry has no identity". */
export interface SessionStateEntryInput {
  readonly entryKey?: string | undefined;
  readonly entry: Readonly<Record<string, unknown>>;
}

/** One entry as it is stored, with the sequence a cursor pages by. */
export interface StoredSessionStateEntry {
  readonly sequence: number;
  readonly entryKey: string | null;
  readonly entry: Readonly<Record<string, unknown>>;
}

/** One stream, as {@link SessionStateRepository.listStreams} reports it. */
export interface StoredSessionStateStream {
  readonly engine: EngineId;
  readonly streamKey: string;
  /** Integer epoch milliseconds of the last write. The SDK's `listSessions` calls this `mtime`. */
  readonly updatedAt: number;
}

/** What is recorded about one blob. The bytes themselves live in the object store. */
export interface StoredSessionStateBlob {
  readonly blobKey: string;
  readonly storageKey: string;
  /** The permanent object ID the bytes are stored under. */
  readonly objectId: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * A blob row no read serves (the storage design, §04 "Saving a file"): a save's reservation
 * (`pending`), or a row on its way out (`deleting`) whose object is deleted before the row is
 * forgotten. It waits under a side key (`%aside/…`, the file catalog's side-path root), never under
 * a caller's blob key, so that key stays free for the next save while it waits.
 */
export interface SessionStateBlobClaim {
  readonly sessionId: string;
  readonly engine: EngineId;
  /** The side key the row waits under. */
  readonly rowKey: string;
  readonly status: 'pending' | 'deleting';
  /** The permanent object ID the bytes are stored under. */
  readonly objectId: string;
  readonly storageKey: string;
  /**
   * The reservation a pending row was made under (the file catalog's token): `confirmBlob`,
   * `claimBlob` and `forgetBlob` act on a pending row only while it still carries this token.
   * `null` for a `deleting` row.
   */
  readonly reservationToken: string | null;
}

/** What a save measured on the way to the object store, and the key it saves the blob under. */
export interface SessionStateBlobConfirmation {
  readonly blobKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface SessionStateRepository {
  /**
   * Persist a batch, upserting on `entryKey` and appending keyless entries.
   *
   * Creates the stream row if it does not exist, so an empty batch is still the difference between
   * "this stream exists and is empty" and "this stream was never written" — the distinction a
   * resume turns on.
   */
  append(key: SessionStateStreamKey, entries: readonly SessionStateEntryInput[]): Promise<void>;
  /**
   * Everything in the stream after `afterSequence`, in order, or `null` when the stream is unknown.
   *
   * `null` and `[]` are different answers, and only the second is resumable.
   */
  list(
    key: SessionStateStreamKey,
    page?: { readonly afterSequence?: number | undefined; readonly limit?: number | undefined },
  ): Promise<readonly StoredSessionStateEntry[] | null>;
  /** Remove the highest-sequence entry. Answers how many rows went, so 0 means an empty stream. */
  deleteLast(key: SessionStateStreamKey): Promise<number>;
  /** Replace every entry with exactly these, renumbered from 1. Creates the stream if absent. */
  replaceAll(key: SessionStateStreamKey, entries: readonly SessionStateEntryInput[]): Promise<void>;
  /** Remove one stream and its entries. Idempotent. */
  deleteStream(key: SessionStateStreamKey): Promise<void>;
  /** Every stream of one session, newest write first. */
  listStreams(sessionId: string): Promise<readonly StoredSessionStateStream[]>;
  /**
   * Step 1 of a save: a `pending` row for `objectId`, written before any byte. It holds its object
   * against the cleanup job, and no read serves it.
   */
  reserveBlob(
    sessionId: string,
    blob: { readonly engine: EngineId; readonly objectId: string; readonly storageKey: string },
  ): Promise<SessionStateBlobClaim>;
  /**
   * Step 3 of a save, in one transaction: `pending`, still under its reservation, becomes the
   * `ready` row of `blobKey`, and the row it replaces moves aside as `deleting` and is returned for
   * the caller to delete. `null`, and nothing changed, when the reservation is gone (confirmed,
   * claimed or purged since, or its session deleted). Throws for a side key.
   */
  confirmBlob(
    pending: SessionStateBlobClaim,
    confirmation: SessionStateBlobConfirmation,
  ): Promise<{ readonly replaced: SessionStateBlobClaim | null } | null>;
  /**
   * Mark a stale pending row `deleting` before its object goes (the cleanup job). `null` when the
   * row no longer carries the reservation `pending` names.
   */
  claimBlob(pending: SessionStateBlobClaim): Promise<SessionStateBlobClaim | null>;
  /**
   * Drop a row no read serves: a `deleting` row once its object is gone, or a pending row under its
   * own reservation. `false` when nothing matched.
   */
  forgetBlob(row: SessionStateBlobClaim): Promise<boolean>;
  /** What a crash or a failed delete left: every `deleting` row, and `pending` rows older than `before`. */
  unsettledBlobs(before: Date): Promise<readonly SessionStateBlobClaim[]>;
  /** What is recorded about one `ready` blob, or `null`. */
  getBlob(
    sessionId: string,
    engine: EngineId,
    blobKey: string,
  ): Promise<StoredSessionStateBlob | null>;
  /** Every `ready` blob of one session, for cleanup. */
  listBlobs(sessionId: string): Promise<readonly StoredSessionStateBlob[]>;
  /** Which of `objectIds` a blob row in any status holds, for the cleanup job. */
  referencedObjectIds(objectIds: readonly string[]): Promise<readonly string[]>;
  /**
   * Retention: remove every stream (with its entries) of this workspace whose last write is before
   * `before`, and mark every blob row written before it `deleting`, aside from its key. The same
   * rule the legacy `session_transcripts` purge applies, over the same `updated_at`, so one policy
   * covers both stores.
   */
  purgeBefore(before: Date): Promise<SessionStatePurge>;
}

/** The blob half of {@link SessionStateRepository}: what a save, a read, a purge and the cleanup job use. */
export type SessionStateBlobRepository = Pick<
  SessionStateRepository,
  | 'reserveBlob'
  | 'confirmBlob'
  | 'claimBlob'
  | 'forgetBlob'
  | 'unsettledBlobs'
  | 'getBlob'
  | 'listBlobs'
  | 'referencedObjectIds'
  | 'purgeBefore'
>;

/** What one {@link SessionStateRepository.purgeBefore} pass removed. */
interface SessionStatePurge {
  /** Streams whose last write was before the cutoff, removed with their entries. */
  readonly streams: number;
  /** The entries those streams held. */
  readonly entries: number;
  /**
   * The blob rows this pass marked `deleting`. The caller deletes their bytes, then forgets each
   * row; a row whose delete failed stays `deleting` for the cleanup job.
   */
  readonly blobs: readonly SessionStateBlobClaim[];
  /** The sessions this pass left with no stream at all: their conversation is purged. */
  readonly sessionIds: readonly string[];
}
