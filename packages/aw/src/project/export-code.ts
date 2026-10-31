import {
  constants,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type { AgentVersionListResponse } from '@indx-workspace/contracts/agent-versions';
import { type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { DefinitionError } from '@indx-workspace/sdk/define';
import { PrintError, printAgentProject, type PrintedFile } from '@indx-workspace/sdk/portable';

import { CommandRefusedError, type CliIo } from '../io.js';
import { errorCode, readLocalProject } from '../local-runtime/project.js';

export interface ExportCodeOptions {
  readonly client: AgentWorkspaceClient;
  readonly io: CliIo;
  readonly signal: AbortSignal;
  readonly agentId: string;
  /** The project directory to write into, absolute. */
  readonly out: string;
  /** The version to write; the one `local` names (else the newest) when left out. */
  readonly version?: number | undefined;
  readonly force: boolean;
}

function pickVersion(
  listing: AgentVersionListResponse,
  agentId: string,
  number: number | undefined,
): AgentVersionListResponse['items'][number] {
  if (number !== undefined) {
    const named = listing.items.find((item) => item.number === number);
    if (named === undefined) {
      throw new CommandRefusedError(
        `agent ${agentId} has no version ${String(number)}`,
        `aw agents versions list ${agentId}`,
      );
    }
    return named;
  }
  const local = listing.pointers.find((pointer) => pointer.environment === 'local')?.number;
  const picked =
    listing.items.find((item) => item.number === local) ??
    listing.items.reduce<(typeof listing.items)[number] | undefined>(
      (newest, item) => (newest === undefined || item.number > newest.number ? item : newest),
      undefined,
    );
  if (picked === undefined) {
    throw new CommandRefusedError(
      `agent ${agentId} has no saved version to write as code`,
      `aw agents versions create ${agentId} --file <version.json> --yes`,
    );
  }
  return picked;
}

function printed(
  version: AgentVersionListResponse['items'][number],
  project: Awaited<ReturnType<typeof readLocalProject>>,
  agentId: string,
): readonly PrintedFile[] {
  try {
    return printAgentProject({
      body: version.body,
      project: project?.lifted === false ? project.project : undefined,
    }).files;
  } catch (error) {
    if (error instanceof PrintError) {
      const connector = error.paths.some((p) => p.startsWith('definition.resources.connectors'));
      throw new CommandRefusedError(
        `agent ${agentId}: ${error.message}`,
        connector
          ? 'an mcp() connector must be declared under connectors: in agent-workspace.yaml; module and code tools cannot be exported yet'
          : undefined,
      );
    }
    if (error instanceof DefinitionError) {
      throw new CommandRefusedError(`agent ${agentId}: ${error.message}`);
    }
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw new CommandRefusedError(`could not read ${file}`);
  }
}

/** One file moved into place, with where `--force` set aside the file it replaced (`null`: none). */
interface Installed {
  readonly target: string;
  readonly displaced: string | null;
}

/** What a filesystem answers when it cannot hard-link, or cannot link across the device. */
const CANNOT_HARD_LINK = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/** `rename`, falling back to a copy and a removal when `from` and `to` are on different devices. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
    await copyFile(from, to);
    await rm(from);
  }
}

/**
 * Create `target` from `staged` without replacing a file that is there: a hard link, which fails
 * with `EEXIST` if the target exists, or, on a filesystem or device that cannot link, an exclusive
 * copy. A copy that fails part-way is removed again, unless the failure is that the file existed.
 */
async function createNew(staged: string, target: string): Promise<void> {
  try {
    await link(staged, target);
  } catch (error) {
    if (!CANNOT_HARD_LINK.has(errorCode(error) ?? '')) throw error;
    try {
      await copyFile(staged, target, constants.COPYFILE_EXCL);
    } catch (copyError) {
      if (errorCode(copyError) !== 'EEXIST') await rm(target, { force: true });
      throw copyError;
    }
  }
}

/**
 * Move `staged` to `target`, recording it in `installed` as soon as `target` changes. Without
 * `force` the target must not exist ({@link createNew}), so a file created since the check above is
 * still not replaced. With `force` the file it replaces is first moved to `displaced`, from where
 * {@link undo} can bring it back.
 */
async function install(
  installed: Installed[],
  staged: string,
  target: string,
  displaced: string,
  force: boolean,
): Promise<void> {
  if (!force) {
    await createNew(staged, target);
    installed.push({ target, displaced: null });
    await rm(staged);
    return;
  }
  const replaced = await replacing(target);
  if (replaced) await move(target, displaced);
  installed.push({ target, displaced: replaced ? displaced : null });
  await move(staged, target);
}

/** Whether `target` is a file or link to replace; a directory is never replaced, even with `--force`. */
async function replacing(target: string): Promise<boolean> {
  try {
    if ((await lstat(target)).isDirectory())
      throw new CommandRefusedError(`could not write ${target}`);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Put back what a failed export had done, newest first: remove each file it installed, bring back the
 * file it replaced, and remove the directories it made. The paths that could not be put back.
 */
async function undo(
  installed: readonly Installed[],
  created: readonly string[],
): Promise<readonly string[]> {
  const stuck: string[] = [];
  for (const { target, displaced } of installed.toReversed()) {
    try {
      await rm(target, { force: true });
      if (displaced !== null) await move(displaced, target);
    } catch {
      stuck.push(target);
    }
  }
  for (const directory of created.toReversed()) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      stuck.push(directory);
    }
  }
  return stuck;
}

/**
 * Write every file or none. The files are written whole into a temporary directory under `out`,
 * then moved into place one by one; if any move fails, the files already moved are removed, the
 * ones `force` replaced are brought back, and the directories made are removed again. Returns the
 * paths written.
 *
 * The moves are separate filesystem operations, so the process being killed between two of them
 * (SIGKILL, power loss) leaves some files installed, the rest staged, and the `.aw-export-*`
 * directory behind; a failure the process survives, including one in the rollback, never does.
 * A filesystem that cannot hard-link, or a target on another device than `out`, is handled by
 * copying instead.
 */
async function writeAll(
  io: CliIo,
  out: string,
  files: readonly PrintedFile[],
  force: boolean,
): Promise<readonly string[]> {
  const created: string[] = [];
  const installed: Installed[] = [];
  let staging: string | undefined;
  let at = out;
  try {
    for (const directory of new Set(files.map((file) => path.dirname(path.join(out, file.path))))) {
      const made = await mkdir(directory, { recursive: true });
      if (made !== undefined) created.push(made);
    }
    staging = await mkdtemp(path.join(out, '.aw-export-'));
    for (const [index, file] of files.entries()) {
      at = path.join(out, file.path);
      await mkdir(path.dirname(path.join(staging, 'new', file.path)), { recursive: true });
      await writeFile(path.join(staging, 'new', file.path), file.text, { flag: 'wx' });
      await mkdir(path.join(staging, 'displaced'), { recursive: true });
      const displaced = path.join(staging, 'displaced', String(index));
      await install(installed, path.join(staging, 'new', file.path), at, displaced, force);
    }
  } catch (error) {
    const stuck = await undo(installed, created);
    // The temporary directory holds the only copy of a file `--force` set aside, so it is kept,
    // and named, whenever something could not be put back.
    if (staging !== undefined && stuck.length === 0) await removeStaging(io, staging);
    if (error instanceof CommandRefusedError && stuck.length === 0) throw error;
    const unrestored =
      stuck.length === 0
        ? ''
        : `; could not restore ${stuck.join(', ')}` +
          (staging === undefined ? '' : `; the files it replaced are kept in ${staging}`);
    throw new CommandRefusedError(`could not write ${at}${unrestored}`);
  }
  await removeStaging(io, staging);
  return installed.map(({ target }) => target);
}

/** The temporary directory is not part of the export: a failure to remove it is reported, not fatal. */
async function removeStaging(io: CliIo, staging: string): Promise<void> {
  try {
    await rm(staging, { recursive: true, force: true });
  } catch {
    io.stderr(`could not remove ${staging}; it can be deleted\n`);
  }
}

/**
 * `aw agents export <id> --format ts`: a saved version as `agents/<name>.ts` and `.md` under `out`.
 * Refuses before writing when any target exists, unless `force`. All the files are written or none:
 * a failure part-way leaves `out` as it was. Prints one `wrote <path>` line per file once all are
 * in place.
 */
export async function exportAgentAsCode(options: ExportCodeOptions): Promise<void> {
  const { client, io, signal, agentId, out, force } = options;
  const project = await readLocalProject(out);
  const listing = await client.agents.versions.list(agentId, { signal });
  const files = printed(pickVersion(listing, agentId, options.version), project, agentId);
  if (!force) {
    const taken: string[] = [];
    for (const file of files) {
      const target = path.join(out, file.path);
      if (await exists(target)) taken.push(target);
    }
    if (taken.length > 0) {
      throw new CommandRefusedError(
        `refusing to overwrite: ${taken.join(', ')}`,
        'pass --force to replace them',
      );
    }
  }
  for (const target of await writeAll(io, out, files, force)) io.stdout(`wrote ${target}\n`);
  io.stdout('Next: aw check && aw push\n');
}
