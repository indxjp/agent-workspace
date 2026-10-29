import { openAsBlob } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MoveFileResponse, RemoveFileResponse } from '@indx-workspace/contracts/files';
import { ApiProblemError } from '@indx-workspace/sdk';

import {
  command,
  integerValue,
  isOn,
  positional,
  value,
  type Command,
  type CommandContext,
  type CommandResult,
} from '../command.js';
import { UsageError } from '../io.js';
import { notice } from '../output.js';

const FILE_COLUMNS = ['path', 'kind', 'sizeBytes', 'contentType', 'lastModified'];

/** A file-backed `Blob`: its bytes are read from disk as the request sends them, never all at once. */
async function localFile(localPath: string): Promise<Blob> {
  try {
    if ((await stat(localPath)).isFile()) return await openAsBlob(localPath);
  } catch {
    // Reported below, the same as a path that is not a regular file.
  }
  throw new UsageError(`could not read ${localPath}`);
}

/**
 * Bytes land in the named local file, or in the working directory under the file's own name;
 * a folder has no bytes and is answered with its metadata. With `--link` nothing is written: the
 * command prints a signed link; without `--ttl` the server's default lifetime applies.
 */
async function download(context: CommandContext): Promise<unknown> {
  const remotePath = positional(context, 0, 'path');
  if (isOn(context, 'link')) {
    const ttlSeconds = integerValue(context, 'ttl');
    const signed = await context.client.files.createDownloadUrl(
      remotePath,
      ttlSeconds === undefined ? {} : { ttlSeconds },
      { signal: context.signal },
    );
    return { url: signed.url, expiresAt: signed.expiresAt };
  }
  const downloaded = await context.client.files.download(remotePath, { signal: context.signal });
  if (downloaded.kind === 'folder') return downloaded.file;
  const target = context.positionals[1] ?? path.basename(downloaded.filename);
  try {
    await writeFile(target, downloaded.bytes);
  } catch {
    throw new UsageError(`could not write ${target}`);
  }
  notice(context.io, context.mode, `saved ${remotePath} to ${target}`);
  return {
    kind: 'file',
    path: remotePath,
    filename: downloaded.filename,
    contentType: downloaded.contentType,
    sizeBytes: downloaded.bytes.byteLength,
    savedTo: target,
  };
}

/**
 * A folder move or delete that stopped part-way is printed as usual but fails the command, with
 * what is left on stderr, so a script retries it instead of reading it as done — or, after a
 * `delete`-phase move, removes the leftover originals itself, since a retry answers 409.
 */
function subtreeResult(
  context: CommandContext,
  value: MoveFileResponse | RemoveFileResponse,
): CommandResult {
  if (value === null || !('status' in value) || value.status !== 'partial') return { value };
  const remaining = value.remaining ?? [];
  const lines = remaining.map((key) => `  ${key}\n`).join('');
  // After a `delete`-phase move the rows already sit at the destination, so a retry answers 409.
  const message =
    'phase' in value && value.phase === 'delete'
      ? 'incomplete; delete these leftover source keys:'
      : `incomplete; repeat the same command to finish it${lines === '' ? '' : '; these remain:'}`;
  context.io.stderr(`${message}\n${lines}`);
  return { value, failed: true };
}

/** §5.6 — `aw files`. A file is addressed by its workspace-relative path. `stat` waits for S-11. */
export const fileCommands: readonly Command[] = [
  command(
    'files list',
    '[--path <folder>]',
    'The root, or one folder, one level deep',
    async (context) => {
      const folder = value(context, 'path');
      return {
        value: await context.client.files.list(folder === undefined ? {} : { path: folder }, {
          signal: context.signal,
        }),
        columns: FILE_COLUMNS,
      };
    },
  ),
  command(
    'files upload',
    '<path> <local-file> [--direct]',
    'Write (or overwrite) one file from a local file; a signed link is used above 64 MiB, or always with --direct',
    async (context) => {
      const remotePath = positional(context, 0, 'path');
      const file = await localFile(positional(context, 1, 'local-file'));
      return {
        value: await context.client.files.upload(remotePath, file, {
          ...(isOn(context, 'direct') ? { direct: true } : {}),
          signal: context.signal,
        }),
      };
    },
  ),
  command('files mkdir', '<path>', 'Create an empty folder', async (context) => {
    const folderPath = positional(context, 0, 'path');
    try {
      return {
        value: await context.client.files.createFolder(folderPath, { signal: context.signal }),
      };
    } catch (error) {
      // 409 also answers a name that is a file, so only a folder at that path is a no-op.
      if (!(error instanceof ApiProblemError && error.status === 409)) throw error;
      // Probe the parent listing rather than download the path, which would fetch a file's bytes;
      // a failed probe keeps the original 409.
      const slash = folderPath.lastIndexOf('/');
      const parent = slash === -1 ? {} : { path: folderPath.slice(0, slash) };
      const existing = (
        await context.client.files.list(parent, { signal: context.signal }).catch(() => [])
      ).find((entry) => entry.path === folderPath);
      if (existing?.kind !== 'folder') throw error;
      notice(context.io, context.mode, `${folderPath} already exists`);
      return { value: existing };
    }
  }),
  command(
    'files download',
    '<path> [local-file] [--link] [--ttl <seconds>]',
    'Save a file locally, or show a folder; --link prints a signed download link instead',
    async (context) => ({
      value: await download(context),
    }),
  ),
  command(
    'files move',
    '<path> <new-path>',
    'Rename or move a file or a whole folder; a partial folder move exits 1',
    async (context) =>
      subtreeResult(
        context,
        await context.client.files.move(
          positional(context, 0, 'path'),
          positional(context, 1, 'new-path'),
          { signal: context.signal },
        ),
      ),
  ),
  command(
    'files remove',
    '<path> [--recursive]',
    'Delete a file, or a folder with --recursive; a partial delete exits 1',
    async (context) =>
      subtreeResult(
        context,
        await context.client.files.remove(positional(context, 0, 'path'), {
          recursive: isOn(context, 'recursive'),
          signal: context.signal,
        }),
      ),
  ),
];
