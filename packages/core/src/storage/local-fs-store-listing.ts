/**
 * The local-filesystem backend's listing: one directory level, or the whole tree beneath a
 * prefix, read from the object tree with each file's content type taken from its sidecar.
 * `local-fs-store.ts`'s header explains the two trees and why nothing is filtered out by name.
 */
import type { Dirent, Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { addressableObjectName, OBJECT_METADATA_SUFFIX } from './key-safety.js';
import type { ObjectListEntry } from './object-store.js';
import { childKey, inWalkOrder, walkedBefore } from './streams.js';

/** The absolute directories one local store works in: its root and the two trees under it. */
export interface LocalTrees {
  readonly root: string;
  readonly objects: string;
  readonly metadata: string;
}

export interface Sidecar {
  readonly contentType: string | null;
}

function isSidecarPayload(value: unknown): value is Sidecar {
  if (typeof value !== 'object' || value === null) return false;
  const contentType = (value as Record<string, unknown>)['contentType'];
  return contentType === null || typeof contentType === 'string';
}

/** A `NodeJS.ErrnoException`-shaped rejection carrying the code named. */
export function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** No such path, or a file where a folder was expected along it. */
export function isMissingPath(error: unknown): boolean {
  return hasErrnoCode(error, 'ENOENT') || hasErrnoCode(error, 'ENOTDIR');
}

export async function readSidecar(metaPath: string): Promise<string | null> {
  try {
    const text = await readFile(metaPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    return isSidecarPayload(parsed) ? parsed.contentType : null;
  } catch {
    // Missing, unreadable or malformed sidecar: the content type is unknown, not an error.
    return null;
  }
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
 * No such folder, or the prefix names a file rather than a folder: both read as "nothing is
 * here", not as an error — the same shape `get` uses for ENOENT/EISDIR.
 */
async function readdirOrNothing(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

/**
 * The sidecar of the file `name` found in the folder `keyPrefix`. Built from the directory entry
 * rather than re-validated through the guard: these names came from `readdir` of a directory this
 * module owns, and a name on disk need not be a string the guard would accept (a file put there by
 * something else).
 */
function sidecarPathOf(trees: LocalTrees, keyPrefix: string, name: string): string {
  const folders = keyPrefix === '' ? [] : keyPrefix.split('/');
  return path.join(trees.metadata, ...folders, name) + OBJECT_METADATA_SUFFIX;
}

function fileListEntry(key: string, stats: Stats, contentType: string | null): ObjectListEntry {
  return { kind: 'file', key, sizeBytes: stats.size, contentType, lastModified: stats.mtime };
}

async function listedFile(
  trees: LocalTrees,
  dir: string,
  keyPrefix: string,
  name: string,
): Promise<ObjectListEntry> {
  const [stats, contentType] = await Promise.all([
    stat(path.join(dir, name)),
    readSidecar(sidecarPathOf(trees, keyPrefix, name)),
  ]);
  return fileListEntry(childKey(keyPrefix, name), stats, contentType);
}

/** One level of the folder `dir`, whose key is `safePrefix`: its files and non-empty folders. */
export async function* levelEntries(
  trees: LocalTrees,
  dir: string,
  safePrefix: string,
  after: string | undefined,
): AsyncGenerator<ObjectListEntry> {
  const entries = await readdirOrNothing(dir);
  // Nothing a caller can write is filtered out of this listing *by name*. The object tree
  // contains objects and only objects — sidecars live in a sibling tree — so no name a caller
  // can write is hidden from its own listing, which is the invisibility half of F3 (rounds
  // 1-3). A name the key guard refuses (put there by another tool) is skipped: no caller could
  // address it. The other filter is about *kind*, below: an entry that is neither a file nor a directory is skipped,
  // so a junction or symlink planted here out of band is reachable through `get`/`list` while
  // being absent from its parent's listing. Declared on this task's PR, not repaired here.
  // In name order, which is key order here; nothing before the cursor is looked at again.
  for (const entry of inWalkOrder(entries, () => false)) {
    const key = childKey(safePrefix, entry.name);
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
    yield await listedFile(trees, dir, safePrefix, entry.name);
  }
}

/**
 * The object AT a prefix itself, if there is one — only a plain file key can be one; a folder
 * never has bytes at its own path (`files.ts`'s schema comment says the same thing for the catalog
 * row).
 */
export async function* fileAt(
  key: string,
  objectPath: string,
  metaPath: string,
): AsyncGenerator<ObjectListEntry> {
  try {
    const stats = await stat(objectPath);
    if (stats.isFile()) {
      const contentType = await readSidecar(metaPath);
      yield fileListEntry(key, stats, contentType);
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

/** Every file beneath the folder `dir`, whose key is `keyPrefix`, in key order after `after`. */
export async function* walkEntries(
  trees: LocalTrees,
  dir: string,
  keyPrefix: string,
  after: string | undefined,
): AsyncGenerator<ObjectListEntry> {
  // In key order, skipping every folder and file the cursor is already past.
  const entries = await readdirOrNothing(dir);
  for (const entry of inWalkOrder(entries, (dirent) => dirent.isDirectory())) {
    const key = childKey(keyPrefix, entry.name);
    if (entry.isDirectory()) {
      if (!walkedBefore(key, after))
        yield* walkEntries(trees, path.join(dir, entry.name), key, after);
      continue;
    }
    if (!entry.isFile()) continue; // symlinks and other special files: see `levelEntries`'s comment
    if (addressableObjectName(key) === null) continue; // a name another tool wrote
    if (after !== undefined && key < after) continue;
    yield await listedFile(trees, dir, keyPrefix, entry.name);
  }
}
