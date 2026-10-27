import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

import type { RunFileReference } from '@agent-workspace/run-protocol';

import { resolveGrantedPath } from './resources.js';

export type FileVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'run_file_missing' | 'run_file_checksum_mismatch';
      /** The request's own relative path, never a host path. */
      readonly path: string;
    };

/**
 * Check every granted file reference against what the hydrate left on disk, before the agent starts
 * (the storage design, §04 and §05).
 *
 * Each path goes through the writer's own resolver ({@link resolveGrantedPath}), so a reference into
 * the engine's `protectedConfigDirectory` is `run_file_missing` before anything there is opened.
 * The file is opened `O_NOFOLLOW | O_NONBLOCK` and judged on the **handle**: a path swapped for a
 * FIFO after resolution neither blocks the open nor gets read. A symlink, a non-regular file, a
 * missing path or any read failure is `run_file_missing`; a different size or digest is
 * `run_file_checksum_mismatch`. The result names only the request's relative path: the guards' own
 * messages carry absolute host paths and are deliberately dropped.
 */
// @story US-STO-06
// @story US-STO-11
export async function verifyReferencedFiles(
  cwd: string,
  protectedConfigDirectory: string,
  references: readonly RunFileReference[],
): Promise<FileVerification> {
  for (const reference of references) {
    const missing: FileVerification = { ok: false, code: 'run_file_missing', path: reference.path };
    const mismatch: FileVerification = {
      ok: false,
      code: 'run_file_checksum_mismatch',
      path: reference.path,
    };
    let handle: FileHandle;
    try {
      handle = await open(
        resolveGrantedPath(cwd, reference.path, protectedConfigDirectory),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      return missing;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return missing;
      if (stats.size !== reference.size) return mismatch;
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk as Buffer);
      }
      if (hash.digest('hex') !== reference.sha256) return mismatch;
    } catch {
      return missing;
    } finally {
      await handle.close();
    }
  }
  return { ok: true };
}
