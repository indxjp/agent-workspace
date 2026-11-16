import { type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';

import { inferContentType } from './content-type.js';
import { type ObjectListEntry } from './object-store.js';
import { childKey, inWalkOrder, listedEntries, walkedBefore } from './streams.js';

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

/** The values every listing step reads: the folder access, the key rules and the store options. */
interface FolderListingContext {
  readonly access: ReturnType<typeof createFolderAccess>;
  readonly keys: ReturnType<typeof createFolderKeys>;
  readonly options: FolderStoreOptions;
  readonly walkMaxEntries: number;
}

interface FolderChild {
  readonly kind: 'file' | 'dir';
  readonly name: string;
}

interface Traversal {
  readonly after: string | undefined;
  readonly walked: readonly string[];
}

const newWalk = (): Walk => ({ links: 0, unreadable: 0, examined: { count: 0 } });

/** The entries of `dir`, or `null` (counted unless it is gone) when it cannot be read. */
async function readChildren(
  ctx: FolderListingContext,
  dir: Opened,
  counts: Walk,
): Promise<Dirent[] | null> {
  try {
    await ctx.options.beforeReaddir?.();
    return await readdir(ctx.access.pathOf(dir), { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if (hasErrnoCode(error, ['EACCES', 'EPERM'])) counts.unreadable += 1;
    else if (!hasErrnoCode(error, ABSENT)) throw error;
    return null;
  }
}

/** What `entry` of `dir` is listed as, or `null` when it is skipped (a skipped link is counted). */
async function classifyChild(
  ctx: FolderListingContext,
  dir: Opened,
  entry: Dirent,
  counts: Walk,
): Promise<FolderChild | null> {
  if (entry.isDirectory()) return { kind: 'dir', name: entry.name };
  if (entry.isFile()) return { kind: 'file', name: entry.name };
  if (!entry.isSymbolicLink()) return null;
  // Sorted as a folder when it names one; `subfolder` then decides whether it may be entered.
  if (ctx.access.procFd && (await namesAFolder(ctx, dir, entry.name))) {
    return { kind: 'dir', name: entry.name };
  }
  counts.links += 1;
  return null;
}

async function children(
  ctx: FolderListingContext,
  dir: Opened,
  counts: Walk,
): Promise<FolderChild[]> {
  const dirents = await readChildren(ctx, dir, counts);
  if (dirents === null) return [];
  counts.examined.count += dirents.length;
  if (counts.examined.count > ctx.walkMaxEntries) {
    throw new FolderWalkLimitError(ctx.walkMaxEntries);
  }
  // Fallback only: a directory swapped for a link while it was read shows another folder's names.
  if (!ctx.access.procFd && (await realpath(dir.real).catch(() => null)) !== dir.real) {
    counts.links += 1;
    return [];
  }
  const found: FolderChild[] = [];
  for (const entry of dirents) {
    const child = await classifyChild(ctx, dir, entry, counts);
    if (child !== null) found.push(child);
  }
  return found;
}

/** Whether the link `name` in `dir` resolves to a folder, wherever that is. */
async function namesAFolder(
  ctx: FolderListingContext,
  dir: Opened,
  name: string,
): Promise<boolean> {
  return (await stat(ctx.access.childOf(dir, name)).catch(() => null))?.isDirectory() === true;
}

/** The listing entry of the plain file `name` in `dir`, or `null` (counted unless it is gone). */
async function fileEntry(
  ctx: FolderListingContext,
  dir: Opened,
  name: string,
  key: string,
  counts: Walk,
): Promise<ObjectListEntry | null> {
  const at = ctx.access.childOf(dir, name);
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
  ctx: FolderListingContext,
  dir: Opened,
  name: string,
  counts: Walk,
  walked: readonly string[],
): Promise<Opened | null> {
  const { openVerified, childOf, folderFlags } = ctx.access;
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

/** The plain file `name` of `dir` at `key`, unless it sorts before `after`. */
async function* fileUnder(
  ctx: FolderListingContext,
  dir: Opened,
  name: string,
  key: string,
  counts: Walk,
  after: string | undefined,
): AsyncGenerator<ObjectListEntry> {
  if (after !== undefined && key < after) return;
  const entry = await fileEntry(ctx, dir, name, key, counts);
  if (entry !== null) yield entry;
}

/** Every listable file under the subfolder `name` of `dir`, unless the walk is already past it. */
async function* folderUnder(
  ctx: FolderListingContext,
  dir: Opened,
  name: string,
  key: string,
  counts: Walk,
  traversal: Traversal,
): AsyncGenerator<ObjectListEntry> {
  const { after, walked } = traversal;
  if (walkedBefore(key, after)) return;
  const sub = await subfolder(ctx, dir, name, counts, walked);
  if (sub === null) return;
  try {
    yield* filesUnder(ctx, sub, key, counts, { after, walked: [...walked, sub.real] });
  } finally {
    await sub.handle.close();
  }
}

/** Every listable file under `dir`, however deep, in key order from the first past `after`. */
async function* filesUnder(
  ctx: FolderListingContext,
  dir: Opened,
  keyPrefix: string,
  counts: Walk,
  traversal: Traversal,
): AsyncGenerator<ObjectListEntry> {
  const found = await children(ctx, dir, counts);
  for (const child of inWalkOrder(found, (entry) => entry.kind === 'dir')) {
    const key = childKey(keyPrefix, child.name);
    if (!ctx.keys.isListable(key)) continue;
    if (child.kind === 'file') yield* fileUnder(ctx, dir, child.name, key, counts, traversal.after);
    else yield* folderUnder(ctx, dir, child.name, key, counts, traversal);
  }
}

/** Whether `dir` holds any listable file, however deep. Its entries count against `walk`'s cap. */
async function holdsAFile(
  ctx: FolderListingContext,
  dir: Opened,
  keyPrefix: string,
  walk: Walk,
): Promise<boolean> {
  const probe = { links: 0, unreadable: 0, examined: walk.examined };
  const files = filesUnder(ctx, dir, keyPrefix, probe, { after: undefined, walked: [dir.real] });
  const first = await files.next();
  await files.return(undefined);
  return first.done !== true;
}

function report(ctx: FolderListingContext, counts: Walk): void {
  if (counts.links > 0 || counts.unreadable > 0)
    ctx.options.onSkipped?.({ links: counts.links, unreadable: counts.unreadable });
}

async function* levelEntry(
  ctx: FolderListingContext,
  dir: Opened,
  child: FolderChild,
  key: string,
  counts: Walk,
): AsyncGenerator<ObjectListEntry> {
  if (child.kind === 'file') {
    yield* fileUnder(ctx, dir, child.name, key, counts, undefined);
    return;
  }
  const sub = await subfolder(ctx, dir, child.name, counts, [dir.real]);
  if (sub === null) return;
  try {
    if (await holdsAFile(ctx, sub, key, counts)) yield { kind: 'folder', key };
  } finally {
    await sub.handle.close();
  }
}

/** The direct children of `dir` (the folder at `safe`), in key order from the first past `after`. */
async function* levelEntries(
  ctx: FolderListingContext,
  dir: Opened,
  safe: string,
  after: string | undefined,
  counts: Walk,
): AsyncGenerator<ObjectListEntry> {
  for (const child of inWalkOrder(await children(ctx, dir, counts), () => false)) {
    const key = childKey(safe, child.name);
    if (!ctx.keys.isListable(key)) continue;
    if (after !== undefined && key < after) continue;
    yield* levelEntry(ctx, dir, child, key, counts);
  }
}

/**
 * Yields what `body` walks in the opened `dir`, then closes `dir` and reports the skipped entries,
 * but only when the walk did not fail.
 */
async function* walkFolder(
  ctx: FolderListingContext,
  dir: Opened,
  counts: Walk,
  body: () => AsyncGenerator<ObjectListEntry>,
): AsyncGenerator<ObjectListEntry> {
  let failed = false;
  try {
    yield* body();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await dir.handle.close();
    if (!failed) report(ctx, counts);
  }
}

/** The file stored at the prefix `safe` itself, which a tree lists before anything under it. */
async function selfEntry(ctx: FolderListingContext, safe: string): Promise<ObjectListEntry | null> {
  if (safe === '') return null;
  const self = await ctx.access.openObject(safe);
  if (self === null) return null;
  await self.handle.close();
  const meta = ctx.access.metaOf(safe, self.stats);
  return {
    kind: 'file',
    key: safe,
    sizeBytes: meta.sizeBytes,
    contentType: meta.contentType,
    lastModified: meta.lastModified,
  };
}

export function createFolderListing(
  access: ReturnType<typeof createFolderAccess>,
  keys: ReturnType<typeof createFolderKeys>,
  options: FolderStoreOptions,
) {
  const walkMaxEntries = options.walkMaxEntries ?? FOLDER_WALK_MAX_ENTRIES;
  const ctx: FolderListingContext = { access, keys, options, walkMaxEntries };

  const listing = {
    async *level(prefix, after): AsyncGenerator<ObjectListEntry> {
      const safe = keys.prefixOf(prefix);
      const dir = await access.openFolder(safe === '' ? [] : safe.split('/'));
      if (dir === null) return;
      const counts = newWalk();
      yield* walkFolder(ctx, dir, counts, () => levelEntries(ctx, dir, safe, after, counts));
    },

    async *tree(prefix, after): AsyncGenerator<ObjectListEntry> {
      const safe = keys.prefixOf(prefix);
      const counts = newWalk();
      const self = await selfEntry(ctx, safe);
      if (self !== null) yield self;
      const dir = await access.openFolder(safe === '' ? [] : safe.split('/'));
      if (dir === null) return;
      yield* walkFolder(ctx, dir, counts, () =>
        filesUnder(ctx, dir, safe, counts, { after, walked: [dir.real] }),
      );
    },
  } satisfies Parameters<typeof listedEntries>[0];

  return listing;
}
