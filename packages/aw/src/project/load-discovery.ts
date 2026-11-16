import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_MARKDOWN_SUFFIX } from '@indx-workspace/sdk/portable';
import { CommandRefusedError } from '../io.js';
import { localProblem, type ProjectProblem } from './problems.js';
import { isDefinitionFileName, PROJECT_FILES_MAX } from './protocol.js';

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** The definition files of one directory, and the entries refused before the fork. */
export interface DefinitionFiles {
  readonly files: readonly string[];
  readonly problems: readonly ProjectProblem[];
}

function isDefinitionName(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

function isAgentMarkdownName(name: string): boolean {
  return name.endsWith(AGENT_MARKDOWN_SUFFIX) && name.length > AGENT_MARKDOWN_SUFFIX.length;
}

/** `agents/<name>.agent.md`, with the same name rule as a file handed to the child. */
const AGENT_MARKDOWN_FILE = /^agents\/[^/\\:\p{Cc}\p{Cf}]+\.agent\.md$/u;

/** Which files of a directory are definition files, and which of their names may be loaded. */
interface DefinitionKind {
  readonly isName: (name: string) => boolean;
  readonly isFileName: (file: string) => boolean;
}

const TYPESCRIPT_FILES: DefinitionKind = {
  isName: isDefinitionName,
  isFileName: isDefinitionFileName,
};

export const AGENT_MARKDOWN_FILES: DefinitionKind = {
  isName: isAgentMarkdownName,
  isFileName: (file) => AGENT_MARKDOWN_FILE.test(file),
};

/** Whether `relative` (from `path.relative`) leaves the directory it is relative to. */
export function escapes(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** Why a linked definition file is refused: its target must be a file inside the project. */
async function linkRefusal(rootReal: string, absolute: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return "the link's target does not exist";
  }
  if (escapes(path.relative(rootReal, real))) return 'the link points outside the project';
  return (await stat(real)).isFile() ? null : "the link's target is not a file";
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

/**
 * `<directory>/<name>.ts` for every TypeScript file directly in `directory` (or, with `kind`, every
 * file of that kind), sorted. A symbolic link is followed when its target is a file inside the
 * project and refused otherwise, and a name the loader cannot be handed is refused, each as a
 * problem of that file.
 */
export async function definitionFiles(
  root: string,
  rootReal: string,
  directory: string,
  kind: DefinitionKind = TYPESCRIPT_FILES,
): Promise<DefinitionFiles> {
  let entries;
  try {
    entries = await readdir(path.join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      return { files: [], problems: [] };
    }
    throw error;
  }
  const files: string[] = [];
  const problems: ProjectProblem[] = [];
  const candidates = entries
    .filter((entry) => kind.isName(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
    .sort(byName);
  for (const entry of candidates) {
    const file = `${directory}/${entry.name}`;
    if (!kind.isFileName(file)) {
      problems.push(
        localProblem(file, 'file_name_unsupported', [
          'the name must not contain a control or format character, a backslash or a colon',
        ]),
      );
      continue;
    }
    if (entry.isSymbolicLink()) {
      const refused = await linkRefusal(rootReal, path.join(root, directory, entry.name));
      if (refused !== null) {
        problems.push(localProblem(file, 'file_link_refused', [refused]));
        continue;
      }
    }
    files.push(file);
  }
  if (files.length > PROJECT_FILES_MAX) {
    throw new CommandRefusedError(
      `${directory}/ holds ${String(files.length)} definition files; at most ${String(PROJECT_FILES_MAX)} are loaded`,
    );
  }
  return { files, problems };
}
