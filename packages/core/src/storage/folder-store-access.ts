import { type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { inferContentType } from './content-type.js';
import { type ObjectMeta } from './object-store.js';

import {
  ABSENT,
  DIRECTORY_FLAGS,
  FolderPathError,
  HAS_PROC_FD,
  hasErrnoCode,
  isInside,
  LINKED_DIRECTORY_FLAGS,
  PROC_FD,
  READ_FLAGS,
  unless,
  type FolderStoreOptions,
  type Opened,
} from './folder-store-state.js';

export function createFolderAccess(
  root: string,
  options: FolderStoreOptions,
  segmentsOf: (key: string) => string[],
) {
  const procFd = options.procFd ?? HAS_PROC_FD;
  // A directory link that stays inside the root is followed only where containment is decided by
  // what was opened; the path-check fallback cannot tell a link it should follow from a swap.
  const folderFlags = procFd ? LINKED_DIRECTORY_FLAGS : DIRECTORY_FLAGS;

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
    return unless(openVerified(path.join(root, ...segments), folderFlags), ABSENT);
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

  /**
   * The folder `segments` names, created if needed; never outside the root, and never a link except
   * one to a folder inside the root where containment is checked on what was opened.
   */
  async function folderFor(segments: readonly string[]): Promise<Opened> {
    const candidate = path.join(root, ...segments);
    try {
      const opened = await openVerified(candidate, folderFlags);
      if (opened === null) throw new FolderPathError();
      return opened;
    } catch (error) {
      // `O_NOFOLLOW | O_DIRECTORY` on a link fails `ELOOP` or `ENOTDIR`; a plain file stays
      // `ENOTDIR`. Followed, a link to a file fails `ENOTDIR` and a dangling one `ENOENT`.
      if (
        hasErrnoCode(error, ['ELOOP']) ||
        (hasErrnoCode(error, ['ENOTDIR', 'ENOENT']) &&
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

  return {
    procFd,
    folderFlags,
    pathOf,
    childOf,
    located,
    openVerified,
    assertStillInside,
    openFolder,
    metaOf,
    openObject,
    folderFor,
  };
}
