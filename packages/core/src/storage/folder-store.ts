/**
 * The folder `ObjectStore` behind a `file://` storage connection (the storage design, §05
 * Security). Key `a/b/c.txt` is the file `<root>/a/b/c.txt`: no `objects/` tree, no sidecar, and the
 * content type comes from the file name. Only connections use it; the platform's own store keeps
 * `createLocalFilesystemObjectStore`.
 *
 * ## Nothing leaves the root
 *
 * `root` is already a realpath under `AW_STORAGE_CONNECTION_FILE_ROOTS`, and keys go through the key
 * guard and are never decoded. A refused read looks exactly like a missing file, so the target of a
 * link never leaks; a listing reports only a count of what it left out. No symlink is read, listed or
 * written through as the last component of a key, and a listing never descends into one.
 *
 * On Linux (production and CI) containment is decided by what was opened, not by a path: after
 * every open, `/proc/self/fd/<fd>` must resolve inside the root, and every child operation (readdir,
 * lstat, mkdir, the staged write, rename, link, unlink) goes through `/proc/self/fd/<dirfd>/<name>`
 * of a verified directory, which is what `openat` would do. A directory swapped for a link between
 * any two steps therefore cannot redirect a read, a listing, a write or a delete outside the root.
 *
 * Where `/proc/self/fd` does not exist, the fallback is a path check: the realpath is checked, the
 * file is opened `O_NOFOLLOW`, and the path must still resolve to itself and to the opened inode.
 * A toggling attacker can satisfy those two snapshots at different moments, so the fallback does
 * not hold against a concurrent swap.
 *
 * Residual risks, on every platform:
 * - hard links and bind mounts inside the root are invisible to realpath checks (hard links to
 *   another user's files are limited by `fs.protected_hardlinks`);
 * - a directory moved out of the root after it was verified is checked again just before the
 *   rename, link or unlink that changes it, and refused if it now resolves outside the root; a move
 *   between that check and the call still lands the change in the moved directory (its own
 *   content, never a pre-existing outside file);
 * - `ifMatch` is checked and renamed atomically within one process only;
 * - a read re-resolves its key, so a key may name a different inside file between two calls.
 */
import { randomUUID } from 'node:crypto';
import { constants, existsSync, type BigIntStats, type Dirent } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { inferContentType } from './content-type.js';
import { addressableObjectName, toObjectKey, toObjectPrefix } from './key-safety.js';
import { withKeyLock } from './key-lock.js';
import {
  ObjectConflictError,
  validatedWriteKey,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectStore,
} from './object-store.js';
import {
  inWalkOrder,
  listPageFrom,
  resolveRange,
  toNodeReadable,
  toWebStream,
  walkedBefore,
} from './streams.js';

/** A key resolved to a path outside the folder. The message is the code, never a path. */
export class FolderPathError extends Error {
  public readonly code = 'storage_connection_endpoint_forbidden' as const;

  public constructor() {
    super('storage_connection_endpoint_forbidden');
    this.name = 'FolderPathError';
  }
}

/**
 * A filesystem failure. The message names the key and the errno code only: Node's own error carries
 * absolute host paths, so it is dropped rather than chained.
 */
export class FolderStoreError extends Error {
  public constructor(
    public readonly key: string,
    public readonly code: string,
  ) {
    super(`The folder could not serve ${JSON.stringify(key)} (${code}).`);
    this.name = 'FolderStoreError';
  }
}

/** What a listing left out. Counts only: a name or path could carry the target of a link. */
export interface FolderSkipCounts {
  /** Symlinks, and folders that resolve outside the root. */
  readonly links: number;
  /** Files or directories the process cannot read. */
  readonly unreadable: number;
}

export interface FolderStoreOptions {
  readonly onSkipped?: (counts: FolderSkipCounts) => void;
  /** Test seam: runs just before a read (or `listPrefix`, which tries its prefix as a key) opens it. */
  readonly beforeOpen?: () => Promise<void>;
  /** Test seam: runs just before a listing reads the names in a folder it has opened. */
  readonly beforeReaddir?: () => Promise<void>;
  /** Test seam: runs between the write's parent check and the staged file's creation. */
  readonly beforeStage?: () => Promise<void>;
  /** Test seam: runs once the staged file exists, before it is checked. */
  readonly afterStage?: () => Promise<void>;
  /** Test seam: runs once the staged file is written, before it is renamed or linked into place. */
  readonly beforeCommit?: () => Promise<void>;
  /** Test seam: runs between the delete's parent check and the unlink. */
  readonly beforeDelete?: () => Promise<void>;
  /**
   * Internal: resolve through `/proc/self/fd`. Defaults to whether it exists; tests pass `false` to
   * exercise the path-check fallback. Not part of the connection options.
   */
  readonly procFd?: boolean;
}

/** `target` is `root` or lies under it; both are real paths. */
export function isInside(root: string, target: string): boolean {
  return (
    target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
  );
}

/** A write temp name. The key guard refuses a bare `%`, so a half-written file is never listed. */
const TEMP_PREFIX = '.%aw-write-';
/** A new file's mode, less the process umask. An overwrite keeps the replaced file's mode. */
const NEW_FILE_MODE = 0o644;

const PROC_FD = '/proc/self/fd';
const HAS_PROC_FD = existsSync(PROC_FD);

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const STAGE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const ABSENT = ['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR', 'ENAMETOOLONG', 'EACCES', 'EPERM'];

/**
 * A read body's stream closes its file when it is read to the end, fails or is cancelled. One that
 * is dropped unread would hold the file until the collector closed the handle itself, which Node
 * deprecates (DEP0137). This closes it once the body is unreachable; the registry holds the handle,
 * so the handle outlives its body.
 */
const unreadBodies = new FinalizationRegistry<FileHandle>((handle) => {
  if (handle.fd === -1) return;
  handle.close().catch((error: unknown) => {
    process.emitWarning('A folder-store read body could not close its file.', {
      code: 'AW_FOLDER_STORE_CLOSE',
      detail: error instanceof Error ? error.name : 'unknown',
    });
  });
});

function hasErrnoCode(error: unknown, codes: readonly string[]): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

/** `null` for an error in `codes`; any other error is rethrown. */
async function unless<T>(work: Promise<T>, codes: readonly string[]): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (hasErrnoCode(error, codes)) return null;
    throw error;
  }
}

/** A Node system error (it names a `syscall`, and usually a host path) becomes a key-only error. */
function withoutHostPaths(key: string, error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    'syscall' in error &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return new FolderStoreError(key, error.code);
  }
  return error;
}

async function guarded<T>(key: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw withoutHostPaths(key, error);
  }
}

/** An open file or directory, and where it really is. */
interface Opened {
  readonly handle: FileHandle;
  readonly real: string;
}

type Counts = { links: number; unreadable: number };

export function createFolderObjectStore(
  root: string,
  options: FolderStoreOptions = {},
): ObjectStore {
  const segmentsOf = (key: string): string[] => toObjectKey(key).split('/');
  const procFd = options.procFd ?? HAS_PROC_FD;

  /** The path of the open `dir` itself: its descriptor on Linux, its checked real path elsewhere. */
  const pathOf = (dir: Opened): string => (procFd ? `${PROC_FD}/${dir.handle.fd}` : dir.real);

  /** `name` inside the open `dir`, resolved through the descriptor (like `openat`) on Linux. */
  const childOf = (dir: Opened, name: string): string => path.join(pathOf(dir), name);

  /** Where `handle` really is, when that is inside the root. `opened` is the path it came from. */
  async function located(handle: FileHandle, opened: string): Promise<string | null> {
    let real: string | null;
    if (procFd) {
      real = await realpath(`${PROC_FD}/${handle.fd}`).catch(() => null);
    } else {
      // Fallback: the path still resolves to itself and to the inode that was opened.
      const [held, named, resolved] = await Promise.all([
        handle.stat({ bigint: true }),
        stat(opened, { bigint: true }).catch(() => null),
        realpath(opened).catch(() => null),
      ]);
      real =
        resolved === opened && named?.ino === held.ino && named.dev === held.dev ? resolved : null;
    }
    return real !== null && isInside(root, real) ? real : null;
  }

  /** `candidate` opened with `flags`, or `null` when what was opened is outside the root. */
  async function openVerified(candidate: string, flags: number): Promise<Opened | null> {
    if (!procFd && !isInside(root, await realpath(candidate))) return null;
    // The name asked for, so `O_NOFOLLOW` refuses a final link and `located` refuses a linked
    // parent; opening the resolved target would silently follow an alias inside the root.
    const handle = await open(candidate, flags);
    let keep = false;
    try {
      const real = await located(handle, candidate);
      if (real === null) return null;
      keep = true;
      return { handle, real };
    } finally {
      if (!keep) await handle.close();
    }
  }

  /** `dir` still resolves inside the root: a folder moved out since it was opened is refused. */
  async function assertStillInside(dir: Opened): Promise<void> {
    if ((await located(dir.handle, dir.real)) === null) throw new FolderPathError();
  }

  /** The folder `segments` names, or `null` when it is missing, unreadable or a link. */
  async function openFolder(segments: readonly string[]): Promise<Opened | null> {
    return unless(openVerified(path.join(root, ...segments), DIRECTORY_FLAGS), ABSENT);
  }

  function metaOf(key: string, stats: BigIntStats): ObjectMeta {
    return {
      sizeBytes: Number(stats.size),
      contentType: inferContentType(key),
      etag: `"${stats.size}-${stats.mtimeNs}-${stats.ino}"`,
      lastModified: stats.mtime,
    };
  }

  async function openObject(
    key: string,
  ): Promise<{ readonly handle: FileHandle; readonly stats: BigIntStats } | null> {
    const candidate = path.join(root, ...segmentsOf(key));
    await options.beforeOpen?.();
    const opened = await unless(openVerified(candidate, READ_FLAGS), ABSENT);
    if (opened === null) return null;
    let keep = false;
    try {
      const stats = await opened.handle.stat({ bigint: true });
      if (!stats.isFile()) return null;
      keep = true;
      return { handle: opened.handle, stats };
    } finally {
      if (!keep) await opened.handle.close();
    }
  }

  async function children(
    dir: Opened,
    counts: Counts,
  ): Promise<Array<{ readonly kind: 'file' | 'dir'; readonly name: string }>> {
    let dirents: Dirent[];
    try {
      await options.beforeReaddir?.();
      dirents = await readdir(pathOf(dir), { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      if (hasErrnoCode(error, ['EACCES', 'EPERM'])) counts.unreadable += 1;
      else if (!hasErrnoCode(error, ABSENT)) throw error;
      return [];
    }
    // Fallback only: a directory swapped for a link while it was read shows another folder's names.
    if (!procFd && (await realpath(dir.real).catch(() => null)) !== dir.real) {
      counts.links += 1;
      return [];
    }
    const found: Array<{ readonly kind: 'file' | 'dir'; readonly name: string }> = [];
    for (const entry of dirents) {
      if (entry.isDirectory()) found.push({ kind: 'dir', name: entry.name });
      else if (entry.isFile()) found.push({ kind: 'file', name: entry.name });
      else if (entry.isSymbolicLink()) counts.links += 1;
    }
    return found;
  }

  /** The listing entry of the plain file `name` in `dir`, or `null` (counted unless it is gone). */
  async function fileEntry(
    dir: Opened,
    name: string,
    key: string,
    counts: Counts,
  ): Promise<ObjectListEntry | null> {
    const at = childOf(dir, name);
    try {
      const stats = await lstat(at);
      if (!stats.isFile()) return null;
      // Readable is decided by opening it as a read would, never by a call that follows a link.
      await (await open(at, READ_FLAGS)).close();
      return {
        kind: 'file',
        key,
        sizeBytes: stats.size,
        contentType: inferContentType(key),
        lastModified: stats.mtime,
      };
    } catch (error) {
      if (!hasErrnoCode(error, ['ENOENT', 'ENOTDIR'])) counts.unreadable += 1;
      return null;
    }
  }

  /** The subfolder `name` of `dir`, opened through `dir`; `null` (counted) when it cannot be. */
  async function subfolder(dir: Opened, name: string, counts: Counts): Promise<Opened | null> {
    try {
      const opened = await openVerified(childOf(dir, name), DIRECTORY_FLAGS);
      if (opened === null) counts.links += 1;
      return opened;
    } catch (error) {
      if (hasErrnoCode(error, ['EACCES', 'EPERM'])) counts.unreadable += 1;
      else if (!hasErrnoCode(error, ABSENT)) throw error;
      return null;
    }
  }

  /** Every listable file under `dir`, however deep, in key order from the first past `after`. */
  async function* filesUnder(
    dir: Opened,
    keyPrefix: string,
    counts: Counts,
    after: string | undefined,
  ): AsyncGenerator<ObjectListEntry> {
    const found = await children(dir, counts);
    for (const child of inWalkOrder(found, (entry) => entry.kind === 'dir')) {
      const key = keyPrefix === '' ? child.name : `${keyPrefix}/${child.name}`;
      if (addressableObjectName(key) === null) continue;
      if (child.kind === 'file') {
        if (after !== undefined && key < after) continue;
        const entry = await fileEntry(dir, child.name, key, counts);
        if (entry !== null) yield entry;
        continue;
      }
      if (walkedBefore(key, after)) continue;
      const sub = await subfolder(dir, child.name, counts);
      if (sub === null) continue;
      try {
        yield* filesUnder(sub, key, counts, after);
      } finally {
        await sub.handle.close();
      }
    }
  }

  /** Whether `dir` holds any listable file, however deep. */
  async function holdsAFile(dir: Opened, keyPrefix: string): Promise<boolean> {
    const files = filesUnder(dir, keyPrefix, { links: 0, unreadable: 0 }, undefined);
    const first = await files.next();
    await files.return(undefined);
    return first.done !== true;
  }

  function report(counts: Counts): void {
    if (counts.links > 0 || counts.unreadable > 0) options.onSkipped?.({ ...counts });
  }

  /** The folder `segments` names, created if needed; never a link, never outside the root. */
  async function folderFor(segments: readonly string[]): Promise<Opened> {
    const candidate = path.join(root, ...segments);
    try {
      const opened = await openVerified(candidate, DIRECTORY_FLAGS);
      if (opened === null) throw new FolderPathError();
      return opened;
    } catch (error) {
      // `O_NOFOLLOW | O_DIRECTORY` on a link fails `ELOOP` or `ENOTDIR`; a plain file stays `ENOTDIR`.
      if (
        hasErrnoCode(error, ['ELOOP']) ||
        (hasErrnoCode(error, ['ENOTDIR']) &&
          (await lstat(candidate).catch(() => null))?.isSymbolicLink() === true)
      ) {
        throw new FolderPathError();
      }
      if (!hasErrnoCode(error, ['ENOENT']) || segments.length === 0) throw error;
    }
    const parent = await folderFor(segments.slice(0, -1));
    try {
      const at = childOf(parent, segments[segments.length - 1] ?? '');
      await unless(mkdir(at), ['EEXIST']);
      const opened = await openVerified(at, DIRECTORY_FLAGS);
      if (opened === null) throw new FolderPathError();
      return opened;
    } finally {
      await parent.handle.close();
    }
  }

  /** The staged file is still the one named `at` in its verified folder, and inside the root. */
  async function isStaged(handle: FileHandle, at: string): Promise<boolean> {
    const [held, named] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(at, { bigint: true }).catch(() => null),
    ]);
    return (
      named?.ino === held.ino && named.dev === held.dev && (await located(handle, at)) !== null
    );
  }

  /**
   * `source` written to a new temp file in `dir`. `staged.name` is set as soon as the file exists,
   * so the caller removes it whatever happens. `keepMode` is the mode of the file it replaces.
   */
  async function stage(
    dir: Opened,
    source: Readable,
    keepMode: number | null,
    staged: { name?: string },
  ): Promise<void> {
    const name = `${TEMP_PREFIX}${randomUUID()}`;
    const at = childOf(dir, name);
    const handle = await open(at, STAGE_FLAGS, keepMode ?? NEW_FILE_MODE);
    staged.name = name;
    let verified = false;
    try {
      await options.afterStage?.();
      // The umask applies to `open`; an overwrite keeps exactly the replaced file's mode.
      if (keepMode !== null) await handle.chmod(keepMode);
      verified = await isStaged(handle, at);
    } finally {
      if (!verified) await handle.close();
    }
    if (!verified) throw new FolderPathError();
    try {
      // Chunk by chunk, as the stream arrives; the handle stays open for the flush below.
      await handle.writeFile(source);
      // The bytes reach the disk before a rename or link can name them.
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function commit(
    key: string,
    source: Readable,
    ifMatch: string | undefined,
    ifNoneMatch: boolean,
  ): Promise<ObjectMeta> {
    const segments = segmentsOf(key);
    const name = segments[segments.length - 1] ?? '';
    const dir = await folderFor(segments.slice(0, -1));
    const staged: { name?: string } = {};
    try {
      await options.beforeStage?.();
      const target = childOf(dir, name);
      const existing = await unless(lstat(target), ['ENOENT']);
      await stage(dir, source, existing?.isFile() === true ? existing.mode & 0o777 : null, staged);
      const temp = childOf(dir, staged.name ?? '');
      return await withKeyLock(path.join(dir.real, name), async () => {
        await options.beforeCommit?.();
        if (ifNoneMatch) {
          try {
            await assertStillInside(dir);
            await link(temp, target);
          } catch (error) {
            if (hasErrnoCode(error, ['EEXIST'])) throw new ObjectConflictError();
            throw error;
          }
        } else {
          // ponytail: ifMatch is checked and renamed within one process only; write-back needs more
          if (ifMatch !== undefined && (await backend.head(key))?.etag !== ifMatch) {
            throw new ObjectConflictError();
          }
          await assertStillInside(dir);
          await rename(temp, target);
        }
        // The folder entry that names the new file is durable before the write is reported.
        await dir.handle.sync();
        return metaOf(key, await lstat(target, { bigint: true }));
      });
    } finally {
      if (staged.name !== undefined) await unless(unlink(childOf(dir, staged.name)), ['ENOENT']);
      await dir.handle.close();
    }
  }

  const listing = {
    async *level(prefix, after): AsyncGenerator<ObjectListEntry> {
      const safe = toObjectPrefix(prefix);
      const dir = await openFolder(safe === '' ? [] : safe.split('/'));
      if (dir === null) return;
      const counts = { links: 0, unreadable: 0 };
      let failed = false;
      try {
        for (const child of inWalkOrder(await children(dir, counts), () => false)) {
          const key = safe === '' ? child.name : `${safe}/${child.name}`;
          if (addressableObjectName(key) === null) continue;
          if (after !== undefined && key < after) continue;
          if (child.kind === 'file') {
            const entry = await fileEntry(dir, child.name, key, counts);
            if (entry !== null) yield entry;
            continue;
          }
          const sub = await subfolder(dir, child.name, counts);
          if (sub === null) continue;
          try {
            if (await holdsAFile(sub, key)) yield { kind: 'folder', key };
          } finally {
            await sub.handle.close();
          }
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await dir.handle.close();
        if (!failed) report(counts);
      }
    },

    async *tree(prefix, after): AsyncGenerator<ObjectListEntry> {
      const safe = toObjectPrefix(prefix);
      const counts = { links: 0, unreadable: 0 };
      if (safe !== '') {
        const self = await openObject(safe);
        if (self !== null) {
          await self.handle.close();
          const meta = metaOf(safe, self.stats);
          yield {
            kind: 'file',
            key: safe,
            sizeBytes: meta.sizeBytes,
            contentType: meta.contentType,
            lastModified: meta.lastModified,
          };
        }
      }
      const dir = await openFolder(safe === '' ? [] : safe.split('/'));
      if (dir === null) return;
      let failed = false;
      try {
        yield* filesUnder(dir, safe, counts, after);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await dir.handle.close();
        if (!failed) report(counts);
      }
    },
  } satisfies Parameters<typeof listPageFrom>[0];

  const backend: ObjectStore = {
    capabilities: {
      sign: false,
      boundLengthSign: false,
      range: true,
      conditionalPut: true,
      fileAndFolderShareKey: false,
    },

    head: (key) =>
      guarded(key, async () => {
        const opened = await openObject(key);
        if (opened === null) return null;
        await opened.handle.close();
        return metaOf(key, opened.stats);
      }),

    read: (key, readOptions) =>
      guarded(key, async () => {
        const opened = await openObject(key);
        if (opened === null) return null;
        try {
          const meta = metaOf(key, opened.stats);
          const range = resolveRange(readOptions?.range, meta.sizeBytes);
          const source = opened.handle.createReadStream(
            range === null ? {} : { start: range.start, end: range.end },
          );
          const body = toWebStream(source);
          unreadBodies.register(body, opened.handle);
          return { meta, range, body };
        } catch (error) {
          await opened.handle.close();
          throw error;
        }
      }),

    async write(key, body, writeOptions): Promise<ObjectMeta> {
      await validatedWriteKey(body, writeOptions, () => toObjectKey(key));
      const source = toNodeReadable(body);
      try {
        return await guarded(key, () =>
          commit(key, source, writeOptions.ifMatch, writeOptions.ifNoneMatch === '*'),
        );
      } finally {
        source.destroy();
      }
    },

    delete: (key) =>
      guarded(key, async () => {
        const segments = segmentsOf(key);
        const dir = await openFolder(segments.slice(0, -1));
        if (dir === null) return;
        try {
          await options.beforeDelete?.();
          const at = childOf(dir, segments[segments.length - 1] ?? '');
          // A folder is not an object; do not remove it.
          if ((await unless(lstat(at), ['ENOENT']))?.isDirectory() !== false) return;
          await assertStillInside(dir);
          await unless(unlink(at), ['ENOENT']);
        } finally {
          await dir.handle.close();
        }
      }),

    // Streamed through this store's own read and write, never `fs.copyFile` on a path: the
    // containment guards in the header above hold for both ends of the copy.
    async copy(sourceKey, destinationKey) {
      const source = await backend.read(sourceKey);
      if (source !== null) await backend.write(destinationKey, source.body, {});
    },

    // ponytail: a page walks from its cursor and stops once full; one huge folder is read whole
    listPage: (prefix, pageOptions) =>
      guarded(prefix, () => listPageFrom(listing, prefix, pageOptions)),
  };
  return backend;
}
