import { constants, existsSync } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { type ObjectListEntry } from './object-store.js';

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
export function windowsNameProblem(name: string): string | null {
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
export const TEMP_PREFIX = '.%aw-write-';
/** A commit's lock file. The key guard refuses a bare `%`, so it is never listed either. */
export const LOCK_PREFIX = '.%aw-lock-';
/**
 * A lock is held for a precondition check, a rename or link and a folder flush, never for a body;
 * one older than this was left by a process that died holding it, and is broken.
 */
export const LOCK_STALE_MS = 10_000;
export const LOCK_RETRY_MS = 5;
/** A new file's mode, less the process umask. An overwrite keeps the replaced file's mode. */
export const NEW_FILE_MODE = 0o644;

export const onWindows = process.platform === 'win32';
export const PROC_FD = '/proc/self/fd';
export const HAS_PROC_FD = existsSync(PROC_FD);

export const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** A folder that may be a link: only where what was opened is checked (`/proc/self/fd`). */
export const LINKED_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY;
export const STAGE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * A listing that filled its page waits this long for the next page's cursor (a run's delivery asks
 * for it at once), and at most this many wait in the process, each holding its open folders; an
 * older or idle one is closed, and its cursor then starts a new walk from there.
 */
export const PAUSED_WALKS_MAX = 16;
export const PAUSED_WALK_IDLE_MS = 5_000;

export const ABSENT = ['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR', 'ENAMETOOLONG', 'EACCES', 'EPERM'];

/**
 * A read body's stream closes its file when it is read to the end, fails or is cancelled. One that
 * is dropped unread would hold the file until the collector closed the handle itself, which Node
 * deprecates (DEP0137). This closes it once the body is unreachable; the registry holds the handle,
 * so the handle outlives its body.
 */
export const unreadBodies = new FinalizationRegistry<FileHandle>((handle) => {
  if (handle.fd === -1) return;
  handle.close().catch((error: unknown) => {
    process.emitWarning('A folder-store read body could not close its file.', {
      code: 'AW_FOLDER_STORE_CLOSE',
      detail: error instanceof Error ? error.name : 'unknown',
    });
  });
});

export function hasErrnoCode(error: unknown, codes: readonly string[]): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

/** `null` for an error in `codes`; any other error is rethrown. */
export async function unless<T>(work: Promise<T>, codes: readonly string[]): Promise<T | null> {
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

export async function guarded<T>(key: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw withoutHostPaths(key, error);
  }
}

/** An open file or directory, and where it really is. */
export interface Opened {
  readonly handle: FileHandle;
  readonly real: string;
}

/** One listing's skip counts, and the entries it has examined so far against the cap. */
export interface Walk {
  links: number;
  unreadable: number;
  readonly examined: { count: number };
}

/** A listing stopped at the end of a page, and the entry that will open the next one. */
export interface PausedWalk {
  readonly entries: AsyncGenerator<ObjectListEntry>;
  readonly next: ObjectListEntry;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Every store's paused listings, by store, listing and cursor: one table, so the folders they hold
 * open are bounded for the process however many stores are opened (a browse opens one a request).
 */
export const paused = new Map<string, PausedWalk>();
