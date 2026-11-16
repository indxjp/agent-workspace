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
import {
  assertRangeShape,
  clampListLimit,
  SignedUrlUnsupportedError,
  validatedWriteKey,
  type ListPageOptions,
  type ObjectPage,
  type ObjectStore,
  type ObjectStoreCapabilities,
  type ObjectStoreProvider,
  type SignedUrlRequest,
} from './object-store-port.js';

/** Re-exported so a backend read of a bare request falls back to the one definition, not a copy. */
export { PRESIGNED_URL_DEFAULT_TTL_SECONDS };

export {
  assertRangeShape,
  clampListLimit,
  compareEntryKeys,
  compareListingNames,
  ObjectConflictError,
  RangeNotSatisfiableError,
  SignedUrlUnsupportedError,
  validatedWriteKey,
  type ByteRange,
  type EmulatorObjectStore,
  type ListPageOptions,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectPage,
  type ObjectStore,
  type ObjectStoreCapabilities,
  type ObjectStoreProvider,
  type ObjectStream,
  type SignedUrl,
  type SignedUrlRequest,
  type WriteOptions,
} from './object-store-port.js';

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
    ...scopedOperations(backend, prefix),
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

/** Strips `prefix` going out of a backend and restores it coming in, as a cursor carries a key. */
function mapCursorKey(cursor: string, map: (key: string) => string): string {
  // A `<kind>:<key>` cursor carries a backend key: the caller never sees the workspace prefix, so
  // strip it going out and restore it coming in. Any other shape is a provider continuation token
  // and stays opaque, even when it holds a ':' (SeaweedFS answers the raw last key, which may
  // contain one).
  const kind = /^(?:file|folder):/u.exec(cursor);
  return kind === null ? cursor : `${kind[0]}${map(cursor.slice(kind[0].length))}`;
}

/** One page of the listing under `rawPrefix`, the workspace prefix hidden from keys and cursors. */
async function scopedListPage(
  backend: ObjectStore,
  prefix: string,
  rawPrefix: string,
  options: ListPageOptions | undefined,
): Promise<ObjectPage> {
  const fullPrefix = joinPrefixed(prefix, toObjectPrefix(rawPrefix));
  const stripLen = prefix.length + 1; // `${prefix}/`
  const inbound = options?.cursor;
  const page = await backend.listPage(fullPrefix, {
    ...options,
    limit: clampListLimit(options?.limit),
    ...(inbound === undefined
      ? {}
      : { cursor: mapCursorKey(inbound, (key) => joinPrefixed(prefix, key)) }),
  });
  return {
    cursor:
      page.cursor === null
        ? null
        : mapCursorKey(page.cursor, (key) =>
            key.startsWith(`${prefix}/`) ? key.slice(stripLen) : key,
          ),
    entries: page.entries.map((entry) => ({ ...entry, key: entry.key.slice(stripLen) })),
  };
}

/** The operations of `backend`, each key checked and then joined onto `prefix`. */
function scopedOperations(
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
    listPage(rawPrefix, options) {
      return scopedListPage(backend, prefix, rawPrefix, options);
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
