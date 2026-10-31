/**
 * Walk an {@link ObjectStore} prefix down to every file beneath it, recursively.
 *
 * A one-level `listPage(prefix)` is deliberately not recursive — `object-store.ts`'s header
 * says so, "matching `ListObjectsV2`'s `Delimiter: '/'` behaviour", and "a caller that wants a whole
 * tree calls this once per folder it discovers, the same way the S3 API itself is walked." A skill
 * directory can nest supporting files arbitrarily deep (spec §7's own tree shows only one level,
 * but does not forbid more), and this task's export must reproduce every one of them, so this is
 * that caller.
 */
import { withCompensation } from '@agent-workspace/core';
import { toObjectKey } from '@agent-workspace/core/storage/keys';
import { bytesToStream, listAll, readBytes, readWhole } from '../storage/objects';
import type { SkillObjects } from '../storage/store';
import { MAX_SKILL_REQUEST_BODY_BYTES } from '@indx-workspace/contracts/skills';

import type { StorageService } from '../storage/service';
import {
  skillFilesPrefix,
  skillRevisionPrefix,
  skillRevisionRowFolder,
  skillRowFolder,
} from './keys';

/** One file found under a walked prefix, with its key relative to the prefix that was walked. */
export interface WalkedFile {
  /** The file's full store key, e.g. `skills/demo/scripts/run.sh`. */
  readonly key: string;
  /** The same file's path relative to the walked prefix, e.g. `scripts/run.sh`. */
  readonly relativePath: string;
  /**
   * The file's size, as the listing already reported it. Carried here so a caller that
   * only needs sizes — `describeSkill`, listing a whole workspace's skills — does not have to
   * `get` every file's bytes back just to measure them.
   */
  readonly sizeBytes: number;
}

/**
 * Every file at or under `prefix`, in a stable order (lexicographic on `relativePath`) so two
 * callers of this function on the same tree always see files in the same sequence — the round-trip
 * proof this task ships hashes files pairwise by that order.
 */
// storage-bridge(#1699): the prefix walk reads skills stored as a bare object prefix
export async function walkFiles(store: SkillObjects, prefix: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];

  async function recurse(at: string): Promise<void> {
    const entries = await listAll(store, at);
    for (const entry of entries) {
      if (entry.kind === 'folder') {
        await recurse(entry.key);
      } else {
        out.push({
          key: entry.key,
          relativePath: entry.key.slice(prefix.length + 1),
          sizeBytes: entry.sizeBytes,
        });
      }
    }
  }

  await recurse(prefix);
  return out.sort(byRelativePath);
}

function byRelativePath(a: { relativePath: string }, b: { relativePath: string }): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}

/** Where a skill's files are saved as rows: the catalog service of a workspace. */
export interface SkillRows {
  readonly storage: Pick<StorageService, 'list' | 'open'>;
  readonly workspaceId: string;
}

/** {@link SkillRows} for a route, which may also save and delete a skill's rows. */
export interface SkillRowsAccess extends SkillRows {
  readonly storage: Pick<StorageService, 'list' | 'open' | 'remove' | 'save'>;
}

/** {@link SkillRowsAccess} plus who the saved rows belong to. */
export interface SkillRowsWriter extends SkillRowsAccess {
  readonly principal: { readonly principalId: string; readonly userId: string | null };
}

/** One file of a skill, wherever it is stored. */
export interface SkillFile {
  readonly relativePath: string;
  readonly sizeBytes: number;
  /** The bytes, or `null` when the file is gone or larger than a skill request may be. */
  read(): Promise<Uint8Array | null>;
  /** The row's checksum; `null` for a file without one (a bare object prefix). */
  readonly sha256: string | null;
  /** The bytes as a stream, or `null` when the file is gone. Nothing is read until it is pulled. */
  open(): Promise<ReadableStream<Uint8Array> | null>;
}

async function rowFiles(rows: SkillRows, folder: string): Promise<SkillFile[]> {
  const ctx = { workspaceId: rows.workspaceId };
  const out: SkillFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await rows.storage.list(
      ctx,
      'skills',
      folder,
      cursor === undefined ? undefined : { cursor },
    );
    for (const row of page.rows) {
      out.push({
        relativePath: row.path.slice(folder.length + 1),
        sizeBytes: row.sizeBytes,
        read: async () => {
          const opened = await rows.storage.open(ctx, row);
          return opened === null ? null : readBytes(opened.body, MAX_SKILL_REQUEST_BODY_BYTES);
        },
        sha256: row.sha256 ?? null,
        open: async () => (await rows.storage.open(ctx, row))?.body ?? null,
      });
    }
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return out.sort(byRelativePath);
}

/**
 * Every file of one skill, or of one published revision: the catalog rows under `folder` when there
 * are any, else the objects under `legacyPrefix`. Rows win outright, so a leftover prefix is never
 * merged into them.
 */
export async function skillFiles(
  store: SkillObjects,
  rows: SkillRows | undefined,
  folder: string,
  legacyPrefix: string,
): Promise<SkillFile[]> {
  if (rows !== undefined) {
    const found = await rowFiles(rows, folder);
    if (found.length > 0) return found;
  }
  // storage-bridge(#1699): read skills stored as a bare object prefix
  return (await walkFiles(store, legacyPrefix)).map((file) => ({
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    read: async () => (await readWhole(store, file.key))?.body ?? null,
    sha256: null,
    open: async () => {
      const found = await readWhole(store, file.key);
      return found === null ? null : bytesToStream(found.body);
    },
  }));
}

/** Where one skill, or one published revision, is written, whichever way it is stored. */
export interface SkillWriter {
  files(): Promise<SkillFile[]>;
  /** Replaces the file at `relativePath`. Throws `UnsafeObjectKeyError` for an unsafe path. */
  put(relativePath: string, bytes: Uint8Array): Promise<void>;
  /** {@link put} of a stream, which a rows writer never holds whole. */
  putStream(relativePath: string, body: ReadableStream<Uint8Array>): Promise<void>;
  /** Removes one file; a file that is already gone is not an error. */
  remove(relativePath: string): Promise<void>;
  /** Removes every file written here. */
  clear(): Promise<void>;
}

function refusedWrite(what: string, code: string): Error {
  return new Error(`could not ${what}: ${code}`);
}

/** The catalog service refused to save one of a skill's files; the handlers answer it as a 4xx. */
export class SkillSaveRefusedError extends Error {
  public constructor(public readonly code: Exclude<SaveRefusal, 'invalid_path'>) {
    super(`could not save a skill file: ${code}`);
    this.name = 'SkillSaveRefusedError';
  }
}

type SaveRefusal = Extract<Awaited<ReturnType<StorageService['save']>>, { ok: false }>['code'];

function throwRefusedSave(code: SaveRefusal): never {
  // The path passed `toObjectKey` before the save, so an unsafe-path refusal is a server fault.
  if (code === 'invalid_path') throw refusedWrite('save a skill file', code);
  throw new SkillSaveRefusedError(code);
}

/**
 * Writers of a skill (`revision` undefined) or of one published revision: each file is one
 * `skills` row saved through the service, replaced in place.
 */
export function skillWriter(
  store: SkillObjects,
  rows: SkillRowsWriter,
  name: string,
  revision?: number,
): SkillWriter {
  const folder =
    revision === undefined ? skillRowFolder(name) : skillRevisionRowFolder(name, revision);
  const prefix =
    revision === undefined ? skillFilesPrefix(name) : skillRevisionPrefix(name, revision);
  const { storage, workspaceId, principal } = rows;
  const ctx = { workspaceId, ...principal };
  const removeRows = async (path: string, recursive: boolean): Promise<void> => {
    const gone = await storage.remove(ctx, 'skills', path, { recursive });
    if (!gone.ok && gone.code !== 'not_found') throw refusedWrite(`remove ${path}`, gone.code);
  };
  const save = async (relativePath: string, body: ReadableStream<Uint8Array>): Promise<void> => {
    const path = `${folder}/${relativePath}`;
    toObjectKey(path);
    const saved = await storage.save(ctx, {
      area: 'skills',
      path,
      body,
      maxBytes: MAX_SKILL_REQUEST_BODY_BYTES,
      replace: true,
    });
    if (!saved.ok) throwRefusedSave(saved.code);
  };
  return {
    files: () => skillFiles(store, rows, folder, prefix),
    put: (relativePath, bytes) => save(relativePath, bytesToStream(bytes)),
    putStream: save,
    remove: (relativePath) => removeRows(`${folder}/${relativePath}`, false),
    clear: () => removeRows(folder, true),
  };
}

/**
 * Before a skill stored as a bare object prefix is changed: copy each of its files that has no row
 * yet into one, then delete the prefix, so the change cannot land in a prefix the rows hide. While
 * the prefix exists the move is unfinished, and the next change resumes it. A row that is already
 * there is never replaced, so two first changes cannot overwrite each other's rows, and a file a
 * change removed after the move is never brought back. A `revision` moves that published revision's
 * prefix instead. Answers how many old files the prefix held (0: nothing to move).
 */
export async function ensureSkillRows(
  store: SkillObjects,
  rows: SkillRowsWriter,
  name: string,
  revision?: number,
): Promise<number> {
  // storage-bridge(#1699): move a skill stored as a bare object prefix into rows
  const legacy = await walkFiles(
    store,
    revision === undefined ? skillFilesPrefix(name) : skillRevisionPrefix(name, revision),
  );
  if (legacy.length === 0) return 0;
  const { storage, workspaceId, principal } = rows;
  const folder =
    revision === undefined ? skillRowFolder(name) : skillRevisionRowFolder(name, revision);
  for (const file of legacy) {
    const object = await store.read(file.key);
    if (object === null) continue;
    // A save that throws instead of refusing may never have read the body: release its source.
    // A body the save already locked is the save's to finish.
    const saved = await withCompensation(
      () =>
        storage.save(
          { workspaceId, ...principal },
          {
            area: 'skills',
            path: `${folder}/${file.relativePath}`,
            body: object.body,
            maxBytes: MAX_SKILL_REQUEST_BODY_BYTES,
            replace: false,
          },
        ),
      () => (object.body.locked ? Promise.resolve() : object.body.cancel()),
    );
    // A ready row was copied earlier or written since; a pending one is another writer's.
    if (!saved.ok && saved.code !== 'path_taken' && saved.code !== 'upload_in_progress') {
      throwRefusedSave(saved.code);
    }
  }
  // Only a complete copy ends the move; another writer's pending row leaves it to the next change.
  const copied = new Set((await rowFiles(rows, folder)).map((file) => file.relativePath));
  if (!legacy.every((file) => copied.has(file.relativePath))) return legacy.length;
  for (const file of legacy) await store.delete(file.key);
  return legacy.length;
}
