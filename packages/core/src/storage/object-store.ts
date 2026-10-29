/**
 * `ObjectStore` — the streaming object port (the storage design, §02 ① Storage), and the scoping
 * wrapper that turns any backend into one that cannot be handed a key outside its own workspace.
 *
 * ## The shape of the port
 *
 * `head`, `read`, `write`, `listPage`, `delete` and `copy`, plus an optional `createSignedUrl`.
 * Bodies are streams and listings are pages, so no member ever holds a whole object or a whole
 * tree in memory; `streams.ts` has the small helpers (`readWhole`, `listAll`) for a caller that
 * knows its body or listing is small. Rename and preview metadata are composed from these members
 * in `apps/web/server/files/**`, not added here, because they are decisions about the UI's needs,
 * not about what an object store is.
 *
 * ## Why scoping is a wrapper around a backend, not a method on it
 *
 * A backend (`local-fs-store.ts`, and the S3 backend R-15 designs and this task's PR
 * declares blocked — see `docs/adr/W2-CP-03-object-key-safety.md`) knows how to store bytes under
 * an opaque string key. It does not know what a workspace is. {@link createScopedObjectStore}
 * is the one function that joins those two ideas: it takes a raw backend and a workspace id and
 * returns an {@link ObjectStore} whose every key is validated by `key-safety.ts`'s
 * `toObjectKey`/`toObjectPrefix` *before* the workspace prefix is joined onto it, and validated
 * *again* on the joined string before it reaches the backend. Two call sites, not one, and both
 * are named here rather than left for a reader to find:
 *
 *   1. `toObjectKey`/`toObjectPrefix` on the caller's own (unprefixed) key, in this file, below —
 *      this is what makes "escape the prefix" impossible to *construct*: a `..` segment, an
 *      absolute path, or an encoded form of either throws before this function has even decided
 *      what the prefix is.
 *   2. the backend's own call to the same guard on the full, prefixed key — `local-fs-store.ts`'s
 *      header names this second site — so a backend reached directly (a test, a future caller
 *      that skips this wrapper) is not left unguarded either.
 *
 * ## Why this takes a plain `workspaceId: string`, not the repository layer's `WorkspaceScope`
 *
 * The repository layer's `WorkspaceScope` (`packages/core/src/db/repositories/scope.ts`) is a
 * nominal class — `#private` fields, a frozen instance, a run-time brand check — specifically so a
 * repository cannot be handed a tenant a caller fabricated. Reusing it here was the first design of
 * this module, and it was reverted after it broke in exactly the way ADR-0015 warns about: this
 * task could not add `"./storage"` to `packages/core/package.json`'s `exports`, so `apps/web`
 * reached this module by a *relative* import while it reached `@agent-workspace/core/db` by the
 * package specifier — and those two resolve to **two different module instantiations** of the same source
 * (one via `packages/core/dist/**`, one transpiled straight from `packages/core/src/**`). A
 * `#private`-field brand check is scoped to the class *instantiation* that created it, not to the
 * source text, so a `WorkspaceScope` minted by one instantiation and checked by the other was
 * refused by `ForgedWorkspaceScopeError` even though nothing forged anything — reproduced running
 * this task's own `apps/web/server/files/handlers.test.ts` before this file stopped depending on
 * `@agent-workspace/core/db`. `docs/adr/W2-CP-03-object-key-safety.md` §"why not WorkspaceScope"
 * has the transcript. A plain string carries no cross-module class identity to mismatch, so the
 * hazard does not exist for it. The workspace-exists check spec §25 wants is still made — one layer
 * up, in `apps/web/server/files/store.ts`, which resolves and discards a real `WorkspaceScope`
 * before ever calling this module, the same positive-assertion shape `agents/store.ts` uses.
 *
 * `ObjectStoreProvider.forWorkspace` is named to match `apps/web/server/agents/store.ts`'s
 * `AgentStoreProvider.forWorkspace(workspaceId: string)` — the apps/web-facing port, not the
 * repository-facing `forScope` — for the same reason: no method on the returned `ObjectStore`
 * takes a workspace id, so there is no parameter at which the tenant could be forgotten.
 */
import {
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  PRESIGNED_URL_MAX_TTL_SECONDS,
  PRESIGNED_URL_MIN_TTL_SECONDS,
} from '@indx-workspace/contracts/files';

import { toObjectKey, toObjectPrefix } from './key-safety.js';

/** Re-exported so a backend read of a bare request falls back to the one definition, not a copy. */
export { PRESIGNED_URL_DEFAULT_TTL_SECONDS };

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
 * {@link ObjectConflictError}. On either refusal the body is cancelled: it will never be read.
 */
export async function validatedWriteKey(
  body: ReadableStream<Uint8Array> | Uint8Array,
  options: WriteOptions,
  toKey: () => string,
): Promise<string> {
  try {
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
  read(key: string, options?: { readonly range?: ByteRange }): Promise<ObjectStream | null>;
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

/** Thrown by {@link createScopedObjectStore} for a workspace id that is not a non-empty string. */
export class InvalidWorkspaceIdError extends Error {
  public constructor(workspaceId: unknown) {
    super(
      `ObjectStore.forWorkspace needs a non-empty workspace id; got ${JSON.stringify(workspaceId)}`,
    );
    this.name = 'InvalidWorkspaceIdError';
  }
}

/**
 * A raw backend's own storage key is a plain string this module does not interpret further — it
 * is already the full, backend-specific key (for the local-filesystem backend, a path under its
 * root directory; for a future S3 backend, the object key). `createScopedObjectStore` is
 * the only thing that turns a workspace id plus a caller's relative key into one of these.
 */
// storage-bridge(#1699): legacy scoped keys for rows without an object ID
function workspaceKeyPrefix(workspaceId: string): string {
  return `workspaces/${workspaceId}`;
}

function joinPrefixed(prefix: string, relative: string): string {
  return relative === '' ? prefix : `${prefix}/${relative}`;
}

/**
 * Wrap a raw backend so every key it sees is prefixed to one workspace, and refuse — before the
 * prefix is even computed — any caller-supplied key or prefix that could name something outside
 * it. See this file's header for the two-call-site design and for why `workspaceId` is a plain
 * string rather than the repository layer's `WorkspaceScope`.
 */
export function createScopedObjectStore(backend: ObjectStore, workspaceId: string): ObjectStore {
  // A positive assertion, not a class-brand check (see this file's header for why there is no
  // class here to check): a workspace id this module will accept is a non-empty string, full
  // stop. The caller-exists check spec §25 wants is made one layer up, in
  // `apps/web/server/files/store.ts`, before this function is ever reached.
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    throw new InvalidWorkspaceIdError(workspaceId);
  }
  const prefix = workspaceKeyPrefix(workspaceId);

  const scoped: ObjectStore = {
    ...scopeV2(backend, prefix),
    async delete(key) {
      const relative = toObjectKey(key);
      await backend.delete(joinPrefixed(prefix, relative));
    },
  };
  const sign = backend.createSignedUrl?.bind(backend);
  if (sign === undefined) return scoped;
  return {
    ...scoped,
    async createSignedUrl(key, request) {
      const fullKey = joinPrefixed(prefix, toObjectKey(key));
      const bounded = boundSignedUrlRequest(request, backend.capabilities);
      return sign(fullKey, bounded);
    },
  };
}

/** How far ahead of this host's clock a caller-supplied signing instant may be. */
const SIGNING_CLOCK_SKEW_MS = 60_000;

/**
 * The lifetime and length bound every signed link carries (the storage design, §04 "Large uploads
 * with a signed link" and §05 "A signed link leaks"), applied here once so no backend or caller
 * can mint a longer-lived link or claim a length that is not actually bound. Runs before any I/O.
 */
function boundSignedUrlRequest(
  request: SignedUrlRequest,
  capabilities: ObjectStoreCapabilities,
): SignedUrlRequest {
  // @story US-STO-02
  // @story US-STO-05
  const expiresInSeconds = request.expiresInSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS;
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < PRESIGNED_URL_MIN_TTL_SECONDS ||
    expiresInSeconds > PRESIGNED_URL_MAX_TTL_SECONDS
  ) {
    throw new SignedUrlUnsupportedError('The signed link expiry is out of range.');
  }
  // A past instant only shortens the link; a future one would start its lifetime later.
  if (request.now !== undefined) {
    const signedAt = request.now.getTime();
    if (!Number.isFinite(signedAt)) {
      throw new SignedUrlUnsupportedError('The signing instant is not a valid time.');
    }
    if (signedAt > Date.now() + SIGNING_CLOCK_SKEW_MS) {
      throw new SignedUrlUnsupportedError('The signing instant is in the future.');
    }
  }
  if (request.requireBoundContentLength === true) {
    if (request.contentLength === undefined) {
      throw new SignedUrlUnsupportedError('A bound upload length needs a contentLength.');
    }
    if (!capabilities.boundLengthSign) {
      throw new SignedUrlUnsupportedError('This store cannot bind an upload length.');
    }
  }
  return { ...request, expiresInSeconds };
}

function scopeV2(
  backend: ObjectStore,
  prefix: string,
): Omit<ObjectStore, 'delete' | 'createSignedUrl'> {
  return {
    capabilities: backend.capabilities,
    async head(key) {
      return backend.head(joinPrefixed(prefix, toObjectKey(key)));
    },
    async read(key, options) {
      const relative = toObjectKey(key);
      assertRangeShape(options?.range);
      return backend.read(joinPrefixed(prefix, relative), options);
    },
    async write(key, body, options) {
      const relative = await validatedWriteKey(body, options, () => toObjectKey(key));
      return backend.write(joinPrefixed(prefix, relative), body, options);
    },
    async listPage(rawPrefix, options) {
      const fullPrefix = joinPrefixed(prefix, toObjectPrefix(rawPrefix));
      const stripLen = prefix.length + 1; // `${prefix}/`
      // A `<kind>:<key>` cursor carries a backend key: the caller never sees the workspace
      // prefix, so strip it going out and restore it coming in. Any other shape is a provider
      // continuation token and stays opaque.
      const cursorKey = (cursor: string, map: (key: string) => string): string => {
        const sep = cursor.indexOf(':');
        return sep < 0 ? cursor : `${cursor.slice(0, sep + 1)}${map(cursor.slice(sep + 1))}`;
      };
      const inbound = options?.cursor;
      const page = await backend.listPage(fullPrefix, {
        ...options,
        limit: clampListLimit(options?.limit),
        ...(inbound === undefined
          ? {}
          : { cursor: cursorKey(inbound, (key) => joinPrefixed(prefix, key)) }),
      });
      return {
        cursor:
          page.cursor === null
            ? null
            : cursorKey(page.cursor, (key) =>
                key.startsWith(`${prefix}/`) ? key.slice(stripLen) : key,
              ),
        entries: page.entries.map((entry) => ({ ...entry, key: entry.key.slice(stripLen) })),
      };
    },
    async copy(sourceKey, destinationKey) {
      const relativeSource = toObjectKey(sourceKey);
      const relativeDestination = toObjectKey(destinationKey);
      await backend.copy(
        joinPrefixed(prefix, relativeSource),
        joinPrefixed(prefix, relativeDestination),
      );
    },
  };
}

/** Build an {@link ObjectStoreProvider} from any raw backend. Every backend module uses this. */
export function scopedObjectStoreProvider(backend: ObjectStore): ObjectStoreProvider {
  return { forWorkspace: (workspaceId: string) => createScopedObjectStore(backend, workspaceId) };
}
