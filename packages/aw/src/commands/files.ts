import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ApiProblemError } from '@indx-workspace/sdk';

import { command, isOn, positional, value, type Command, type CommandContext } from '../command.js';
import { UsageError } from '../io.js';
import { notice } from '../output.js';

const FILE_COLUMNS = ['path', 'kind', 'sizeBytes', 'contentType', 'lastModified'];

async function localBytes(localPath: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(localPath));
  } catch {
    throw new UsageError(`could not read ${localPath}`);
  }
}

/**
 * Bytes land in the named local file, or in the working directory under the file's own name;
 * a folder has no bytes and is answered with its metadata.
 */
async function download(context: CommandContext): Promise<unknown> {
  const remotePath = positional(context, 0, 'path');
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
    '<path> <local-file>',
    'Write (or overwrite) one file from a local file',
    async (context) => ({
      value: await context.client.files.upload(
        positional(context, 0, 'path'),
        await localBytes(positional(context, 1, 'local-file')),
        { signal: context.signal },
      ),
    }),
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
    '<path> [local-file]',
    'Save a file locally, or show a folder',
    async (context) => ({
      value: await download(context),
    }),
  ),
  command(
    'files move',
    '<path> <new-path>',
    'Rename or move a file or a whole folder',
    async (context) => ({
      value: await context.client.files.move(
        positional(context, 0, 'path'),
        positional(context, 1, 'new-path'),
        {
          signal: context.signal,
        },
      ),
    }),
  ),
  command(
    'files remove',
    '<path> [--recursive]',
    'Delete a file, or a folder with --recursive',
    async (context) => ({
      value: await context.client.files.remove(positional(context, 0, 'path'), {
        recursive: isOn(context, 'recursive'),
        signal: context.signal,
      }),
    }),
  ),
];
