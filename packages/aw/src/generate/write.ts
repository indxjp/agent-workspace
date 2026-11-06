/**
 * Writing a project's files without overwriting any (`aw init`, `aw generate`), and the file
 * reads `aw generate` and `aw destroy` share. Every conflict is found before anything is written,
 * so a refusal never leaves a half-written project behind.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectFile } from '@indx-workspace/sdk/project';

import { CommandRefusedError, type CliIo } from '../io.js';
import { errorCode } from '../local-runtime/project.js';

/** `true` when nothing is at `target` or it is a directory (a symlink to one counts). */
async function isDirectoryOrAbsent(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    if (errorCode(error) === 'ENOTDIR') return false;
    throw error;
  }
}

/** `true` when anything, a dangling symlink included, is at `target`. */
export async function occupied(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    // ENOTDIR: a parent is a file, which `conflicts` already lists by the parent's own path.
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * What already occupies a path the files need: a file that exists (`lstat`, so a dangling symlink
 * counts too), or a parent such as `agents` that exists but is not a directory. A path `kept`
 * answers `true` for is not a conflict: the caller keeps the existing file instead.
 */
export async function conflicts(
  cwd: string,
  files: readonly ProjectFile[],
  kept: (file: string) => boolean = () => false,
): Promise<string[]> {
  const found = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join('/');
      if (!(await isDirectoryOrAbsent(path.join(cwd, parent)))) found.add(parent);
    }
    if (!kept(file.path) && (await occupied(path.join(cwd, file.path)))) found.add(file.path);
  }
  return [...found];
}

/**
 * Writes every file, refusing (by name, never overwriting) a path that appeared since
 * {@link conflicts} looked. `command` names the command in that refusal, `aw init`.
 */
export async function writeNewFiles(
  cwd: string,
  files: readonly ProjectFile[],
  io: CliIo,
  command: string,
): Promise<void> {
  const appeared = (relative: string): CommandRefusedError =>
    new CommandRefusedError(`${relative} appeared while ${command} was writing`);
  // Every directory first, so a parent that turned into a file is refused before any file exists.
  for (const file of files) {
    const directory = path.dirname(file.path);
    try {
      await mkdir(path.join(cwd, directory), { recursive: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST' || code === 'ENOTDIR') throw appeared(directory);
      throw error;
    }
  }
  for (const file of files) {
    try {
      // `wx`: a file that appeared since the check is never overwritten.
      await writeFile(path.join(cwd, file.path), file.contents, { flag: 'wx' });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw appeared(file.path);
      throw error;
    }
    io.stdout(`wrote ${file.path}\n`);
  }
}

/** The lower-case hex sha256 of a file's bytes, as `aw-generated.json` records it. */
export function sha256Of(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

/** A project file's text, or `undefined` when there is none. */
export async function readTextIfPresent(
  cwd: string,
  relative: string,
): Promise<string | undefined> {
  try {
    return await readFile(path.join(cwd, relative), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** What is at a recorded path now, compared with the sha256 recorded for it. */
export type RecordedFileState = 'unchanged' | 'edited' | 'missing';

/**
 * Whether the file at `relative` still has the recorded bytes. Anything other than a regular
 * file there (a directory, a symbolic link) counts as edited: `aw destroy` never deletes it.
 */
export async function recordedFileState(
  cwd: string,
  relative: string,
  sha256: string,
): Promise<RecordedFileState> {
  const target = path.join(cwd, relative);
  try {
    if (!(await lstat(target)).isFile()) return 'edited';
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return 'missing';
    throw error;
  }
  return sha256Of(await readFile(target)) === sha256 ? 'unchanged' : 'edited';
}

/**
 * Removes the directories of `relative` that are empty now, innermost first, stopping at the
 * first that is not (or at `cwd`, which is never removed).
 */
export async function removeEmptyParents(cwd: string, relative: string): Promise<void> {
  let directory = path.dirname(relative);
  while (directory !== '.' && directory !== '') {
    const absolute = path.join(cwd, directory);
    try {
      if ((await readdir(absolute)).length > 0) return;
      await rmdir(absolute);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    directory = path.dirname(directory);
  }
}
