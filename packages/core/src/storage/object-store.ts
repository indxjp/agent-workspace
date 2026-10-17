/**
 * `ObjectStore` — spec §16's four methods (`put`/`get`/`delete`/`list`), and the scoping wrapper
 * that turns any backend into one that cannot be handed a key outside its own workspace.
 *
 * ## The shape spec §16 asks for, kept to four methods
 *
 * ```ts
 * interface ObjectStore {
 *   put(...)
 *   get(...)
 *   delete(...)
 *   list(...)
 * }
 * ```
 *
 * R-15 §1c records that this leaves two of §16's UI operations — rename and preview metadata —
 * unexpressed by the four methods alone, and that both are *composed* from them rather than added
 * as a fifth and sixth method: rename is `put(get(...))` then `delete`, and metadata comes back on
 * every `get`. That composition lives in `apps/web/server/files/**`, not here, because it is a
 * decision about the UI's needs, not about what an object store is.
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
 * task cannot add `"./storage"` to `packages/core/package.json`'s `exports` (see
 * `apps/web/server/files/object-store-bridge.ts`'s header for why), so `apps/web` reaches this
 * module by a *relative* import while it reaches `@agent-workspace/core/db` by the package
 * specifier — and those two resolve to **two different module instantiations** of the same source
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
import { toObjectKey, toObjectPrefix } from './key-safety.js';

/** One entry `list` returns: either a file with bytes, or a folder with none. */
export type ObjectListEntry =
  | {
      readonly kind: 'file';
      /** The workspace-relative key, exactly as `put` was called with it. */
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
 * The one listing order every backend returns: by key, compared code unit by code unit, so the
 * order does not depend on the host's locale.
 */
export function compareEntryKeys(left: ObjectListEntry, right: ObjectListEntry): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** What `put` writes. `body` is never text-decoded or re-encoded anywhere in this module. */
export interface PutObjectInput {
  readonly body: Uint8Array;
  /** Recorded and returned by `get`/`list`; `null` when the caller does not know it. */
  readonly contentType?: string | null;
}

/** What `get` returns for an object that exists. */
export interface ObjectContent {
  readonly body: Uint8Array;
  readonly contentType: string | null;
  readonly sizeBytes: number;
  readonly lastModified: Date;
}

/**
 * Spec §16's four operations, scoped to one workspace (or, for the raw backends in this
 * directory, operating on whatever key they are literally given — see each backend's header for
 * which one it is).
 *
 * Every key and prefix is workspace-relative: `contracts/agreement.pdf`, never a leading `/` and
 * never a `..` segment. `key-safety.ts` is what makes that a property every implementation shares
 * rather than a convention each one has to remember.
 */
export interface ObjectStore {
  /**
   * Write `input.body` at `key`, replacing whatever was there. Creates any implied intermediate
   * folder; does not require one to exist first, matching the S3 side, where a "folder" is
   * only ever a prefix and never a precondition.
   */
  put(key: string, input: PutObjectInput): Promise<void>;
  /** The object at `key`, or `null` if there is none. Never throws for "not found". */
  get(key: string): Promise<ObjectContent | null>;
  /**
   * Remove the object at `key`. Idempotent: a `key` that does not exist is not an error, matching
   * R-15 §1c's verified result for `DeleteObject` on both backends ("missing key -> HTTP 204, no
   * error, on both sides").
   */
  delete(key: string): Promise<void>;
  /**
   * Every file and folder directly under `prefix` — one level, not recursive, matching
   * `ListObjectsV2`'s `Delimiter: '/'` behaviour (R-15 §1c). `prefix` of `''` lists the workspace
   * root. A caller that wants a whole tree calls this once per folder it discovers, the same way
   * the S3 API itself is walked.
   */
  list(prefix: string): Promise<readonly ObjectListEntry[]>;
  /**
   * Every *file* object whose key is `prefix` itself or lies anywhere under it, however deep —
   * the recursive counterpart to {@link list}'s one level, added for W9-FILES-131's subtree
   * move/rename/delete. A "folder" is never itself an entry here: `object-store.ts`'s own model
   * has no folder that is not either an explicit empty-folder marker object or implied by the
   * files beneath it, both of which this method already reports as files. `prefix` of `''` walks
   * the whole workspace. Empty when nothing exists at or under `prefix`, never an error.
   */
  listPrefix(prefix: string): Promise<readonly ObjectListEntry[]>;
  /**
   * Copy the object at `sourceKey` to `destinationKey`, bytes and content type both, leaving
   * `sourceKey` untouched. A missing `sourceKey` is a no-op — nothing is written and nothing
   * throws — the same "absence is not an error" contract {@link delete} already has, and what
   * lets a subtree move recompute its remaining work from current store state and retry a
   * `copyObject` call that already succeeded without it becoming an error the second time.
   * Overwrites whatever was at `destinationKey`, matching {@link put}.
   */
  copyObject(sourceKey: string, destinationKey: string): Promise<void>;
}

/** Hands out an {@link ObjectStore} bound to one workspace. See this file's header. */
export interface ObjectStoreProvider {
  forWorkspace(workspaceId: string): ObjectStore;
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

  return {
    async put(key, input) {
      const relative = toObjectKey(key);
      await backend.put(joinPrefixed(prefix, relative), input);
    },
    async get(key) {
      const relative = toObjectKey(key);
      return backend.get(joinPrefixed(prefix, relative));
    },
    async delete(key) {
      const relative = toObjectKey(key);
      await backend.delete(joinPrefixed(prefix, relative));
    },
    async list(rawPrefix) {
      const relative = toObjectPrefix(rawPrefix);
      const fullPrefix = joinPrefixed(prefix, relative);
      const entries = await backend.list(fullPrefix);
      // Strip this workspace's own prefix back off before handing entries to the caller: the
      // caller never supplied it, so it must not appear in what comes back either.
      const stripLen = prefix.length + 1; // `${prefix}/`
      return entries.map((entry) =>
        entry.kind === 'folder'
          ? { ...entry, key: entry.key.slice(stripLen) }
          : { ...entry, key: entry.key.slice(stripLen) },
      );
    },
    async listPrefix(rawPrefix) {
      const relative = toObjectPrefix(rawPrefix);
      const fullPrefix = joinPrefixed(prefix, relative);
      const entries = await backend.listPrefix(fullPrefix);
      const stripLen = prefix.length + 1;
      return entries.map((entry) => ({ ...entry, key: entry.key.slice(stripLen) }));
    },
    async copyObject(sourceKey, destinationKey) {
      const relativeSource = toObjectKey(sourceKey);
      const relativeDestination = toObjectKey(destinationKey);
      await backend.copyObject(
        joinPrefixed(prefix, relativeSource),
        joinPrefixed(prefix, relativeDestination),
      );
    },
  };
}

/** Build an {@link ObjectStoreProvider} from any raw backend. Every backend module uses this. */
export function scopedObjectStoreProvider(backend: ObjectStore): ObjectStoreProvider {
  return {
    forWorkspace: (workspaceId: string): ObjectStore =>
      createScopedObjectStore(backend, workspaceId),
  };
}
