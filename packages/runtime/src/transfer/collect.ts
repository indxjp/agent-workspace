import { constants } from 'node:fs';
import { lstat, open as fsOpen, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { type StreamTarEntry, ArchiveValidationError, ArchiveTooLargeError } from './model.js';
import { normalizeArchivePath, assertSegment, resolveWithin } from './paths.js';
import { encodeUstarStream } from './encode-stream.js';
import { refuseSymlinkParents } from './extract.js';

type CollectBudget = { remaining: number; readonly limit: number };

/** `relativePath` is already validated; each directory child is a literal checked only as a segment. */
async function collectEntry(
  root: string,
  relativePath: string,
  entries: StreamTarEntry[],
  budget: CollectBudget,
): Promise<void> {
  const absolute = resolveWithin(root, relativePath);
  // A linked parent (`outputs -> /etc`) would export files from outside the workspace.
  await refuseSymlinkParents(root, absolute);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    throw new ArchiveValidationError(`symlink archive entries are forbidden: ${relativePath}`);
  }
  if (stat.isDirectory()) {
    entries.push({ path: relativePath, type: 'directory', mode: stat.mode & 0o7777 });
    const children = await readdir(absolute);
    children.sort();
    for (const child of children) {
      assertSegment(child, relativePath);
      await collectEntry(root, `${relativePath}/${child}`, entries, budget);
    }
    return;
  }
  if (!stat.isFile()) {
    throw new ArchiveValidationError(`unsupported workspace entry: ${relativePath}`);
  }
  budget.remaining -= stat.size;
  if (budget.remaining < 0) {
    throw new ArchiveTooLargeError(`the collected files exceed ${String(budget.limit)} bytes.`);
  }
  entries.push({
    path: relativePath,
    type: 'file',
    mode: stat.mode & 0o7777,
    size: stat.size,
    // Opened late, so prove it is still the file checked above: a leaf or parent swapped for a
    // symlink since then would export a host file. Nonblocking, so a leaf swapped for a FIFO is
    // refused below instead of waiting forever for a writer.
    open: async () => {
      const changed = new ArchiveValidationError(
        `workspace entry changed while streaming: ${relativePath}`,
      );
      const handle = await fsOpen(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch((error: unknown) => {
        throw (error as NodeJS.ErrnoException).code === 'ELOOP' ? changed : error;
      });
      try {
        const opened = await handle.stat();
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) throw changed;
      } catch (error) {
        await handle.close();
        throw error;
      }
      return Readable.toWeb(handle.createReadStream());
    },
  });
}

export async function archiveWorkspacePaths(
  workspaceRoot: string,
  paths: readonly string[],
  options: { readonly maxBytes?: number } = {},
): Promise<ReadableStream<Uint8Array>> {
  if (paths.length === 0) {
    throw new ArchiveValidationError('at least one workspace path is required');
  }
  const limit = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const budget: CollectBudget = { remaining: limit, limit };
  const entries: StreamTarEntry[] = [];
  for (const requested of paths) {
    await collectEntry(workspaceRoot, normalizeArchivePath(requested), entries, budget);
  }
  return encodeUstarStream(entries, { maxBytes: limit });
}
