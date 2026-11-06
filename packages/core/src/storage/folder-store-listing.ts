import { type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';

import { inferContentType } from './content-type.js';
import { type ObjectListEntry } from './object-store.js';
import { inWalkOrder, listedEntries, walkedBefore } from './streams.js';

import type { createFolderAccess } from './folder-store-access.js';
import type { createFolderKeys } from './folder-store-keys.js';
import {
  ABSENT,
  FOLDER_WALK_MAX_ENTRIES,
  FolderWalkLimitError,
  hasErrnoCode,
  isInside,
  READ_FLAGS,
  type FolderStoreOptions,
  type Opened,
  type Walk,
} from './folder-store-state.js';

export function createFolderListing(
  access: ReturnType<typeof createFolderAccess>,
  keys: ReturnType<typeof createFolderKeys>,
  options: FolderStoreOptions,
) {
  const { procFd, folderFlags, pathOf, childOf, openVerified, openFolder, openObject, metaOf } =
    access;
  const { prefixOf, isListable } = keys;
  const walkMaxEntries = options.walkMaxEntries ?? FOLDER_WALK_MAX_ENTRIES;
  const newWalk = (): Walk => ({ links: 0, unreadable: 0, examined: { count: 0 } });
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
    traversal: { readonly after: string | undefined; readonly walked: readonly string[] },
  ): AsyncGenerator<ObjectListEntry> {
    const { after, walked } = traversal;
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
        yield* filesUnder(sub, key, counts, { after, walked: [...walked, sub.real] });
      } finally {
        await sub.handle.close();
      }
    }
  }

  /** Whether `dir` holds any listable file, however deep. Its entries count against `walk`'s cap. */
  async function holdsAFile(dir: Opened, keyPrefix: string, walk: Walk): Promise<boolean> {
    const probe = { links: 0, unreadable: 0, examined: walk.examined };
    const files = filesUnder(dir, keyPrefix, probe, { after: undefined, walked: [dir.real] });
    const first = await files.next();
    await files.return(undefined);
    return first.done !== true;
  }

  function report(counts: Walk): void {
    if (counts.links > 0 || counts.unreadable > 0)
      options.onSkipped?.({ links: counts.links, unreadable: counts.unreadable });
  }

  async function* levelEntry(
    dir: Opened,
    child: { readonly kind: 'file' | 'dir'; readonly name: string },
    key: string,
    counts: Walk,
  ): AsyncGenerator<ObjectListEntry> {
    if (child.kind === 'file') {
      const entry = await fileEntry(dir, child.name, key, counts);
      if (entry !== null) yield entry;
      return;
    }
    const sub = await subfolder(dir, child.name, counts, [dir.real]);
    if (sub === null) return;
    try {
      if (await holdsAFile(sub, key, counts)) yield { kind: 'folder', key };
    } finally {
      await sub.handle.close();
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
          yield* levelEntry(dir, child, key, counts);
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
        yield* filesUnder(dir, safe, counts, { after, walked: [dir.real] });
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await dir.handle.close();
        if (!failed) report(counts);
      }
    },
  } satisfies Parameters<typeof listedEntries>[0];

  return listing;
}
