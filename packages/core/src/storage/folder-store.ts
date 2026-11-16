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
import { lstat, unlink } from 'node:fs/promises';

import { createFolderAccess } from './folder-store-access.js';
import { createFolderKeys } from './folder-store-keys.js';
import { createFolderListing } from './folder-store-listing.js';
import { createFolderPager } from './folder-store-pagination.js';
import { guarded, unless, unreadBodies, type FolderStoreOptions } from './folder-store-state.js';
import { createFolderWriter } from './folder-store-write.js';
import { validatedWriteKey, type ObjectMeta, type ObjectStore } from './object-store.js';
import { abortableBody, resolveRange, toNodeReadable, toWebStream } from './streams.js';

export {
  FOLDER_WALK_MAX_ENTRIES,
  FolderPathError,
  FolderStoreError,
  FolderWalkLimitError,
  isInside,
} from './folder-store-state.js';
export type { FolderSkipCounts, FolderStoreOptions } from './folder-store-state.js';

export function createFolderObjectStore(
  root: string,
  options: FolderStoreOptions = {},
): ObjectStore {
  const keys = createFolderKeys(options);
  const { segmentsOf, prefixOf } = keys;
  const access = createFolderAccess(root, options, segmentsOf);
  const { openObject, metaOf, openFolder, childOf, assertStillInside } = access;
  const { commit, withFolderLock } = createFolderWriter(access, segmentsOf, options);
  const listing = createFolderListing(access, keys, options);
  const listFolderPage = createFolderPager(listing, prefixOf);
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
          commit(key, source, {
            ifMatch: writeOptions.ifMatch,
            ifNoneMatch: writeOptions.ifNoneMatch === '*',
            signal: writeOptions.signal,
          }),
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
