import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FieldVerdict, PlatformFile } from '@indx-workspace/contracts/platforms';
import { PLATFORM_TARGETS } from '@indx-workspace/platforms';
import { AGENT_MARKDOWN_SUFFIX, formatAgentMarkdown } from '@indx-workspace/sdk/portable';

import type { LocalCommandContext } from '../command.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { errorCode } from '../local-runtime/project.js';
import { guardPaths, refusalText } from './export.js';

export interface PlatformImport {
  readonly platform: string;
  readonly agents: readonly string[];
  /** Project-relative paths written, sorted. */
  readonly files: readonly string[];
  readonly report: readonly FieldVerdict[];
}

const MAX_FILES = 500;
const MAX_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git']);
const TOO_LARGE = (given: string): string =>
  `${given} is larger than an agent export (${String(MAX_FILES)} files, 5 MiB)`;

function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A NUL byte near the start marks a file as binary; anything else is read as UTF-8 text. */
function fileContent(bytes: Uint8Array<ArrayBuffer>): string | Uint8Array<ArrayBuffer> {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    ? bytes
    : new TextDecoder().decode(bytes);
}

/** `given` (a file, or a directory walked without links) as the files an importer reads. */
async function readInput(given: string, absolute: string): Promise<readonly PlatformFile[]> {
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      throw new UsageError(`could not read ${given}`);
    }
    throw error;
  }
  const names: string[] = [];
  if (info.isFile()) names.push(path.basename(absolute));
  else {
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(absolute, relative), { withFileTypes: true })) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(child);
        } else if (entry.isFile()) {
          names.push(child);
          if (names.length > MAX_FILES) throw new CommandRefusedError(TOO_LARGE(given));
        }
      }
    };
    await walk('');
  }
  let total = 0;
  const files: PlatformFile[] = [];
  for (const name of names.sort(byCodeUnit)) {
    const source = info.isFile() ? absolute : path.join(absolute, ...name.split('/'));
    total += (await stat(source)).size;
    if (total > MAX_BYTES) throw new CommandRefusedError(TOO_LARGE(given));
    const bytes = new Uint8Array(await readFile(source));
    files.push({ path: name, content: fileContent(bytes) });
  }
  return files;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Turns a platform's own agent files (`given`, a file or a directory) into `agents/<name>.agent.md`
 * and `skills/<name>/…` in the project (ADR-0133 D5). Nothing is overwritten without `overwrite`,
 * and an `agents/<name>.ts` is never replaced: it would shadow the file written beside it.
 */
export async function importPlatform(
  context: LocalCommandContext,
  input: { readonly platform: string; readonly given: string; readonly overwrite: boolean },
): Promise<PlatformImport> {
  const { cwd } = context;
  if (cwd === undefined) throw new CommandRefusedError('there is no current directory to write to');
  const target = PLATFORM_TARGETS.find((candidate) => candidate.id === input.platform);
  if (target === undefined) {
    throw new UsageError(
      `unknown agent platform ${JSON.stringify(input.platform)}`,
      `one of: ${PLATFORM_TARGETS.map((candidate) => candidate.id).join(', ')}`,
    );
  }
  if (target.import === undefined) {
    const importers = PLATFORM_TARGETS.filter((candidate) => candidate.import !== undefined).map(
      (candidate) => candidate.id,
    );
    throw new CommandRefusedError(
      `${target.id} has no importer; only a platform's declarative agent files can be read back, not code`,
      `importers: ${importers.join(', ')}`,
    );
  }

  const files = await readInput(input.given, path.resolve(cwd, input.given));
  const imported = target.import(files);
  if (!imported.ok) throw new CommandRefusedError(refusalText(imported.refusal));
  const { project } = imported;

  const planned: PlatformFile[] = [
    ...project.agents.map((agent) => ({
      path: `agents/${agent.name}${AGENT_MARKDOWN_SUFFIX}`,
      content: formatAgentMarkdown(agent),
    })),
    ...project.skills.flatMap((skill) =>
      skill.files.map((file) => ({
        path: `skills/${skill.name}/${file.path}`,
        content: file.content,
      })),
    ),
    ...project.knowledgeFiles,
  ];
  const destinations = await guardPaths(
    cwd,
    target.id,
    planned.map((file) => file.path),
  );

  for (const agent of project.agents) {
    if (await exists(path.join(cwd, 'agents', `${agent.name}.ts`))) {
      throw new CommandRefusedError(`agents/${agent.name}.ts already defines ${agent.name}`);
    }
  }
  if (!input.overwrite) {
    const taken: string[] = [];
    for (const [index, file] of planned.entries()) {
      const destination = destinations[index];
      if (destination !== undefined && (await exists(destination))) taken.push(file.path);
    }
    if (taken.length > 0) {
      throw new CommandRefusedError(
        `${taken.join(', ')} already exist${taken.length === 1 ? 's' : ''}`,
        'pass --yes to overwrite',
      );
    }
  }

  for (const [index, file] of planned.entries()) {
    const destination = destinations[index];
    if (destination === undefined) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  return {
    platform: target.id,
    agents: project.agents.map((agent) => agent.name),
    files: planned.map((file) => file.path).sort(byCodeUnit),
    report: imported.report,
  };
}
