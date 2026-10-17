/**
 * How `agent-workspace render` replaces a file it owns (ADR-0090).
 *
 * `.env` is the only copy of a deployment's secrets, so a crash part-way through a write must not
 * leave it truncated. Each file is written to a new temporary file in the same directory, flushed
 * to disk, and renamed over the target: a reader sees the old bytes or the new ones, never a mix.
 * `rename` replaces the directory entry rather than following it, so a symbolic link planted at
 * the target after `render` checked it is replaced, not written through.
 */
import { randomBytes } from 'node:crypto';
import { chmod, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Flush a directory entry change (the rename) to disk. Windows cannot open a directory. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Replace `target` with `contents`, atomically. `mode` is the mode of the file being replaced:
 * the new file gets it, so `.env` stays `0600`; `null` for a file that does not exist yet, which
 * is created as `writeFile` would create it. On any failure the temporary file is removed and
 * `target` is left as it was.
 */
export async function writeFileAtomically(
  target: string,
  contents: string,
  mode: number | null,
): Promise<void> {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    // `wx` never opens an existing file, so a link planted at this name cannot be written through.
    // A replacement starts owner-only and gets the old mode before it becomes visible.
    const handle = await open(temporary, 'wx', mode === null ? 0o666 : 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== null) await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], `Writing ${target} failed`, {
        cause: cleanup,
      });
    }
    throw error;
  }
  await syncDirectory(directory);
}
