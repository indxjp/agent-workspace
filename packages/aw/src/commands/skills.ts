import { openAsBlob } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SkillFile } from '@indx-workspace/contracts/skills';
import type { AgentWorkspaceClient, SkillImportFile } from '@indx-workspace/sdk';

import {
  command,
  positional,
  readBody,
  value,
  type Command,
  type CommandContext,
} from '../command.js';
import { UsageError } from '../io.js';
import { UpdateSkillBody } from '../inputs.js';
import { notice } from '../output.js';

const SKILL_COLUMNS = ['name', 'enabled', 'description', 'fileCount', 'updatedAt'];

/** Every file under `directory`, sorted by relative path (forward slashes); at least one. */
async function skillDirectoryPaths(
  directory: string,
): Promise<{ readonly path: string; readonly absolute: string }[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true, recursive: true });
  } catch {
    throw new UsageError(`could not read directory ${directory}`);
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = path.join(entry.parentPath, entry.name);
      return { path: path.relative(directory, absolute).split(path.sep).join('/'), absolute };
    });
  if (files.length === 0) throw new UsageError(`${directory} holds no files`);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** Every file under `directory`, path relative to it with forward slashes, bytes as base64. */
export async function readSkillDirectory(directory: string): Promise<SkillFile[]> {
  const files = await skillDirectoryPaths(directory);
  return Promise.all(
    files.map(async (file) => ({
      path: file.path,
      contentBase64: (await readFile(file.absolute)).toString('base64'),
    })),
  );
}

// @story US-STO-08
/** The same files as `Blob`s, for the multipart import: no base64, no second copy of the bytes. */
async function readSkillBlobs(directory: string): Promise<SkillImportFile[]> {
  const files = await skillDirectoryPaths(directory);
  return Promise.all(
    files.map(async (file) => ({ path: file.path, body: await openAsBlob(file.absolute) })),
  );
}

/**
 * Make the workspace skill `name` hold `files`: import it when `existing` (its files now) is
 * absent, else one patch that writes every file and removes the ones `files` no longer has.
 * The `skills/` folders `aw dev` and `aw push` sync upload through it; a new skill is imported
 * with each file's decoded bytes as `body`, never the SDK's deprecated `contentBase64` form.
 */
export async function uploadSkill(
  client: AgentWorkspaceClient,
  upload: {
    readonly name: string;
    readonly files: readonly SkillFile[];
    readonly existing?: readonly SkillFile[];
  },
  signal: AbortSignal,
): Promise<unknown> {
  const { name, files, existing } = upload;
  if (existing === undefined) {
    const bodies = files.map((file) => ({
      path: file.path,
      body: new Uint8Array(Buffer.from(file.contentBase64, 'base64')),
    }));
    return client.skills.import({ name, files: bodies }, { signal });
  }
  const kept = new Set(files.map((file) => file.path));
  const removeFiles = existing.map((file) => file.path).filter((file) => !kept.has(file));
  return client.skills.update(name, { files, removeFiles }, { signal });
}

/**
 * Write an export under `directory`. The server's path grammar already excludes `..`, and the
 * check here makes the CLI's own promise independent of it: nothing is ever written outside the
 * directory the caller named.
 */
async function writeSkillDirectory(directory: string, files: readonly SkillFile[]): Promise<void> {
  const root = path.resolve(directory);
  for (const file of files) {
    const target = path.resolve(root, file.path);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new UsageError(`refusing to write outside ${directory}: ${file.path}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, 'base64'));
  }
}

async function setEnabled(context: CommandContext, enabled: boolean): Promise<unknown> {
  return context.client.skills.update(
    positional(context, 0, 'name'),
    { enabled },
    { signal: context.signal },
  );
}

/** §5.7 — `aw skills`. `remove` is refused (`409 skill_in_use`) while an agent has the skill. */
export const skillCommands: readonly Command[] = [
  command('skills list', '', 'Every skill, in full detail', async ({ client, signal }) => ({
    value: await client.skills.list({ signal }),
    columns: SKILL_COLUMNS,
  })),
  command('skills get', '<name>', 'One skill', async (context) => ({
    value: await context.client.skills.get(positional(context, 0, 'name'), {
      signal: context.signal,
    }),
  })),
  command(
    'skills import',
    '<dir> [--name <name>]',
    'Import a directory holding SKILL.md (name defaults to the directory name)',
    async (context) => {
      const directory = positional(context, 0, 'dir');
      const name = value(context, 'name') ?? path.basename(path.resolve(directory));
      return {
        value: await context.client.skills.import(
          { name, files: await readSkillBlobs(directory) },
          { signal: context.signal },
        ),
      };
    },
  ),
  command(
    'skills publish',
    '<name> <dir>',
    "Replace a skill's files with a directory and freeze them as the next numbered revision",
    async (context) => ({
      value: await context.client.skills.publish(
        positional(context, 0, 'name'),
        { files: await readSkillDirectory(positional(context, 1, 'dir')) },
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'skills export',
    '<name> <dir>',
    "Write a skill's files into a directory",
    async (context) => {
      const directory = positional(context, 1, 'dir');
      const exported = await context.client.skills.export(positional(context, 0, 'name'), {
        signal: context.signal,
      });
      await writeSkillDirectory(directory, exported.files);
      notice(
        context.io,
        context.mode,
        `wrote ${String(exported.files.length)} files to ${directory}`,
      );
      const { mode } = context;
      return {
        value: mode.json || mode.jsonl ? exported : exported.files.map((file) => file.path),
      };
    },
  ),
  command(
    'skills update',
    '<name> --file <json>',
    'Enable/disable, write or remove files in one patch',
    async (context) => ({
      value: await context.client.skills.update(
        positional(context, 0, 'name'),
        await readBody(context, UpdateSkillBody),
        { signal: context.signal },
      ),
    }),
  ),
  command('skills enable', '<name>', 'Enable a skill', async (context) => ({
    value: await setEnabled(context, true),
  })),
  command('skills disable', '<name>', 'Disable a skill', async (context) => ({
    value: await setEnabled(context, false),
  })),
  command('skills remove', '<name>', 'Delete a skill no agent is assigned', async (context) => {
    await context.client.skills.remove(positional(context, 0, 'name'), {
      signal: context.signal,
    });
    return { value: undefined };
  }),
];
