import { mkdir, stat, writeFile } from 'node:fs/promises';
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

/**
 * `aw agents export <id> --format ts`: a saved version as `agents/<name>.ts` and `.md` under `out`.
 * Refuses before writing when any target exists, unless `force`; a write that fails part-way leaves
 * the files already printed as `wrote`. Prints one `wrote <path>` line per file.
 */
export async function exportAgentAsCode(options: ExportCodeOptions): Promise<void> {
  const { client, io, signal, agentId, out, force } = options;
  const project = await readLocalProject(out);
  const listing = await client.agents.versions.list(agentId, { signal });
  const files = printed(pickVersion(listing, agentId, options.version), project, agentId);
  const targets = files.map((file) => ({ file, target: path.join(out, file.path) }));
  if (!force) {
    const taken: string[] = [];
    for (const { target } of targets) if (await exists(target)) taken.push(target);
    if (taken.length > 0) {
      throw new CommandRefusedError(
        `refusing to overwrite: ${taken.join(', ')}`,
        'pass --force to replace them',
      );
    }
  }
  await mkdir(path.join(out, 'agents'), { recursive: true });
  for (const { file, target } of targets) {
    try {
      // 'wx' so a file created since the check above is still not replaced.
      await writeFile(target, file.text, { flag: force ? 'w' : 'wx' });
    } catch {
      throw new CommandRefusedError(`could not write ${target}`);
    }
    io.stdout(`wrote ${target}\n`);
  }
  io.stdout('Next: aw check && aw push\n');
}
