/**
 * The local-filesystem `ObjectStore` backend — spec §16's "Development: Local filesystem", and
 * R-15 §1a's "zero packages" row: this file imports nothing but `node:fs`, `node:fs/promises` and
 * `node:path`.
 *
 * ## Binary, deliberately, at every step
 *
 * The downstream consumer this task is told to design for — W2-CP-04's skills importer — "must
 * get a BYTE-IDENTICAL tree back, including one file with a trailing newline and one without. No
 * normalisation, no implicit text mode, no line-ending translation." `node:fs` does not translate
 * line endings on its own on any platform (that is a `readFile`/`writeFile` *text-encoding*
 * concern, not a platform one), so the whole of what this module has to get right is: never pass
 * an `encoding` option to a read or a write. Every `readFile` below returns a `Buffer`; every
 * `writeFile` below is given one. `put`'s caller hands this module a `Uint8Array` and `get`
 * returns one; neither is ever decoded to a JS string or re-encoded from one. The one place this
 * module writes text at all is the content-type sidecar file (below), which is metadata this
 * module invented, not user data — and even that write goes through `writeFile` with an explicit
 * `'utf8'` encoding named at the call site, so it can never be mistaken for the object write beside
 * it.
 *
 * ## The second guard call site
 *
 * `object-store.ts`'s header names this file as the second place `key-safety.ts`'s guard runs —
 * on the *full*, already-workspace-prefixed key, after `createScopedObjectStore` has already
 * validated the caller's relative one. `toFsPath` below is that call site: every one of `put`,
 * `get`, `delete` and `list` calls it before touching `node:fs`, so a backend reached directly
 * (bypassing the scoping wrapper — a test, or a future caller) still cannot be handed a key that
 * escapes `rootDir`.
 *
 * ## Two trees under one root: `objects/` and `metadata/`
 *
 * A POSIX or NTFS file has no S3-style `Content-Type` header. `put`'s caller may supply one (spec
 * §16's "preview metadata"), and `get`/`list` are expected to hand the same value back, so
 * something has to remember it. This module writes one small JSON file per object. **Where** it
 * writes it is the part three rounds of verification were about:
 *
 * ```
 * <rootDir>/objects/workspaces/<id>/note.txt                              the bytes
 * <rootDir>/metadata/workspaces/<id>/note.txt.__objectstore_meta__.json   its content type
 * ```
 *
 * Every key this module is given names a path under `<rootDir>/objects`, and only there:
 * `toFsPath` joins the validated key onto that directory, and `key-safety.ts` refuses `..`, an
 * absolute path, a drive letter, a backslash and an empty segment, so a key cannot climb out of it
 * (that is W2-plan.md's second acceptance criterion, proved in `contract.ts`). A sidecar lives
 * under `<rootDir>/metadata`, which is a sibling of that directory rather than a place inside it.
 * **The two namespaces do not intersect, so no key — however it is spelled, and whatever second
 * name the filesystem gives the file it lands on — resolves to a sidecar's path.**
 *
 * That claim is about *path resolution*, which is all this module controls. Where those paths lead
 * is the filesystem's business: a junction or symlink planted inside `objects/` — which takes a
 * write into `rootDir` from outside this API — makes the tree extend wherever it points, and
 * `node:fs` follows it. Out of band rather than an API privilege escalation, declared on this
 * task's PR, and stated here rather than left implied by an absolute sentence.
 *
 * ### Why not a sidecar beside the object, which is what this file used to do
 *
 * The old scheme named the sidecar by appending a suffix to the object's *own* path. Three rounds
 * of verification broke it three times, each time by a different equivalence in the filesystem's
 * namespace, and each time the repair was a broader rule about names:
 *
 *   1. **Round 1** — `POST /api/files` accepted `note.txt.__objectstore_meta__.json`, so an
 *      uploader chose the `Content-Type` served for someone else's `note.txt`, invisibly to
 *      `list()`. Repair: a guard rule refusing that exact suffix.
 *   2. **Round 2** — the rule compared exact case; NTFS and APFS fold case, so
 *      `note.txt.__objectstore_meta__.JSON` reached the same file. Repair: a case-blind rule about
 *      the marker, plus a `%` in the sidecar's name (no accepted key contains a `%`).
 *   3. **Round 3** — NTFS mints an 8.3 short name for the sidecar in a `%`-free, marker-free
 *      alphabet: `NOTETX~1.JSO` is a second, real name for
 *      `note.txt.%__objectstore_meta__%.json`, it is accepted by the guard, and it is
 *      blind-guessable from the victim's name. The `%` argument reasoned only about
 *      transformations of the *caller's* string; the filesystem transforms in the other direction.
 *
 * The root cause is one thing, and it is not the rules: **a name derived by appending to a
 * caller-controlled key inherits every alias the namespace mints for that key.** Case folds, 8.3
 * short names, `::$DATA` streams, and whatever the next filesystem does. A fourth rule would lose
 * to a fourth alias, so this module stopped deriving the sidecar's *reachability* from its
 * spelling. `metadata/` is not hidden, not reserved and not cleverly named — it is simply not
 * inside the tree keys address. `key-safety.ts`'s `reserved-name` rule still refuses the marker,
 * but it is a name reservation shared across backends now, not the thing that protects this one.
 *
 * ### What the split costs, and what it does not
 *
 * `put` and `delete` now touch two trees instead of one, which is the drift the old scheme was
 * chosen to avoid. Two writes can fail apart, so each one says what it costs, and neither says
 * "nothing":
 *
 *   - **`put`.** The object write is the operation; the sidecar write is best effort and is
 *     wrapped in a `catch` (below). A failed sidecar write costs the *content type* — `get` and
 *     `list` report `contentType: null`, the degradation this module already applies to a missing
 *     or unparseable sidecar — and nothing else: the object is written, `put` resolves, and the
 *     caller is told the truth about the bytes. Round 5 found this claim made while the `catch`
 *     did not exist, so the same failure instead threw *after* the object had landed, out through
 *     the route handler as a framework `500` for a write that had succeeded. The `catch` is what
 *     makes the sentence true; a stale sidecar from an earlier object at the same key is removed
 *     on that path, and survives only if its removal fails too.
 *   - **`delete`.** Not wrapped. If the object is removed and the sidecar removal then throws, the
 *     call throws with the object already gone and an orphaned sidecar left behind — which a later
 *     object at the same key adopts if *its* sidecar write also fails. That needs a metadata tree
 *     this process cannot write to, so it is out of band rather than reachable from the API, and
 *     it is declared on this task's PR rather than repaired here.
 *
 * `list` reads the object tree alone and filters nothing out of it by name — there is nothing of
 * this module's in there to filter — so no object a caller writes can be hidden from its own
 * listing. It does still skip directory entries that are neither a file nor a directory (symlinks,
 * junctions: see `!entry.isFile()` below), which is a filter about *kind*, not about naming, and
 * is declared as such on the PR.
 *
 * A streamed `write` and a `copy` add a third sibling, `<rootDir>/staging/`: bytes land there
 * first, then `rename` (or `link`, for `ifNoneMatch`) moves them into `objects/`. It is a sibling so
 * it shares the object tree's volume (the move stays atomic) and is never listed; a failed `write`
 * or `copy` removes its staging file.
 *
 * This module never re-validates the string it builds itself: both paths are derived from an
 * already-validated key, below, not from a string handed back through the guard.
 */
import type { BigIntStats, Dirent } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  addressableObjectName,
  OBJECT_METADATA_SUFFIX,
  toObjectKey,
  toObjectPrefix,
} from './key-safety.js';
import { withKeyLock } from './key-lock.js';
import {
  scopedObjectStoreProvider,
  ObjectConflictError,
  validatedWriteKey,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectStore,
  type ObjectStoreProvider,
} from './object-store.js';
import {
  abortableBody,
  inWalkOrder,
  listPageFrom,
  resolveRange,
  toNodeReadable,
  toWebStream,
  walkedBefore,
} from './streams.js';

/**
 * The subdirectory of `rootDir` every object key is resolved under. Callers address paths inside
 * this tree and nothing else; see this file's header.
 */
const OBJECT_TREE = 'objects';

/**
 * The subdirectory of `rootDir` holding content-type sidecars, a *sibling* of {@link OBJECT_TREE}
 * rather than anything inside it. No object key resolves here, so nothing a caller can spell —
 * and no second name a filesystem mints for a file — names a sidecar.
 */
const METADATA_TREE = 'metadata';

/**
 * Appended to a sidecar's path inside {@link METADATA_TREE} so a stray file found there is
 * recognisable. It does **no** protective work: what keeps a sidecar out of reach is the tree it
 * lives in, not how it is spelled. (`key-safety.ts` refuses this string as a key as well, by the
 * `reserved-name` rule — a reservation shared with every backend, not this backend's defence.)
 */
const META_SUFFIX = OBJECT_METADATA_SUFFIX;

/**
 * The subdirectory of `rootDir` a streamed `write` stages its bytes in before moving them into
 * {@link OBJECT_TREE}. A third sibling, for two reasons: it is on the same volume as the object
 * tree, so `rename` and `link` stay atomic, and nothing lists it, so a half-written file is never
 * an object. A failed `write` removes its staging file.
 */
const STAGING_TREE = 'staging';

interface Sidecar {
  readonly contentType: string | null;
}

function isSidecarPayload(value: unknown): value is Sidecar {
  if (typeof value !== 'object' || value === null) return false;
  const contentType = (value as Record<string, unknown>)['contentType'];
  return contentType === null || typeof contentType === 'string';
}

/** A `NodeJS.ErrnoException`-shaped rejection carrying the code named. */
function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

async function directoryContainsObject(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' });
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await directoryContainsObject(path.join(directory, entry.name)))) {
      return true;
    }
  }
  return false;
}

/**
 * One `ObjectStore` over a directory on disk. `key` here is already the *full* key — a scoped
 * store's caller-relative key with its workspace prefix joined on — never a caller-facing
 * workspace-relative one; see this file's header for why it is validated again anyway.
 */
export function createLocalFilesystemObjectStore(rootDir: string): ObjectStore {
  const resolvedRoot = path.resolve(rootDir);
  const objectRoot = path.join(resolvedRoot, OBJECT_TREE);
  const metadataRoot = path.join(resolvedRoot, METADATA_TREE);

  /**
   * Validate `key` (a full store key) and map it to an absolute path under {@link OBJECT_TREE}.
   * Every filesystem access this module makes for object *bytes* goes through here, so "a key
   * addresses the object tree and only the object tree" is a property of one function.
   */
  function toFsPath(key: string): string {
    const safe = toObjectKey(key);
    return path.join(objectRoot, ...safe.split('/'));
  }

  function toFsDir(prefix: string): string {
    const safe = toObjectPrefix(prefix);
    return safe === '' ? objectRoot : path.join(objectRoot, ...safe.split('/'));
  }

  /**
   * The sidecar path for `key`, under {@link METADATA_TREE}. It is derived from the *same*
   * validated key as {@link toFsPath}, but rooted at a sibling directory — which is what makes a
   * sidecar unreachable from any key, rather than any property of the name itself.
   */
  function toMetaPath(key: string): string {
    const safe = toObjectKey(key);
    return path.join(metadataRoot, ...safe.split('/')) + META_SUFFIX;
  }

  async function readSidecar(metaPath: string): Promise<string | null> {
    try {
      const text = await readFile(metaPath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      return isSidecarPayload(parsed) ? parsed.contentType : null;
    } catch {
      // Missing, unreadable or malformed sidecar: the content type is unknown, not an error.
      return null;
    }
  }

  /** ETag = size + nanosecond mtime + inode: a `write` renames a new file in, so it changes. */
  async function metaFor(key: string): Promise<ObjectMeta | null> {
    let stats: BigIntStats;
    try {
      stats = await stat(toFsPath(key), { bigint: true });
    } catch (error) {
      if (hasErrnoCode(error, 'ENOENT') || hasErrnoCode(error, 'ENOTDIR')) return null;
      throw error;
    }
    return stats.isFile() ? metaFromStats(key, stats) : null;
  }

  async function metaFromStats(key: string, stats: BigIntStats): Promise<ObjectMeta> {
    return {
      sizeBytes: Number(stats.size),
      contentType: await readSidecar(toMetaPath(key)),
      etag: `"${stats.size}-${stats.mtimeNs}-${stats.ino}"`,
      lastModified: stats.mtime,
    };
  }

  /** Best effort, as this file's header explains: a failed sidecar write costs only the content type. */
  async function writeSidecar(key: string, contentType: string | null): Promise<void> {
    const metaPath = toMetaPath(key);
    const sidecar: Sidecar = { contentType };
    try {
      await mkdir(path.dirname(metaPath), { recursive: true });
      await writeFile(metaPath, JSON.stringify(sidecar), 'utf8');
    } catch {
      await rm(metaPath, { force: true }).catch(() => undefined);
    }
  }

  const listing = {
    async *level(prefix, after): AsyncGenerator<ObjectListEntry> {
      const dir = toFsDir(prefix);
      const safePrefix = toObjectPrefix(prefix);
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
      } catch (error) {
        // No such folder, or the prefix names a file rather than a folder: both read as "nothing
        // is here", not as an error — the same shape `get` uses for ENOENT/EISDIR.
        if (hasErrnoCode(error, 'ENOENT') || hasErrnoCode(error, 'ENOTDIR')) return;
        throw error;
      }

      // Nothing a caller can write is filtered out of this listing *by name*. The object tree
      // contains objects and only objects — sidecars live in a sibling tree — so no name a caller
      // can write is hidden from its own listing, which is the invisibility half of F3 (rounds
      // 1-3). A name the key guard refuses (put there by another tool) is skipped: no caller could
      // address it. The other filter is about *kind*, below: an entry that is neither a file nor a directory is skipped,
      // so a junction or symlink planted here out of band is reachable through `get`/`list` while
      // being absent from its parent's listing. Declared on this task's PR, not repaired here.
      // In name order, which is key order here; nothing before the cursor is looked at again.
      for (const entry of inWalkOrder(entries, () => false)) {
        const key = safePrefix === '' ? entry.name : `${safePrefix}/${entry.name}`;
        if (addressableObjectName(key) === null) continue; // a name another tool wrote
        if (after !== undefined && key < after) continue;
        if (entry.isDirectory()) {
          // S3 folders are prefixes, not durable directory entries. Ignore an empty physical
          // directory left after its last object (including an explicit-folder marker) is removed.
          if (await directoryContainsObject(path.join(dir, entry.name))) {
            yield { kind: 'folder', key };
          }
          continue;
        }
        if (!entry.isFile()) continue; // symlinks and other special files: not §16's concern
        const entryPath = path.join(dir, entry.name);
        // Built from the directory entry rather than re-validated through the guard: these names
        // came from `readdir` of a directory this module owns, and a name on disk need not be a
        // string the guard would accept (a file put there by something else).
        const metaPath =
          path.join(metadataRoot, ...(safePrefix === '' ? [] : safePrefix.split('/')), entry.name) +
          META_SUFFIX;
        const [stats, contentType] = await Promise.all([stat(entryPath), readSidecar(metaPath)]);
        yield {
          kind: 'file',
          key,
          sizeBytes: stats.size,
          contentType,
          lastModified: stats.mtime,
        };
      }
    },

    async *tree(prefix, after): AsyncGenerator<ObjectListEntry> {
      const safePrefix = toObjectPrefix(prefix);
      // The object AT `prefix` itself, if there is one — only a plain file key can be one; a
      // folder never has bytes at its own path (`files.ts`'s schema comment says the same thing
      // for the catalog row). Checked before the recursive walk so a `prefix` naming a file
      // behaves the same as one naming a folder that contains descendants: both report every
      // object at or beneath `prefix`.
      if (safePrefix !== '') {
        try {
          const selfPath = toFsPath(safePrefix);
          const stats = await stat(selfPath);
          if (stats.isFile()) {
            const contentType = await readSidecar(toMetaPath(safePrefix));
            yield {
              kind: 'file',
              key: safePrefix,
              sizeBytes: stats.size,
              contentType,
              lastModified: stats.mtime,
            };
          }
        } catch (error) {
          if (!hasErrnoCode(error, 'ENOENT') && !hasErrnoCode(error, 'ENOTDIR')) throw error;
        }
      }

      // In key order, skipping every folder and file the cursor is already past.
      async function* walk(dir: string, keyPrefix: string): AsyncGenerator<ObjectListEntry> {
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
        } catch (error) {
          if (hasErrnoCode(error, 'ENOENT') || hasErrnoCode(error, 'ENOTDIR')) return;
          throw error;
        }
        for (const entry of inWalkOrder(entries, (dirent) => dirent.isDirectory())) {
          const key = keyPrefix === '' ? entry.name : `${keyPrefix}/${entry.name}`;
          if (entry.isDirectory()) {
            if (!walkedBefore(key, after)) yield* walk(path.join(dir, entry.name), key);
            continue;
          }
          if (!entry.isFile()) continue; // symlinks and other special files: see `list()`'s comment
          if (addressableObjectName(key) === null) continue; // a name another tool wrote
          if (after !== undefined && key < after) continue;
          const entryPath = path.join(dir, entry.name);
          const metaPath =
            path.join(metadataRoot, ...(keyPrefix === '' ? [] : keyPrefix.split('/')), entry.name) +
            META_SUFFIX;
          const [stats, contentType] = await Promise.all([stat(entryPath), readSidecar(metaPath)]);
          yield {
            kind: 'file',
            key,
            sizeBytes: stats.size,
            contentType,
            lastModified: stats.mtime,
          };
        }
      }

      yield* walk(toFsDir(safePrefix), safePrefix);
    },
  } satisfies Parameters<typeof listPageFrom>[0];

  const backend: ObjectStore = {
    // A file system cannot hold a file and a folder at one path.
    capabilities: {
      sign: false,
      boundLengthSign: false,
      range: true,
      conditionalPut: true,
      fileAndFolderShareKey: false,
    },

    head: (key) => metaFor(key),

    async read(key, options) {
      options?.signal?.throwIfAborted();
      // One handle for meta and body, so a concurrent `write` renaming a new file into place
      // cannot make `meta` describe a different inode than the bytes served.
      let handle: FileHandle;
      try {
        handle = await open(toFsPath(key), 'r');
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].some((code) => hasErrnoCode(error, code))) return null;
        throw error;
      }
      try {
        const stats = await handle.stat({ bigint: true });
        if (!stats.isFile()) {
          await handle.close();
          return null;
        }
        const meta = await metaFromStats(key, stats);
        const range = resolveRange(options?.range, meta.sizeBytes);
        const source = handle.createReadStream(
          range === null ? {} : { start: range.start, end: range.end },
        );
        return { meta, range, body: abortableBody(toWebStream(source), options?.signal) };
      } catch (error) {
        await handle.close().catch((closeError: unknown) => {
          throw new AggregateError(
            [error, closeError],
            'read failed and its file handle did not close',
          );
        });
        throw error;
      }
    },

    async write(key, body, options): Promise<ObjectMeta> {
      const objectPath = await validatedWriteKey(body, options, () => toFsPath(key));
      const stagingDir = path.join(resolvedRoot, STAGING_TREE);
      const staged = path.join(stagingDir, randomUUID());
      const source = toNodeReadable(abortableBody(body, options.signal));
      try {
        await mkdir(stagingDir, { recursive: true });
        await mkdir(path.dirname(objectPath), { recursive: true });
        await pipeline(source, createWriteStream(staged));
        // Commit, sidecar and the returned meta all happen under the key lock, so a concurrent
        // `write` to the same key cannot interleave its bytes with this one's content type.
        return await withKeyLock(objectPath, async () => {
          if (options.ifNoneMatch === '*') {
            // A hard link fails with EEXIST if the key is taken: atomic on disk.
            try {
              await link(staged, objectPath);
            } catch (error) {
              if (hasErrnoCode(error, 'EEXIST')) throw new ObjectConflictError();
              throw error;
            }
          } else {
            if (options.ifMatch !== undefined) {
              // ponytail: ifMatch is atomic within one process only; Phase 3 row-first writes make it moot
              if ((await metaFor(key))?.etag !== options.ifMatch) throw new ObjectConflictError();
            }
            await rename(staged, objectPath);
          }
          await writeSidecar(key, options.contentType ?? null);
          const meta = await metaFor(key);
          if (meta === null)
            throw new Error('The object vanished immediately after it was written.');
          return meta;
        });
      } finally {
        // Cancels the source stream if it was not read to the end (a no-op once it has been).
        source.destroy();
        await rm(staged, { force: true });
      }
    },

    // ponytail: pages an in-memory listing of one directory; fine for local disk
    listPage: (prefix, options) => listPageFrom(listing, prefix, options),

    async delete(key): Promise<void> {
      const objectPath = toFsPath(key);
      // `force: true` is the R-15 §1c contract: deleting a missing key is success, not an error,
      // on both backends.
      try {
        await rm(objectPath, { force: true });
      } catch (error) {
        // A prefix is not an object. Windows reports EISDIR where S3 simply deletes no matching
        // key; preserve the object-store contract without recursively deleting the prefix.
        if (!hasErrnoCode(error, 'EISDIR') && !hasErrnoCode(error, 'ERR_FS_EISDIR')) throw error;
      }
      await rm(toMetaPath(key), { force: true });
    },

    async copy(sourceKey, destinationKey): Promise<void> {
      const destinationPath = toFsPath(destinationKey);
      // The source is opened exactly as `read` opens it, so a copy sees what a read would: the
      // same missing-key answers and the same symlink policy (this file's header).
      let handle: FileHandle;
      try {
        handle = await open(toFsPath(sourceKey), 'r');
      } catch (error) {
        // A missing source is a no-op — see `object-store.ts`'s header for why this is what makes
        // a retried subtree move idempotent rather than an error the second time.
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].some((code) => hasErrnoCode(error, code))) return;
        throw error;
      }
      // Staged and renamed into place under the key lock, as `write` does: a failed copy leaves
      // no destination, and a concurrent `read` sees the old file or the new one, never a part.
      const stagingDir = path.join(resolvedRoot, STAGING_TREE);
      const staged = path.join(stagingDir, randomUUID());
      try {
        if (!(await handle.stat()).isFile()) return; // nothing this API considers an object
        await mkdir(stagingDir, { recursive: true });
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(staged));
        const contentType = await readSidecar(toMetaPath(sourceKey));
        await withKeyLock(destinationPath, async () => {
          await rename(staged, destinationPath);
          // The object copy is the operation; the sidecar is best effort, as for `write`.
          await writeSidecar(destinationKey, contentType);
        });
      } finally {
        try {
          await handle.close();
        } finally {
          await rm(staged, { force: true });
        }
      }
    },
  };
  return backend;
}

/**
 * The local-filesystem {@link ObjectStoreProvider}: every workspace gets its own subtree of
 * `rootDir`, via {@link scopedObjectStoreProvider} — the same wrapper any future backend uses, so
 * "which workspace this key belongs to" is decided in exactly one place regardless of backend.
 */
export function createLocalFilesystemObjectStoreProvider(rootDir: string): ObjectStoreProvider {
  return scopedObjectStoreProvider(createLocalFilesystemObjectStore(rootDir));
}
