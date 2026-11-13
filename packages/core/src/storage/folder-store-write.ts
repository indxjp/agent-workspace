import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { withKeyLock } from './key-lock.js';
import { ObjectConflictError, type ObjectMeta } from './object-store.js';

import type { createFolderAccess } from './folder-store-access.js';
import {
  FolderPathError,
  hasErrnoCode,
  LOCK_PREFIX,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  NEW_FILE_MODE,
  onWindows,
  STAGE_FLAGS,
  TEMP_PREFIX,
  unless,
  type FolderStoreOptions,
  type Opened,
} from './folder-store-state.js';

export function createFolderWriter(
  access: ReturnType<typeof createFolderAccess>,
  segmentsOf: (key: string) => string[],
  options: FolderStoreOptions,
) {
  const { childOf, located, assertStillInside, folderFor, metaOf } = access;
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
    conditions: {
      readonly ifMatch: string | undefined;
      readonly ifNoneMatch: boolean;
      readonly signal: AbortSignal | undefined;
    },
  ): Promise<ObjectMeta> {
    const { ifMatch, ifNoneMatch, signal } = conditions;
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

  return { commit, withFolderLock };
}
