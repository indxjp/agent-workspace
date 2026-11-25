/**
 * The workspace a `use-cases/<slug>` entry's recorder plays its turn in. The entry's own agent
 * definition decides what the engine gates (`engine.requireApproval`), which folders
 * `search_files` covers (its `files()` grants) and which skills it may run; its sample files are its
 * catalog entry's `demo.seed` folders, placed at their collections as the demo seeds them, under
 * `/workspace/`. `Read` answers a file's real text from there, or an error for a path the seed does
 * not hold; `Write` writes there; and `run_skill_script` runs a skill's real script there, as the
 * platform does: the entry's own skill, or a built-in one (`office-writer`) the agent is granted.
 * Each connector whose writes the demo keeps is a records stand-in (`./records-stand-in.ts`), and an
 * entry that reads a public source (ADR-0170) gets its code tool on `aw-dev-tools`, answered by the
 * tool's own snapshot-mode run over the snapshot the project ships, which is what a visitor's copy
 * answers from (`PUBLIC_SOURCES` in `../seed/build.ts`). Only the model's decisions are scripted,
 * by the recorder.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';
import { publicSourceRun, type DefinedAgent } from '@indx-workspace/sdk/define';
import { z } from 'zod';

import { hasSource } from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { createFileSearch } from '../../gallery/harness/file-search.ts';
import { scriptedWorkspace, type Script } from '../../gallery/harness/scripted-workspace.ts';
import type {
  BuiltinTools,
  ScriptedConnector,
} from '../../gallery/harness/scripted-workspace-types.ts';
import type { McpToolResult } from '../../gallery/harness/mcp-client.ts';
import type { RecordedRun } from '../proof/record-turn.ts';
import { PUBLIC_SOURCES } from '../seed/build.ts';
import { recordsStandIns } from './records-stand-in.ts';
import { playTurn } from './run.ts';
import type { Ask } from './types.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Where the platform's built-in skills are shipped from, one folder each. */
const BUILTIN_SKILLS = path.join(ROOT, 'packages', 'skills-office');

const READ = z.object({ file_path: z.string() });
const WRITE = z.object({ file_path: z.string(), content: z.string() });
const WORKSPACE = '/workspace/';

/** The file `file` names inside `work`, or `null` for a path outside it. */
function inside(work: string, file: string): string | null {
  const relative = file.startsWith(WORKSPACE) ? file.slice(WORKSPACE.length) : null;
  const full = relative === null ? null : path.resolve(work, relative);
  return full !== null && full.startsWith(`${work}${path.sep}`) ? full : null;
}

/**
 * The file tools on the working directory `work`: `Read` of a seeded or written file (its text, or
 * an error for a path outside `work` or not in it), and `Write`, which writes the file there.
 */
export function fileTools(
  work: string,
): (name: string, input: Record<string, unknown>) => Promise<McpToolResult> | null {
  return (name, input) => {
    if (name === 'Write') {
      const { file_path: file, content } = WRITE.parse(input);
      const full = inside(work, file);
      if (full === null) {
        return Promise.resolve({ text: `Path is outside the workspace: ${file}`, isError: true });
      }
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
      return Promise.resolve({ text: 'ok', isError: false });
    }
    if (name !== 'Read') return null;
    const { file_path: file } = READ.parse(input);
    const full = inside(work, file);
    if (full === null || !existsSync(full) || !statSync(full).isFile()) {
      return Promise.resolve({ text: `File does not exist: ${file}`, isError: true });
    }
    return Promise.resolve({ text: readFileSync(full, 'utf8'), isError: false });
  };
}

/**
 * The connectors of `slug`'s public-source tool: `aw-dev-tools` with the one code tool the project
 * declares, run in snapshot mode with no network; none for an entry that reads no public source.
 * A call the tool refuses (a query it does not take) answers its error, as the tool host does.
 */
export function publicSourceConnectors(slug: string): Readonly<Record<string, ScriptedConnector>> {
  const publicSource = PUBLIC_SOURCES[slug];
  if (publicSource === undefined) return {};
  const run = publicSourceRun(publicSource.source);
  const { signal } = new AbortController();
  const call = async (tool: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    if (tool !== publicSource.tool.name) {
      return { text: `${AW_DEV_TOOLS_CONNECTOR} has no tool ${tool}`, isError: true };
    }
    try {
      return { text: JSON.stringify(await run(args, { signal })), isError: false };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  return { [AW_DEV_TOOLS_CONNECTOR]: { id: AW_DEV_TOOLS_CONNECTOR, session: { call } } };
}

const SKILL_CALL = z.object({
  skill: z.string(),
  script: z.string(),
  args: z.array(z.string()),
});

/** A script file name: no folder, so a call cannot reach outside the skill's `scripts/`. */
const SCRIPT_NAME = /^[\w.-]+\.m?js$/u;

/** How long a skill script may run before the recording fails it. */
const SCRIPT_TIMEOUT_MS = 30_000;

/** An argument that names a path outside the run's folder: absolute, or climbing with `..`. */
const escapes = (arg: string): boolean => path.isAbsolute(arg) || arg.includes('..');

/**
 * `run_skill_script` as the platform runs it: a script of a skill `agent` is granted, with the given
 * arguments and no shell, in the run's working directory `work`. The entry's own skill is
 * `<source>/skills/<skill>/`, a built-in one is the shipped folder. A skill the agent is not granted
 * or a script it does not ship is an error, as on the platform, and so is an argument that is
 * absolute or holds `..`; so is a script that fails or overruns, with what it printed on stderr.
 */
export function skillScripts(agent: DefinedAgent, source: string, work: string): BuiltinTools {
  const granted = new Set((agent.skills ?? []).map((skill) => skill.name));
  return {
    run_skill_script: (args) => {
      const call = SKILL_CALL.parse(args);
      const file = isBuiltinSkillName(call.skill)
        ? path.join(BUILTIN_SKILLS, call.skill, 'scripts', call.script)
        : path.join(source, 'skills', call.skill, 'scripts', call.script);
      if (!granted.has(call.skill) || !SCRIPT_NAME.test(call.script) || !existsSync(file)) {
        return Promise.resolve({ text: `no script ${call.skill}/${call.script}`, isError: true });
      }
      const outside = call.args.filter(escapes);
      if (outside.length > 0) {
        return Promise.resolve({
          text: `argument outside the run's folder: ${outside.join(', ')}`,
          isError: true,
        });
      }
      // No shell, a bounded run and an empty environment: the script gets only its arguments.
      const run = spawnSync(process.execPath, [file, ...call.args], {
        cwd: work,
        encoding: 'utf8',
        env: {},
        timeout: SCRIPT_TIMEOUT_MS,
      });
      return Promise.resolve({
        text:
          run.status === 0 ? run.stdout : run.error === undefined ? run.stderr : run.error.message,
        isError: run.status !== 0,
      });
    },
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
      { ...recordsStandIns(slug), ...publicSourceConnectors(slug) },
      { search_files: search.call, ...skillScripts(agent, source, work) },
      { requireApproval: gatesOf(agent), native: fileTools(work) },
    );
    return await playTurn(workspace, ask);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
