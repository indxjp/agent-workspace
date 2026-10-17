/**
 * The files operations, as functions of a `WorkspaceObjectStore` and already-parsed input.
 *
 * Mirrors `apps/web/server/agents/handlers.ts`'s split: nothing here touches `Request` or
 * `Response` (that is `http.ts`), and nothing here is a Next.js route file (that is
 * `apps/web/app/api/files/**`). A handler is testable by calling it with a fake store.
 *
 * ## What spec §16 asks for, and what this covers with four `ObjectStore` methods
 *
 * §16's list, quoted in full — all eight bullets, not the first six:
 *
 *   > upload · download · delete · rename · folders · preview metadata ·
 *   > assign folders/files to an agent · read-only or read-write access
 *
 * Six of the eight are here. `list` covers folders and preview metadata (every entry it returns
 * already carries `sizeBytes`/`contentType`/`lastModified`); `put`/`get`/`delete` cover
 * upload/download/delete directly. `rename` is composed — `renameFile` below is `get` then `put`
 * then `delete` — exactly the shape R-15 §1c describes for a `put`/`get`/`delete`-only store
 * ("Local FS is `fs.rename`, which is atomic within a filesystem" — this composition is *not*
 * atomic, which is declared in this task's PR rather than asserted away).
 *
 * **Declared gap — §16's last two bullets are not implemented anywhere in this task.**
 * "Assign folders/files to an agent" and "read-only or read-write access" are both *per-principal
 * authorisation over a path*, and this module has no principal: `http.ts`'s
 * `withWorkspaceObjectStore` resolves a workspace and nothing finer, so every member of a
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
import { decodeFileId, encodeFileId } from './file-id';
import { toObjectKey, toObjectPrefix, UnsafeObjectKeyError } from './object-store-bridge';
import type { ObjectStore } from './object-store-bridge';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';

/**
 * The internal marker object an explicit empty folder is stored as. Exported for
 * `subtree`-adjacent code in this module (`deleteSubtree`, `moveSubtree`) and for tests; not part
 * of the public HTTP surface — see `createFolder`'s use of it below for what it stands for.
 */
export const EMPTY_FOLDER_MARKER = '.agent-workspace-empty-folder';

async function pathIsFolder(store: ObjectStore, path: string): Promise<boolean> {
  if ((await store.get(`${path}/${EMPTY_FOLDER_MARKER}`)) !== null) return true;
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return (await store.list(parent)).some((entry) => entry.kind === 'folder' && entry.key === path);
}

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

/** A status and a body, before either becomes an HTTP `Response`. Mirrors `agents/handlers.ts`. */
export type ApiResult =
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
  | { readonly status: 204; readonly kind: 'empty' };

export interface ApiProblem {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly string[];
  };
}

export function problem(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): ApiResult {
  const error =
    details === undefined || details.length === 0
      ? { code, message }
      : { code, message, details: [...details] };
  return { status, kind: 'json', body: { error } satisfies ApiProblem };
}

function json(status: number, body: unknown): ApiResult {
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

function toResource(
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
): { ok: true; path: string } | { ok: false; result: ApiResult } {
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

/** `GET /api/files?path=…` — every file and folder one level under `path` (`''` for the root). */
export async function listFiles(store: ObjectStore, rawPrefix: string | null): Promise<ApiResult> {
  try {
    const prefix = toObjectPrefix(rawPrefix ?? '');
    const entries = await store.list(prefix);
    return json(200, {
      files: entries
        .filter(
          (entry) =>
            !entry.key.endsWith(`/${EMPTY_FOLDER_MARKER}`) && entry.key !== EMPTY_FOLDER_MARKER,
        )
        .map(toResource),
    });
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
}

/** What a `POST /api/files` upload carries, already parsed out of the request. */
export interface UploadFileInput {
  readonly path: string;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

/** Persist an explicit empty folder in flat object storage via an implementation-private marker. */
export async function createFolder(store: ObjectStore, rawPath: string): Promise<ApiResult> {
  try {
    const path = toObjectKey(rawPath);
    if (targetsRunnerPrivateDirectory(path))
      return problem(400, 'reserved_path', 'The .claude directory is reserved for runner state.');
    if (path.endsWith(`/${EMPTY_FOLDER_MARKER}`) || path === EMPTY_FOLDER_MARKER)
      return problem(400, 'reserved_path', 'That folder path is reserved for internal metadata.');
    if ((await store.get(path)) !== null)
      return problem(409, 'name_conflict', `${path} already exists as a file.`);
    const prefix = toObjectPrefix(path);
    const existing = await store.list(prefix);
    if (existing.length > 0) return problem(409, 'name_conflict', `${path} already exists.`);
    await store.put(`${path}/${EMPTY_FOLDER_MARKER}`, {
      body: new Uint8Array(),
      contentType: 'application/x.agent-workspace-folder',
    });
    return json(201, { file: toResource({ kind: 'folder', key: path }) });
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError)
      return problem(400, 'invalid_path', `"path" is not a valid folder path: ${error.message}`);
    throw error;
  }
}

/**
 * `POST /api/files` — write (or overwrite) one file.
 *
 * The `try` covers the store calls, not only this function's own `toObjectKey`. The guard runs
 * again inside `createScopedObjectStore` and a third time inside the backend, and verification
 * round 1 found an input the first application accepted and a later one refused — `%252e%252e%252fx`
 * — whose `UnsafeObjectKeyError` then escaped this route as a framework 500 while the comment here
 * claimed a 400. `key-safety.ts` is a filter now, so the accepted set is closed under the guard and
 * that input cannot exist (`key-safety.test.ts`, "the accepted set is closed under the guard"); the
 * wider `try` is the second, independent reason the claim in this sentence is true, so it does not
 * rest on that proof alone.
 */
export async function uploadFile(store: ObjectStore, input: UploadFileInput): Promise<ApiResult> {
  try {
    const key = toObjectKey(input.path);
    if (targetsRunnerPrivateDirectory(key))
      return problem(400, 'reserved_path', 'The .claude directory is reserved for runner state.');
    if (key.endsWith(`/${EMPTY_FOLDER_MARKER}`) || key === EMPTY_FOLDER_MARKER)
      return problem(400, 'reserved_path', 'That file path is reserved for internal metadata.');
    if (await pathIsFolder(store, key))
      return problem(409, 'name_conflict', `${key} already exists as a folder.`);
    await store.put(key, { body: input.body, contentType: input.contentType });
    const object = await store.get(key);
    if (object === null) {
      // Written, then immediately unreadable: this is the backend disagreeing with itself, not a
      // client error, and ADR-0015 says a check that cannot run must fail rather than guess a body.
      return problem(500, 'store_inconsistent', `${key} was written but could not be read back.`);
    }
    return json(201, {
      file: toResource({
        kind: 'file',
        key,
        sizeBytes: object.sizeBytes,
        contentType: object.contentType,
        lastModified: object.lastModified,
      }),
    });
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) {
      return problem(400, 'invalid_path', `"path" is not a valid file path: ${error.message}`);
    }
    throw error;
  }
}

/** Whether a file object exists at `path`, without reading its bytes. `false` for a path the key guard refuses. */
export async function fileObjectExists(store: ObjectStore, path: string): Promise<boolean> {
  let key: string;
  try {
    key = toObjectKey(path);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) return false;
    throw error;
  }
  return (await store.listPrefix(key)).some((entry) => entry.kind === 'file' && entry.key === key);
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

/** `GET /api/files/:id` — the file's bytes, or its metadata if it is a folder. */
export async function downloadFile(store: ObjectStore, path: string): Promise<ApiResult> {
  const object = await store.get(path);
  if (object === null) {
    // Might be a folder (a real object store's `get` never returns one) rather than nothing.
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const siblings = await store.list(parent);
    const asFolder = siblings.find((entry) => entry.kind === 'folder' && entry.key === path);
    if (asFolder !== undefined) return json(200, { file: toResource(asFolder) });
    return problem(404, 'file_not_found', 'No file has that id.');
  }
  return {
    status: 200,
    kind: 'binary',
    body: object.body,
    contentType: downloadContentType(object.contentType),
    filename: path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path,
  };
}

/** `DELETE /api/files/:id`. Idempotent at the `ObjectStore` layer; reported as `204` either way. */
export async function deleteFile(store: ObjectStore, path: string): Promise<ApiResult> {
  const marker = `${path}/${EMPTY_FOLDER_MARKER}`;
  if ((await store.get(marker)) !== null) await store.delete(marker);
  else await store.delete(path);
  return { status: 204, kind: 'empty' };
}

/** What a `PATCH /api/files/:id` rename carries. */
export interface RenameFileInput {
  readonly newPath: string;
}

/**
 * `PATCH /api/files/:id` — rename (move) a file. Composed from `get`/`put`/`delete`
 * (see this file's header for why, and for the atomicity this does not have).
 */
export async function renameFile(
  store: ObjectStore,
  path: string,
  input: RenameFileInput,
): Promise<ApiResult> {
  // Same shape as `uploadFile`: the `try` covers the store calls too, so a refusal from any of the
  // guard's applications is the documented 400 rather than an uncaught 500.
  try {
    const newKey = toObjectKey(input.newPath);
    if (targetsRunnerPrivateDirectory(newKey))
      return problem(400, 'reserved_path', 'The .claude directory is reserved for runner state.');
    if (newKey.endsWith(`/${EMPTY_FOLDER_MARKER}`) || newKey === EMPTY_FOLDER_MARKER)
      return problem(400, 'reserved_path', 'That file path is reserved for internal metadata.');
    const object = await store.get(path);
    if (object === null) {
      return problem(404, 'file_not_found', 'No file has that id.');
    }
    if (newKey === path) {
      return json(200, {
        file: toResource({
          kind: 'file',
          key: path,
          sizeBytes: object.sizeBytes,
          contentType: object.contentType,
          lastModified: object.lastModified,
        }),
      });
    }
    const existing = await store.get(newKey);
    if (existing !== null) {
      return problem(409, 'name_conflict', `${newKey} already exists.`);
    }
    if (await pathIsFolder(store, newKey))
      return problem(409, 'name_conflict', `${newKey} already exists as a folder.`);
    await store.put(newKey, { body: object.body, contentType: object.contentType });
    await store.delete(path);
    const moved = await store.get(newKey);
    if (moved === null) {
      return problem(
        500,
        'store_inconsistent',
        `${newKey} was written but could not be read back.`,
      );
    }
    return json(200, {
      file: toResource({
        kind: 'file',
        key: newKey,
        sizeBytes: moved.sizeBytes,
        contentType: moved.contentType,
        lastModified: moved.lastModified,
      }),
    });
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) {
      return problem(400, 'invalid_path', `"newPath" is not a valid file path: ${error.message}`);
    }
    throw error;
  }
}

/**
 * The largest subtree `moveSubtree`/`deleteSubtree` will act on in one request. Issue #131's
 * "Deliberately not built" is explicit that a bigger tree gets a hard refusal, not an unbounded
 * loop or a streamed/paginated operation — this is that cap. The number itself is not spec-given;
 * it is chosen small enough that a boundedness test can actually build a tree past it in a test's
 * timeout, and is a declared, documented choice rather than a discovered one.
 */
export const MAX_SUBTREE_OBJECTS = 500;

/** `a` and `b` name the same key except for letter case — a rename this module refuses outright.
 * See `moveSubtree`'s header for why: the copy-then-delete this module composes a move from is not
 * safe to run against a store whose backend folds case, and nothing here can tell which stores do
 * without asking the filesystem, so every store refuses it uniformly instead. */
function isCaseOnlyRename(a: string, b: string): boolean {
  return a !== b && a.toLowerCase() === b.toLowerCase();
}

/** `true` when `candidate` is `base` itself or lies under it (`base` or `${base}/…`). */
function isPathOrDescendant(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}/`);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * `null` when moving `descendants` (every object under `from`) to `to` is safe to proceed with;
 * otherwise the one destination key that stands in the way. "Safe" is content-aware rather than a
 * bare existence check, which is what makes a retry of an *interrupted* move succeed instead of
 * refusing itself: every object already at a key this move would itself write to is inspected, and
 * only counted as a collision when its bytes or content type actually differ from what the source
 * side has right now. An unrelated object at `to` that this move never intended to write over — a
 * sibling file already there, or `to` itself already existing as something else — still refuses,
 * because it is not one of this move's own keys at all.
 */
async function destinationCollision(
  store: ObjectStore,
  from: string,
  to: string,
  descendants: readonly { readonly key: string }[],
): Promise<string | null> {
  const expectedTargets = new Set(
    descendants.map((entry) => `${to}${entry.key.slice(from.length)}`),
  );
  const existingAtDestination = await store.listPrefix(to);
  for (const existing of existingAtDestination) {
    if (!expectedTargets.has(existing.key)) return existing.key;
    const sourceKey = `${from}${existing.key.slice(to.length)}`;
    const [sourceObject, destinationObject] = await Promise.all([
      store.get(sourceKey),
      store.get(existing.key),
    ]);
    if (sourceObject === null || destinationObject === null) return existing.key;
    if (
      !bytesEqual(sourceObject.body, destinationObject.body) ||
      sourceObject.contentType !== destinationObject.contentType
    ) {
      return existing.key;
    }
  }
  return null;
}

/**
 * Move or rename a folder — the subtree counterpart to `renameFile` above, which only ever moved
 * one object. Composed exactly the way issue #131 asks: copy every descendant to its new key,
 * rewrite the catalog's paths in one transaction, then delete every old key — never
 * delete-then-recreate, so `renameFilesByPrefix` (`resource-catalogs.ts`) keeps every row's id and
 * every `agent_files`/`project_files` grant on it.
 *
 * **Resumability.** Every step here is naturally idempotent on its own: `copyObject` of an
 * already-copied key overwrites identically, `renameFilesByPrefix` matches zero rows once it has
 * already run, and `delete` of an already-deleted key is a no-op (R-15 §1c). What made that true in
 * theory but not in practice was the destination-collision check — content this same move had
 * already copied on a prior, interrupted attempt would otherwise read back as "the destination
 * already exists" and refuse the retry. `destinationCollision` above is what closes that: it is a
 * collision only when a destination key this move would write to already holds *different* bytes
 * or a different content type than the source does right now, so a retry of the identical request
 * after a `'partial'` response converges to `'ok'` rather than refusing itself.
 */
export async function moveSubtree(
  store: ObjectStore,
  catalog: ResourceCatalogRepository | null,
  fromPath: string,
  input: RenameFileInput,
): Promise<ApiResult> {
  try {
    const from = toObjectKey(fromPath);
    const to = toObjectKey(input.newPath);
    if (targetsRunnerPrivateDirectory(from) || targetsRunnerPrivateDirectory(to)) {
      return problem(400, 'reserved_path', 'The .claude directory is reserved for runner state.');
    }
    if (from === to) {
      return json(200, { status: 'ok', moved: 0 });
    }
    if (isCaseOnlyRename(from, to)) {
      return problem(
        409,
        'name_conflict',
        'A rename that differs only in letter case is not supported.',
      );
    }
    if (isPathOrDescendant(from, to)) {
      return problem(
        409,
        'self_descendant',
        `${to} is inside ${from}, so it cannot be moved there.`,
      );
    }

    const descendants = await store.listPrefix(from);
    if (descendants.length === 0) {
      return problem(404, 'file_not_found', 'No file has that id.');
    }
    if (descendants.length > MAX_SUBTREE_OBJECTS) {
      return problem(
        413,
        'subtree_too_large',
        `${from} contains more than ${String(MAX_SUBTREE_OBJECTS)} objects; move a smaller folder.`,
      );
    }
    const collision = await destinationCollision(store, from, to, descendants);
    if (collision !== null) {
      return problem(409, 'name_conflict', `${collision} already exists.`);
    }

    const copied: string[] = [];
    for (const entry of descendants) {
      const destinationKey = `${to}${entry.key.slice(from.length)}`;
      try {
        await store.copyObject(entry.key, destinationKey);
        copied.push(entry.key);
      } catch {
        return json(200, {
          status: 'partial',
          moved: copied.length,
          total: descendants.length,
        });
      }
    }

    if (catalog !== null) {
      await catalog.renameFilesByPrefix?.(from, to);
    }

    const remaining: string[] = [];
    for (const key of copied) {
      try {
        await store.delete(key);
      } catch {
        remaining.push(key);
      }
    }
    if (remaining.length > 0) {
      return json(200, {
        status: 'partial',
        moved: copied.length,
        total: descendants.length,
        remaining,
      });
    }
    return json(200, { status: 'ok', moved: copied.length });
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) {
      return problem(400, 'invalid_path', `"newPath" is not a valid path: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Recursive folder delete — the fix for the bug issue #131 names verbatim: "deleting an
 * implied/non-empty folder can return 204 while descendants remain." `recursive` gates *removal*,
 * never discovery: this function always finds every descendant first, and answers `409` for a
 * non-empty folder when `recursive` is `false`, rather than silently deleting nothing and
 * reporting success. A path with no object and no descendant at all is reported as such (`null`)
 * rather than acted on, so the DELETE route can keep its existing idempotent-204 answer for "there
 * was never anything here" — the same contract a single-object delete already has — instead of
 * this function inventing a new one.
 */
export async function deleteSubtree(
  store: ObjectStore,
  rootPath: string,
  recursive: boolean,
): Promise<ApiResult | null> {
  const path = toObjectKey(rootPath); // already validated by the caller; re-checked defensively
  const descendants = await store.listPrefix(path);
  if (descendants.length === 0) return null;

  const marker = `${path}/${EMPTY_FOLDER_MARKER}`;
  const isEmptyFolder = descendants.every((entry) => entry.key === marker);
  if (!isEmptyFolder && !recursive) {
    return problem(
      409,
      'folder_not_empty',
      `${path} is not empty. Pass ?recursive=true to delete it and its contents.`,
    );
  }
  if (descendants.length > MAX_SUBTREE_OBJECTS) {
    return problem(
      413,
      'subtree_too_large',
      `${path} contains more than ${String(MAX_SUBTREE_OBJECTS)} objects; delete a smaller folder.`,
    );
  }

  const deleted: string[] = [];
  const remaining: string[] = [];
  for (const entry of descendants) {
    try {
      await store.delete(entry.key);
      deleted.push(entry.key);
    } catch {
      remaining.push(entry.key);
    }
  }
  if (remaining.length > 0) {
    return json(200, { status: 'partial', deleted, remaining });
  }
  return json(200, { status: 'ok', deleted });
}
