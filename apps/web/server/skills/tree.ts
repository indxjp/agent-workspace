/**
 * A skill's files as `skills` catalog rows (`.skills/<name>/…`, and `.skills/<name>@<n>/…` for a
 * published revision), read and written through the catalog service.
 */
import { toObjectKey } from '@agent-workspace/core/storage/keys';
import { bytesToStream, readBytes } from '../storage/objects';
import type { StorageService } from '../storage-and-sharing';
import { MAX_SKILL_REQUEST_BODY_BYTES } from '@indx-workspace/contracts/skills';

import { skillRevisionRowFolder, skillRowFolder } from './keys';

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

/** One file of a skill. */
export interface SkillFile {
  readonly relativePath: string;
  readonly sizeBytes: number;
  /** The bytes, or `null` when the file is gone or larger than a skill request may be. */
  read(): Promise<Uint8Array | null>;
  /** The row's checksum; `null` when its writer recorded none (the column is nullable). */
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
 * Every file of one skill, or of one published revision: the catalog rows under `folder`, sorted by
 * relative path. None without the catalog service.
 */
export async function skillFiles(
  rows: SkillRows | undefined,
  folder: string,
): Promise<SkillFile[]> {
  return rows === undefined ? [] : rowFiles(rows, folder);
}

/** Where one skill, or one published revision, is written. */
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
export function skillWriter(rows: SkillRowsWriter, name: string, revision?: number): SkillWriter {
  const folder =
    revision === undefined ? skillRowFolder(name) : skillRevisionRowFolder(name, revision);
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
    files: () => rowFiles(rows, folder),
    put: (relativePath, bytes) => save(relativePath, bytesToStream(bytes)),
    putStream: save,
    remove: (relativePath) => removeRows(`${folder}/${relativePath}`, false),
    clear: () => removeRows(folder, true),
  };
}
