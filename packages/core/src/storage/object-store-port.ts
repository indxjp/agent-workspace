/**
 * The object port itself: the {@link ObjectStore} interface and the types, errors and small
 * helpers every backend shares (listing order, page size, range and write-precondition checks).
 * The workspace-scoping wrapper that joins them to a tenant is `object-store.ts`.
 */
/** One entry `listPage` returns: either a file with bytes, or a folder with none. */
export type ObjectListEntry =
  | {
      readonly kind: 'file';
      /** The workspace-relative key, exactly as `write` was called with it. */
      readonly key: string;
      readonly sizeBytes: number;
      readonly contentType: string | null;
      readonly lastModified: Date;
    }
  | {
      readonly kind: 'folder';
      /** The workspace-relative key of the folder, with no trailing `/`. */
      readonly key: string;
    };

/**
 * Listing order by key, compared code unit by code unit, so the order does not depend on the host's
 * locale. A backend whose pages follow another order sorts each page by that order instead.
 */
export function compareEntryKeys(left: ObjectListEntry, right: ObjectListEntry): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/**
 * The order a cloud backend pages a one-level listing in: by native name, where folder `a` is
 * `a/`, so it sorts after file `a.txt`. A page sorted any other way would not concatenate with the
 * next page into one order.
 */
export function compareListingNames(left: ObjectListEntry, right: ObjectListEntry): number {
  const leftName = left.kind === 'folder' ? `${left.key}/` : left.key;
  const rightName = right.kind === 'folder' ? `${right.key}/` : right.key;
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

/** A whole small object with its meta, as `readWhole` in `streams.ts` returns it. */
export interface ObjectContent {
  readonly body: Uint8Array;
  readonly contentType: string | null;
  readonly sizeBytes: number;
  readonly lastModified: Date;
}

/** What a backend can do natively. A backend that cannot do something says so; it does not fake it. */
export interface ObjectStoreCapabilities {
  /** `createSignedUrl` is offered. */
  readonly sign: boolean;
  /** A signed PUT can bind the upload's byte length into the signature. */
  readonly boundLengthSign: boolean;
  /** `read` honours `range`. */
  readonly range: boolean;
  /** `write` honours `ifNoneMatch` / `ifMatch`. */
  readonly conditionalPut: boolean;
  /** A key can be both an object and a folder prefix (object stores: true; a file system cannot). */
  readonly fileAndFolderShareKey: boolean;
}

/** Size, type and version of one stored object. `etag` is opaque: pass it back as `ifMatch`. */
export interface ObjectMeta {
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly etag: string;
  readonly lastModified: Date;
}

/** Inclusive byte range, as in HTTP `Range: bytes=start-end`; omit `end` to read to the end. */
export interface ByteRange {
  readonly start: number;
  readonly end?: number;
}

interface ReadOptions {
  readonly range?: ByteRange;
  /**
   * Stops the read once aborted: before it returns, it rejects with the signal's reason; after,
   * the body errors with it. Passed to the store's SDK where it takes one.
   */
  readonly signal?: AbortSignal;
}

/** What `read` returns: the whole object's meta, and the requested bytes as a stream. */
export interface ObjectStream {
  readonly meta: ObjectMeta;
  readonly body: ReadableStream<Uint8Array>;
  /** The inclusive range `body` covers; `null` when the whole object is streamed. */
  readonly range: { readonly start: number; readonly end: number } | null;
}

/** At most one precondition: `ifNoneMatch` and `ifMatch` together could never both hold. */
export type WriteOptions = {
  readonly contentType?: string | null;
  /**
   * Stops the write once aborted: it rejects with the signal's reason, the body is cancelled, and
   * nothing is written, as for a body that errors. Passed to the store's SDK where it takes one.
   */
  readonly signal?: AbortSignal;
} & (
  | {
      /** `'*'`: write only if the key does not exist. */
      readonly ifNoneMatch?: '*';
      readonly ifMatch?: never;
    }
  | {
      /** Write only if the object's current etag is this one. */
      readonly ifMatch?: string;
      readonly ifNoneMatch?: never;
    }
);

/**
 * The key `toKey` returns for a write, refusing both preconditions at once with
 * {@link ObjectConflictError}, and a write whose signal has already aborted with its reason. On
 * any refusal the body is cancelled: it will never be read.
 */
export async function validatedWriteKey(
  body: ReadableStream<Uint8Array> | Uint8Array,
  options: WriteOptions,
  toKey: () => string,
): Promise<string> {
  try {
    options.signal?.throwIfAborted();
    if (options.ifNoneMatch !== undefined && options.ifMatch !== undefined) {
      throw new ObjectConflictError('A write takes ifNoneMatch or ifMatch, not both.');
    }
    return toKey();
  } catch (error) {
    if (!(body instanceof Uint8Array)) await body.cancel(error);
    throw error;
  }
}

export interface ListPageOptions {
  /** `true`: every file beneath the prefix, however deep. Default: one level, folders included. */
  readonly recursive?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  /** Stops the listing once aborted; a backend whose SDK takes no signal checks it between calls. */
  readonly signal?: AbortSignal;
  /**
   * `true`: each file's content type. A store whose listing does not carry it (S3) asks for it once
   * per file, so only a caller that reads `contentType` sets this; without it, such a store reports
   * `null`. Every other store reports what it holds either way.
   */
  readonly contentTypes?: boolean;
}

/** One page of a listing; `cursor` is `null` on the last page, otherwise pass it back. */
export interface ObjectPage {
  readonly entries: readonly ObjectListEntry[];
  readonly cursor: string | null;
}

/** A conditional `write` found the object in a different state than its precondition named. */
export class ObjectConflictError extends Error {
  public constructor(message = 'The object does not match the write precondition.') {
    super(message);
    this.name = 'ObjectConflictError';
  }
}

/** A `read` range is malformed, or starts at or past the end of the object. Same on every backend. */
export class RangeNotSatisfiableError extends Error {
  public constructor(message = 'The requested byte range cannot be satisfied.') {
    super(message);
    this.name = 'RangeNotSatisfiableError';
  }
}

const DEFAULT_LIST_PAGE_LIMIT = 1000;

/** The listing page size every backend honours: 1 to 1000, whatever the caller asked for. */
export function clampListLimit(limit: number | undefined): number {
  return limit === undefined || !Number.isFinite(limit)
    ? DEFAULT_LIST_PAGE_LIMIT
    : Math.min(DEFAULT_LIST_PAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** Refuse a range that is malformed, whatever the object. */
export function assertRangeShape(range: ByteRange | undefined): void {
  if (range === undefined) return;
  const { start, end } = range;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < start))
  ) {
    throw new RangeNotSatisfiableError('The byte range is malformed.');
  }
}

/** What {@link ObjectStore.createSignedUrl} is asked to authorise: one method on one key. */
export interface SignedUrlRequest {
  readonly method: 'GET' | 'PUT';
  /**
   * How long the store accepts the URL; the store, not the caller, enforces the expiry. The scoped
   * store defaults it to 300 s and refuses a value outside 60..900 s before the backend is reached.
   */
  readonly expiresInSeconds?: number;
  /** PUT: the content type the upload must carry. Recorded as known, like {@link WriteOptions}'s. */
  readonly contentType?: string | null;
  /** PUT: the byte length the upload must carry, bound into the signature where the store can. */
  readonly contentLength?: number;
  /**
   * PUT: refuse to sign unless the store binds {@link contentLength} into the signature. A store
   * that cannot (Azure Blob: a SAS has no length field) rejects with {@link SignedUrlUnsupportedError}
   * before any store I/O.
   */
  readonly requireBoundContentLength?: boolean;
  /** GET: the content type the store answers with, whatever was stored. */
  readonly responseContentType?: string;
  /** GET: the `Content-Disposition` the store answers with. */
  readonly responseDisposition?: string;
  /**
   * Test seam: the instant the URL is signed at. The scoped store refuses one more than a minute
   * ahead of its clock, so a link can never start its lifetime later than it was minted.
   */
  readonly now?: Date;
}

/** The store cannot sign a URL that satisfies the {@link SignedUrlRequest} it was given. */
export class SignedUrlUnsupportedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SignedUrlUnsupportedError';
  }
}

/** A short-lived URL on the store itself, and the headers the caller must send with it. */
export interface SignedUrl {
  readonly url: string;
  /** Headers that are part of the signature; a request without them is refused by the store. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Spec §16's object operations, scoped to one workspace (or, for the raw backends in this
 * directory, operating on whatever key they are literally given — see each backend's header for
 * which one it is).
 *
 * Every key and prefix is workspace-relative: `contracts/agreement.pdf`, never a leading `/` and
 * never a `..` segment. `key-safety.ts` is what makes that a property every implementation shares
 * rather than a convention each one has to remember. `head(key) !== null` is the "exists" check.
 */
export interface ObjectStore {
  readonly capabilities: ObjectStoreCapabilities;
  /** Size, content type and etag of the object at `key`, or `null` if there is none. */
  head(key: string): Promise<ObjectMeta | null>;
  /** Stream the object (or a byte range of it), or `null` if there is none. */
  read(key: string, options?: ReadOptions): Promise<ObjectStream | null>;
  /**
   * Write `body` at `key`, replacing whatever was there unless a precondition says otherwise; a
   * failed precondition rejects with {@link ObjectConflictError}. Streams are never buffered whole.
   */
  write(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: WriteOptions,
  ): Promise<ObjectMeta>;
  /**
   * Remove the object at `key`. Idempotent: a `key` that does not exist is not an error, matching
   * R-15 §1c's verified result for `DeleteObject` on both backends ("missing key -> HTTP 204, no
   * error, on both sides").
   */
  delete(key: string): Promise<void>;
  /**
   * One page of the listing under `prefix`, sorted by key: one level with folders, or every file
   * beneath it (`recursive`). Pass the returned `cursor` back to continue; it is opaque.
   */
  listPage(prefix: string, options?: ListPageOptions): Promise<ObjectPage>;
  /**
   * Copy the object at `sourceKey` to `destinationKey` on the store itself, bytes and content type
   * both, leaving `sourceKey` untouched. A missing `sourceKey` is a no-op — nothing is written and
   * nothing throws — the same "absence is not an error" contract {@link ObjectStore.delete} already
   * has, and what lets a subtree move recompute its remaining work from current store state and
   * retry a `copy` call that already succeeded without it becoming an error the second time.
   * Overwrites whatever was at `destinationKey`, matching {@link ObjectStore.write}.
   */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  /**
   * A URL on the object store itself that lets its holder `GET` or `PUT` exactly `key` until it
   * expires, without the control plane relaying the bytes. Optional: the S3, GCS and Azure Blob
   * backends sign; the local-filesystem and in-memory backends have no URL a browser could use,
   * so a caller treats an absent method as "direct transfer is unsupported". Performs no store I/O.
   */
  createSignedUrl?(key: string, request: SignedUrlRequest): Promise<SignedUrl>;
}

/** Hands out an {@link ObjectStore} bound to one workspace. See this file's header. */
export interface ObjectStoreProvider {
  forWorkspace(workspaceId: string): ObjectStore;
}

/** Tests only: a store over a new, empty bucket or container on a local emulator, and its removal. */
export interface EmulatorObjectStore {
  readonly provider: ObjectStoreProvider;
  /** Deletes the bucket or container with whatever is left in it. */
  readonly teardown: () => Promise<void>;
  /** Writes `bytes` under a bucket-root name past the key guard, as another tool would. */
  readonly plantRaw: (name: string, bytes: Uint8Array) => Promise<void>;
}
