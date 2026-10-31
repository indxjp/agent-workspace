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
 * link never leaks; a listing reports only a count of what it left out. A file symlink is never read,
 * listed or written through. On Linux a directory symlink is followed, by reads, writes, deletes and
 * listings alike, when what it opens lies inside the root; a listing counts, and does not enter, one
 * that leads back to a folder it is inside or has walked through. The fallback below follows none.
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
 * - a write's precondition and its rename or link, and a delete, hold a lock file in the folder
 *   (`.%aw-lock-<hash of the name>`, created `O_EXCL`), so writers in other processes on the same
 *   filesystem wait for each other; a lock older than {@link LOCK_STALE_MS} was left by a process
 *   that died and is broken, and two processes breaking the same stale lock at once may both
 *   proceed. A filesystem without `O_EXCL` (some network mounts) does not hold the lock;
 * - a read re-resolves its key, so a key may name a different inside file between two calls.
 */
import { createHash, randomUUID } from 'node:crypto';
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
import { setTimeout as delay } from 'node:timers/promises';

import { inferContentType } from './content-type.js';
import {
  addressableObjectName,
  toObjectKey,
  toObjectPrefix,
  UnsafeObjectKeyError,
} from './key-safety.js';
import { withKeyLock } from './key-lock.js';
import {
  clampListLimit,
  ObjectConflictError,
  validatedWriteKey,
  type ListPageOptions,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectPage,
  type ObjectStore,
} from './object-store.js';
import {
  abortableBody,
  cursorAfter,
  inWalkOrder,
  listedEntries,
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

/**
 * How many directory entries one listing may examine, over all of its pages: twice the most files a
 * run takes (`RUN_FILES_MAX_MEMBERS`), so a delivery never fails on the cap before its own limit,
 * while a folder of millions of names, or a tree of empty folders, is not read to the end.
 */
export const FOLDER_WALK_MAX_ENTRIES = 200_000;

/** A listing examined more than its cap of directory entries. Names no key or path. */
export class FolderWalkLimitError extends Error {
  public constructor(public readonly limit: number) {
    super(`The folder listing examined more than ${String(limit)} entries.`);
    this.name = 'FolderWalkLimitError';
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
  /** Called once per listing, when it ends, if it left anything out. */
  readonly onSkipped?: (counts: FolderSkipCounts) => void;
  /** Test seam: the walk cap. Defaults to {@link FOLDER_WALK_MAX_ENTRIES}. */
  readonly walkMaxEntries?: number;
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
   * Refuse the names Win32 reads as another name or as a device (see `windowsNameProblem`).
   * Defaults to whether this is Windows; tests pass `true` to exercise it anywhere.
   */
  readonly windowsNames?: boolean;
  /**
   * Internal: resolve through `/proc/self/fd`. Defaults to whether it exists; tests pass `false` to
   * exercise the path-check fallback. Not part of the connection options.
   */
  readonly procFd?: boolean;
}

/** A device name: Win32 opens the device for it, with or without an extension (`nul.txt`). */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;
/** `:` names an NTFS alternate data stream; the rest are wildcards or refused by Win32 itself. */
const WINDOWS_RESERVED_CHARACTER = /[:<>"|?*]/u;

/**
 * Why Win32 would read the path segment `name` as something other than the file of that name, or
 * `null`. NTFS mints these aliases below any string guard (`key-safety.ts`, "What this cannot
 * decide"): `a.txt:s` and `a.txt::$DATA` are streams of `a.txt`, a trailing dot or space is
 * stripped, and `nul` or `con.txt` is a device. Case folding and 8.3 short names alias one file
 * inside the folder to another; they cannot reach outside it, and are not refused.
 */
function windowsNameProblem(name: string): string | null {
  if (WINDOWS_RESERVED_CHARACTER.test(name)) return 'a stream separator or a reserved character';
  if (name.endsWith('.') || name.endsWith(' ')) return 'a trailing dot or space, which is stripped';
  if (WINDOWS_DEVICE.test(name.trimEnd())) return 'a device name';
  return null;
}

/** `target` is `root` or lies under it; both are real paths. */
export function isInside(root: string, target: string): boolean {
  return (
    target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
  );
}

/** A write temp name. The key guard refuses a bare `%`, so a half-written file is never listed. */
const TEMP_PREFIX = '.%aw-write-';
/** A commit's lock file. The key guard refuses a bare `%`, so it is never listed either. */
const LOCK_PREFIX = '.%aw-lock-';
/**
 * A lock is held for a precondition check, a rename or link and a folder flush, never for a body;
 * one older than this was left by a process that died holding it, and is broken.
 */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 5;
/** A new file's mode, less the process umask. An overwrite keeps the replaced file's mode. */
const NEW_FILE_MODE = 0o644;

const onWindows = process.platform === 'win32';
const PROC_FD = '/proc/self/fd';
const HAS_PROC_FD = existsSync(PROC_FD);

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** A folder that may be a link: only where what was opened is checked (`/proc/self/fd`). */
const LINKED_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY;
const STAGE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * A listing that filled its page waits this long for the next page's cursor (a run's delivery asks
 * for it at once), and at most this many wait in the process, each holding its open folders; an
 * older or idle one is closed, and its cursor then starts a new walk from there.
 */
const PAUSED_WALKS_MAX = 16;
const PAUSED_WALK_IDLE_MS = 5_000;

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

/** One listing's skip counts, and the entries it has examined so far against the cap. */
interface Walk {
  links: number;
  unreadable: number;
  readonly examined: { count: number };
}

/** A listing stopped at the end of a page, and the entry that will open the next one. */
interface PausedWalk {
  readonly entries: AsyncGenerator<ObjectListEntry>;
  readonly next: ObjectListEntry;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Every store's paused listings, by store, listing and cursor: one table, so the folders they hold
 * open are bounded for the process however many stores are opened (a browse opens one a request).
 */
const paused = new Map<string, PausedWalk>();

export function createFolderObjectStore(
  root: string,
  options: FolderStoreOptions = {},
): ObjectStore {
  const windowsNames = options.windowsNames ?? onWindows;

  /** `key`'s segments, when Windows would read each as itself; otherwise a key-guard refusal. */
  function windowsSafe(key: string, segments: string[]): string[] {
    if (!windowsNames) return segments;
    for (const segment of segments) {
      const problem = windowsNameProblem(segment);
      if (problem !== null) {
        throw new UnsafeObjectKeyError(
          'windows-name',
          key,
          `contains the segment ${JSON.stringify(segment)}: ${problem} on Windows`,
        );
      }
    }
    return segments;
  }
  const segmentsOf = (key: string): string[] => windowsSafe(key, toObjectKey(key).split('/'));
  /** A listing prefix, checked like a key; `''` is the root. */
  const prefixOf = (prefix: string): string => {
    const safe = toObjectPrefix(prefix);
    if (safe !== '') windowsSafe(prefix, safe.split('/'));
    return safe;
  };
  /** Whether a name found on disk may be listed: a key the guards accept. */
  const isListable = (key: string): boolean =>
    addressableObjectName(key) !== null &&
    (!windowsNames || key.split('/').every((segment) => windowsNameProblem(segment) === null));
  const procFd = options.procFd ?? HAS_PROC_FD;
  const walkMaxEntries = options.walkMaxEntries ?? FOLDER_WALK_MAX_ENTRIES;
  // A directory link that stays inside the root is followed only where containment is decided by
  // what was opened; the path-check fallback cannot tell a link it should follow from a swap.
  const folderFlags = procFd ? LINKED_DIRECTORY_FLAGS : DIRECTORY_FLAGS;
  const newWalk = (): Walk => ({ links: 0, unreadable: 0, examined: { count: 0 } });

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

  async function children(
    dir: Opened,
    counts: Walk,
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
    counts.examined.count += dirents.length;
    if (counts.examined.count > walkMaxEntries) throw new FolderWalkLimitError(walkMaxEntries);
    // Fallback only: a directory swapped for a link while it was read shows another folder's names.
    if (!procFd && (await realpath(dir.real).catch(() => null)) !== dir.real) {
      counts.links += 1;
      return [];
    }
    const found: Array<{ readonly kind: 'file' | 'dir'; readonly name: string }> = [];
    for (const entry of dirents) {
      if (entry.isDirectory()) found.push({ kind: 'dir', name: entry.name });
      else if (entry.isFile()) found.push({ kind: 'file', name: entry.name });
      else if (entry.isSymbolicLink()) {
        // Sorted as a folder when it names one; `subfolder` then decides whether it may be entered.
        if (procFd && (await namesAFolder(dir, entry.name))) {
          found.push({ kind: 'dir', name: entry.name });
        } else counts.links += 1;
      }
    }
    return found;
  }

  /** Whether the link `name` in `dir` resolves to a folder, wherever that is. */
  async function namesAFolder(dir: Opened, name: string): Promise<boolean> {
    return (await stat(childOf(dir, name)).catch(() => null))?.isDirectory() === true;
  }

  /** The listing entry of the plain file `name` in `dir`, or `null` (counted unless it is gone). */
  async function fileEntry(
    dir: Opened,
    name: string,
    key: string,
    counts: Walk,
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

  /**
   * The subfolder `name` of `dir`, opened through `dir`; `null` (counted) when it cannot be. A link
   * back to `dir`, to a folder `dir` is inside, or to a folder on the walk's way down (`walked`, real
   * paths) would be walked again without end: it is counted as a link and not entered.
   */
  async function subfolder(
    dir: Opened,
    name: string,
    counts: Walk,
    walked: readonly string[],
  ): Promise<Opened | null> {
    try {
      const opened = await openVerified(childOf(dir, name), folderFlags);
      if (opened !== null && (isInside(opened.real, dir.real) || walked.includes(opened.real))) {
        await opened.handle.close();
        counts.links += 1;
        return null;
      }
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
    counts: Walk,
    after: string | undefined,
    walked: readonly string[],
  ): AsyncGenerator<ObjectListEntry> {
    const found = await children(dir, counts);
    for (const child of inWalkOrder(found, (entry) => entry.kind === 'dir')) {
      const key = keyPrefix === '' ? child.name : `${keyPrefix}/${child.name}`;
      if (!isListable(key)) continue;
      if (child.kind === 'file') {
        if (after !== undefined && key < after) continue;
        const entry = await fileEntry(dir, child.name, key, counts);
        if (entry !== null) yield entry;
        continue;
      }
      if (walkedBefore(key, after)) continue;
      const sub = await subfolder(dir, child.name, counts, walked);
      if (sub === null) continue;
      try {
        yield* filesUnder(sub, key, counts, after, [...walked, sub.real]);
      } finally {
        await sub.handle.close();
      }
    }
  }

  /** Whether `dir` holds any listable file, however deep. Its entries count against `walk`'s cap. */
  async function holdsAFile(dir: Opened, keyPrefix: string, walk: Walk): Promise<boolean> {
    const probe = { links: 0, unreadable: 0, examined: walk.examined };
    const files = filesUnder(dir, keyPrefix, probe, undefined, [dir.real]);
    const first = await files.next();
    await files.return(undefined);
    return first.done !== true;
  }

  function report(counts: Walk): void {
    if (counts.links > 0 || counts.unreadable > 0)
      options.onSkipped?.({ links: counts.links, unreadable: counts.unreadable });
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

  /**
   * `work` while this process holds the lock file of `name` in the open `dir`. Another process
   * holding it is waited for; a lock that went stale is broken. Same-process callers are already
   * serialised by `withKeyLock`, so the wait is only ever for another process.
   */
  async function withFolderLock<T>(
    dir: Opened,
    name: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 32);
    const at = childOf(dir, `${LOCK_PREFIX}${hash}`);
    for (;;) {
      signal?.throwIfAborted();
      try {
        await (await open(at, STAGE_FLAGS, 0o600)).close();
        break;
      } catch (error) {
        if (!hasErrnoCode(error, ['EEXIST'])) throw error;
      }
      const held = await unless(lstat(at), ['ENOENT']);
      if (held !== null && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await unless(unlink(at), ['ENOENT']);
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
    try {
      return await work();
    } finally {
      await unless(unlink(at), ['ENOENT']);
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

  /**
   * The etag of the file `at` names in an opened folder (`childOf`), so a precondition is checked
   * against the file the rename will replace, not whatever the key resolves to from the root now.
   */
  async function currentEtag(key: string, at: string): Promise<string | null> {
    const stats = await unless(lstat(at, { bigint: true }), ['ENOENT']);
    return stats?.isFile() === true ? metaOf(key, stats).etag : null;
  }

  async function commit(
    key: string,
    source: Readable,
    ifMatch: string | undefined,
    ifNoneMatch: boolean,
    signal: AbortSignal | undefined,
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
      const commitLocked = async (): Promise<ObjectMeta> => {
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
          if (ifMatch !== undefined && (await currentEtag(key, target)) !== ifMatch) {
            throw new ObjectConflictError();
          }
          await assertStillInside(dir);
          await rename(temp, target);
        }
        // The folder entry that names the new file is durable before the write is reported.
        // Windows cannot flush a folder (`FlushFileBuffers` needs a handle opened for writing, which
        // a folder cannot have); NTFS journals the rename itself.
        if (!onWindows) await dir.handle.sync();
        return metaOf(key, await lstat(target, { bigint: true }));
      };
      return await withKeyLock(path.join(dir.real, name), () =>
        withFolderLock(dir, name, commitLocked, signal),
      );
    } finally {
      if (staged.name !== undefined) await unless(unlink(childOf(dir, staged.name)), ['ENOENT']);
      await dir.handle.close();
    }
  }

  const listing = {
    async *level(prefix, after): AsyncGenerator<ObjectListEntry> {
      const safe = prefixOf(prefix);
      const dir = await openFolder(safe === '' ? [] : safe.split('/'));
      if (dir === null) return;
      const counts = newWalk();
      let failed = false;
      try {
        for (const child of inWalkOrder(await children(dir, counts), () => false)) {
          const key = safe === '' ? child.name : `${safe}/${child.name}`;
          if (!isListable(key)) continue;
          if (after !== undefined && key < after) continue;
          if (child.kind === 'file') {
            const entry = await fileEntry(dir, child.name, key, counts);
            if (entry !== null) yield entry;
            continue;
          }
          const sub = await subfolder(dir, child.name, counts, [dir.real]);
          if (sub === null) continue;
          try {
            if (await holdsAFile(sub, key, counts)) yield { kind: 'folder', key };
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
      const safe = prefixOf(prefix);
      const counts = newWalk();
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
        yield* filesUnder(dir, safe, counts, after, [dir.real]);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await dir.handle.close();
        if (!failed) report(counts);
      }
    },
  } satisfies Parameters<typeof listedEntries>[0];

  /** This store's key in the paused table: a cursor resumes only a walk this store paused. */
  const storeId = randomUUID();
  const pausedId = (prefix: string, recursive: boolean, cursor: string): string =>
    JSON.stringify([storeId, recursive, prefix, cursor]);

  /** Ends a paused listing: its open folders are closed, and its skips reported. */
  function closePaused(walk: PausedWalk): void {
    clearTimeout(walk.timer);
    walk.entries.return(undefined).catch((error: unknown) => {
      process.emitWarning('A paused folder listing could not close its folders.', {
        code: 'AW_FOLDER_STORE_CLOSE',
        detail: error instanceof Error ? error.name : 'unknown',
      });
    });
  }

  function pause(id: string, entries: AsyncGenerator<ObjectListEntry>, next: ObjectListEntry) {
    const held = paused.get(id);
    if (held !== undefined) closePaused(held);
    paused.delete(id);
    const [oldest] = paused;
    if (paused.size >= PAUSED_WALKS_MAX && oldest !== undefined) {
      paused.delete(oldest[0]);
      closePaused(oldest[1]);
    }
    const walk: PausedWalk = {
      entries,
      next,
      timer: setTimeout(() => {
        if (paused.get(id) !== walk) return;
        paused.delete(id);
        closePaused(walk);
      }, PAUSED_WALK_IDLE_MS).unref(),
    };
    paused.set(id, walk);
  }

  /**
   * One page of a listing. A page that fills pauses its walk, open folders and all, and the page
   * that passes its cursor back carries on from there: one walk reads each folder once and reports
   * its skips once, however many pages it takes. A cursor with no paused walk (another store's, an
   * idle one's) starts a new walk that skips to it.
   */
  async function listFolderPage(
    prefix: string,
    pageOptions: ListPageOptions | undefined,
  ): Promise<ObjectPage> {
    pageOptions?.signal?.throwIfAborted();
    const limit = clampListLimit(pageOptions?.limit);
    const recursive = pageOptions?.recursive === true;
    const safe = prefixOf(prefix);
    const cursor = pageOptions?.cursor;
    const resumed =
      cursor === undefined ? undefined : paused.get(pausedId(safe, recursive, cursor));
    if (resumed !== undefined && cursor !== undefined) {
      paused.delete(pausedId(safe, recursive, cursor));
      clearTimeout(resumed.timer);
    }
    const entries = resumed?.entries ?? listedEntries(listing, prefix, pageOptions);
    const page: ObjectListEntry[] = [];
    let next = resumed?.next;
    for (;;) {
      if (next === undefined) {
        const pulled = await entries.next();
        if (pulled.done === true) return { entries: page, cursor: null };
        next = pulled.value;
      }
      const last = page[page.length - 1];
      if (page.length === limit && last !== undefined) {
        const after = cursorAfter(last);
        pause(pausedId(safe, recursive, after), entries, next);
        return { entries: page, cursor: after };
      }
      page.push(next);
      next = undefined;
    }
  }

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
        readOptions?.signal?.throwIfAborted();
        const opened = await openObject(key);
        if (opened === null) return null;
        try {
          const meta = metaOf(key, opened.stats);
          const range = resolveRange(readOptions?.range, meta.sizeBytes);
          const source = opened.handle.createReadStream(
            range === null ? {} : { start: range.start, end: range.end },
          );
          const body = abortableBody(toWebStream(source), readOptions?.signal);
          unreadBodies.register(body, opened.handle);
          return { meta, range, body };
        } catch (error) {
          await opened.handle.close();
          throw error;
        }
      }),

    async write(key, body, writeOptions): Promise<ObjectMeta> {
      await validatedWriteKey(body, writeOptions, () => segmentsOf(key).join('/'));
      const source = toNodeReadable(abortableBody(body, writeOptions.signal));
      try {
        return await guarded(key, () =>
          commit(
            key,
            source,
            writeOptions.ifMatch,
            writeOptions.ifNoneMatch === '*',
            writeOptions.signal,
          ),
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
          const name = segments[segments.length - 1] ?? '';
          const at = childOf(dir, name);
          // A folder is not an object; do not remove it.
          if ((await unless(lstat(at), ['ENOENT']))?.isDirectory() !== false) return;
          await withFolderLock(dir, name, async () => {
            await assertStillInside(dir);
            await unless(unlink(at), ['ENOENT']);
          });
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

    listPage: (prefix, pageOptions) => guarded(prefix, () => listFolderPage(prefix, pageOptions)),
  };
  return backend;
}
