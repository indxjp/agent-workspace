/**
 * The workspace a `use-cases/<slug>` entry's recorder plays its turn in. The entry's own agent
 * definition decides what the engine gates (`engine.requireApproval`) and which folders
 * `search_files` covers (its `files()` grants); its sample files are its catalog entry's
 * `demo.seed` folders, placed at their collections as the demo seeds them, under `/workspace/`;
 * and `Read` answers a file's real text from there, or an error for a path the seed does not hold.
 * Only the model's decisions are scripted, by the recorder.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DefinedAgent } from '@indx-workspace/sdk/define';
import { z } from 'zod';

import { hasSource } from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { createFileSearch } from '../../gallery/harness/file-search.ts';
import { scriptedWorkspace, type Script } from '../../gallery/harness/scripted-workspace.ts';
import type { McpToolResult } from '../../gallery/harness/mcp-client.ts';
import type { RecordedRun } from '../proof/record-turn.ts';
import { playTurn } from './run.ts';
import type { Ask } from './types.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const READ = z.object({ file_path: z.string() });
const WORKSPACE = '/workspace/';

/** `Read` of a seeded file: its text, or an error for a path outside `work` or not in it. */
function reading(
  work: string,
): (name: string, input: Record<string, unknown>) => Promise<McpToolResult> | null {
  return (name, input) => {
    if (name !== 'Read') return null;
    const { file_path: file } = READ.parse(input);
    const relative = file.startsWith(WORKSPACE) ? file.slice(WORKSPACE.length) : null;
    const full = relative === null ? null : path.resolve(work, relative);
    const inside = full !== null && full.startsWith(`${work}${path.sep}`);
    if (full === null || !inside || !existsSync(full) || !statSync(full).isFile()) {
      return Promise.resolve({ text: `File does not exist: ${file}`, isError: true });
    }
    return Promise.resolve({ text: readFileSync(full, 'utf8'), isError: false });
  };
}

/** The engine's gates as the agent declares them; an agent on another engine gates nothing. */
function gatesOf(agent: DefinedAgent): readonly string[] | undefined {
  return typeof agent.engine === 'object' && agent.engine.id === 'claude-agent-sdk'
    ? agent.engine.requireApproval
    : undefined;
}

/**
 * Plays `ask.prompt` against `slug`'s agent with `model` deciding, every approval approved, in a fresh
 * working directory that holds the entry's seeded files and is removed afterwards. The run asks for
 * `ask.outputSchema` when the entry declares one, as the Try it section starts it.
 */
export async function playUseCase(
  slug: string,
  agent: DefinedAgent,
  model: Script,
  ask: Pick<Ask, 'prompt' | 'outputSchema'>,
): Promise<readonly RecordedRun[]> {
  const entry = CATALOG.filter(hasSource).find((one) => one.slug === slug);
  if (entry === undefined) throw new Error(`${slug}: no entry with a source`);
  const source = path.join(ROOT, entry.source);
  const work = mkdtempSync(path.join(tmpdir(), `store-recording-${slug}-`));
  try {
    for (const seed of entry.demo.seed) {
      cpSync(path.join(source, seed.from), path.join(work, seed.collection), { recursive: true });
    }
    const search = createFileSearch({
      root: work,
      grants: (agent.files ?? []).map((grant) => grant.path),
    });
    const workspace = scriptedWorkspace(
      model,
      {},
      { search_files: search.call },
      { requireApproval: gatesOf(agent), native: reading(work) },
    );
    return await playTurn(workspace, ask);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
