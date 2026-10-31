import { fork } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import type { EngineId } from '@indx-workspace/contracts/engines';
import type { EvalCaseFile } from '@indx-workspace/contracts/evaluations';
import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';
import * as define from '@indx-workspace/sdk/define';
import { ProjectFileError, readEvalCaseFile } from '@indx-workspace/sdk/project';
import type { z } from 'zod';

import { profileKeyRefs } from '../config.js';
import { CommandRefusedError, UsageError, type CliIo } from '../io.js';
import { withoutNames } from '../local-runtime/environment.js';
import { deepEqual } from './diff.js';
import { localProblem, type ProjectProblem } from './problems.js';
import {
  EvaluatingMessageSchema,
  isDefinitionFileName,
  LoadedMessageSchema,
  PROJECT_FILES_MAX,
  type LoadedMessage,
  type LoadMessage,
} from './protocol.js';

/** How long the child may take to evaluate every file before it is killed. */
const LOADER_TIMEOUT_MS = 30_000;

/** How long the child may linger after it answered (a timer the user's code left) before it is killed. */
const EXIT_GRACE_MS = 2_000;

/** The file a whole-project refusal (the loader itself) is attributed to. */
const PROJECT_FILE = '.';

/**
 * The credential variables `aw` itself may read; every profile's `apiKeyRef` is withheld too.
 * This keeps the environment's keys out of the child only: the definition files are the user's
 * own code, run with the user's file access, as `node agents/x.ts` would run them (ADR-0111).
 */
const WITHHELD_ENV = ['AGENT_WORKSPACE_API_KEY', 'ANTHROPIC_API_KEY'];

/**
 * The child's file, beside this one: `loader-child.ts` when this module runs from `src` (the test
 * runner, where Node strips the child itself), `loader-child.js` from `dist`.
 */
const CHILD_PATH = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './loader-child.ts' : './loader-child.js',
    import.meta.url,
  ),
);

/** `process.features`, or what a test puts in its place. */
export interface LoaderFeatures {
  readonly typescript: string | false;
}

export interface LoadProjectOptions {
  /** The project's directory, absolute. */
  readonly root: string;
  readonly io: CliIo;
  readonly signal: AbortSignal;
  readonly features?: LoaderFeatures | undefined;
  readonly timeoutMs?: number | undefined;
  /** The project file's `engine`, for an agent that names none (C12). */
  readonly defaultEngine?: EngineId | undefined;
  /** More variables to keep out of the child: the project's secret names (SD17). */
  readonly withheld?: readonly string[] | undefined;
}

/** One agent the project defines, with its surfaces, ready to be checked or saved. */
interface LoadedAgent {
  readonly file: string;
  readonly name: string;
  readonly body: AgentVersionBody;
  /** The file of each of `body.surfaces`, in the same order. */
  readonly surfaceFiles: readonly string[];
  /** The code tools (ADR-0115) this agent lists. */
  readonly codeTools: readonly LoadedCodeTool[];
}

/** One catalog tool of the project (C15), with the file that declares it. */
export interface LoadedTool {
  /** The module that exports the tool, or the agent's file for an inline one. */
  readonly file: string;
  readonly definition: define.ToolDefinition;
}

/** One code tool of the project (`defineTool()`, ADR-0115): served by the tool host, not stored. */
export interface LoadedCodeTool {
  readonly file: string;
  readonly name: string;
  /** The project-relative run file the tool declares; `aw push` bundles it (ADR-0118 TS1). */
  readonly run: string;
  /** What `aw push` pins beside the bundle's digest for a hosted tool sandbox (ADR-0118 TS4). */
  readonly pinned?: define.PinnedToolDeclaration;
}

/** What the loader found: the agents that loaded cleanly, and every problem. */
export interface ProjectLoad {
  readonly agents: readonly LoadedAgent[];
  readonly problems: readonly ProjectProblem[];
  /** The secret names the loaded agents' tools reference, each once, sorted (SD17). */
  readonly secrets: readonly string[];
  /** The loaded agents' `openapiTool()` and `postgresTool()` tools, each name once. */
  readonly tools: readonly LoadedTool[];
  /** The loaded agents' `defineTool()` tools, each name once. */
  readonly codeTools: readonly LoadedCodeTool[];
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** The definition files of one directory, and the entries refused before the fork. */
interface DefinitionFiles {
  readonly files: readonly string[];
  readonly problems: readonly ProjectProblem[];
}

function isDefinitionName(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

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
 * `<directory>/<name>.ts` for every TypeScript file directly in `directory`, sorted. A symbolic
 * link is followed when its target is a file inside the project and refused otherwise, and a name
 * the loader cannot be handed is refused, each as a problem of that file.
 */
async function definitionFiles(
  root: string,
  rootReal: string,
  directory: string,
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
    .filter((entry) => isDefinitionName(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
    .sort(byName);
  for (const entry of candidates) {
    const file = `${directory}/${entry.name}`;
    if (!isDefinitionFileName(file)) {
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

/**
 * `io.env` without {@link WITHHELD_ENV}, every profile's `apiKeyRef` and `withheld`, whatever their
 * case.
 */
async function childEnv(
  io: CliIo,
  withheld: readonly string[] = [],
): Promise<Record<string, string>> {
  return withoutNames(io.env, [
    ...WITHHELD_ENV,
    ...(await profileKeyRefs(io.homeDir)),
    ...withheld,
  ]);
}

/**
 * How the child ended: with its answer; killed at the timeout; or exited without answering while
 * it evaluated `file`, the one it last announced (`null` before the first).
 */
type ChildOutcome =
  | { readonly kind: 'reply'; readonly message: unknown }
  | { readonly kind: 'timeout'; readonly file: string | null }
  | { readonly kind: 'unfinished'; readonly file: string; readonly code: number | null };

/**
 * Fork the child, hand it the files and wait for its one answer. Its stdout and stderr — the
 * definition files' own `console` output — go to `aw`'s stderr, so `--json` output stays clean.
 */
function runChild(
  request: LoadMessage,
  options: LoadProjectOptions,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ChildOutcome> {
  const { io, signal } = options;
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_PATH, [], {
      execArgv: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      env,
      cwd: request.root,
    });
    let reply: { readonly message: unknown } | null = null;
    let evaluating: string | null = null;
    let timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      signal.removeEventListener('abort', kill);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      io.stderr(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      io.stderr(chunk);
    });
    child.on('message', (message: unknown) => {
      if (reply !== null) return;
      const announced = EvaluatingMessageSchema.safeParse(message);
      if (announced.success) {
        evaluating = announced.data.file;
        return;
      }
      reply = { message };
      grace = setTimeout(kill, EXIT_GRACE_MS);
    });
    child.once('error', (error) => {
      cleanup();
      kill();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      if (reply !== null) resolve({ kind: 'reply', message: reply.message });
      else if (timedOut) resolve({ kind: 'timeout', file: evaluating });
      else if (signal.aborted)
        reject(new CommandRefusedError('the project loader was interrupted'));
      else if (evaluating !== null) resolve({ kind: 'unfinished', file: evaluating, code });
      else {
        reject(
          new CommandRefusedError(
            `the project loader exited (code ${String(code)}) before it answered`,
          ),
        );
      }
    });
    child.send(request);
  });
}

function issueDetail(issue: z.core.$ZodIssue): string {
  const dotted = issue.path.map(String).join('.');
  return `${dotted === '' ? '(root)' : dotted}: ${issue.message}`;
}

/**
 * The parse issues of one agent's assembled body, each attributed to its file: an issue under
 * `surfaces.<i>` to that surface's file, anything else to the agent's.
 */
function bodyProblems(agent: LoadedAgent, error: z.ZodError): readonly ProjectProblem[] {
  const byFile = new Map<string, string[]>();
  for (const issue of error.issues) {
    const [head, index] = issue.path;
    const file =
      (head === 'surfaces' && typeof index === 'number' ? agent.surfaceFiles[index] : undefined) ??
      agent.file;
    const details = byFile.get(file);
    if (details === undefined) byFile.set(file, [issueDetail(issue)]);
    else details.push(issueDetail(issue));
  }
  return [...byFile].map(([file, details]) => ({
    file,
    status: 400,
    code: 'invalid_agent_version',
    details,
  }));
}

type LoadedAgentEntry = Extract<LoadedMessage['files'][number], { readonly tools: unknown }>;

/**
 * An agent's catalog tools, made again here from what the child sent: each through the SDK's own
 * strict `openapiTool()` / `postgresTool()`, then `toolDefinitionsOf()` over an agent holding
 * them, which also refuses a name repeated within the agent. The child is not trusted: a value
 * the SDK refuses throws {@link define.DefinitionError}.
 */
function catalogTools(entry: LoadedAgentEntry): readonly LoadedTool[] {
  const wires = entry.tools.flatMap((wire) => (wire.kind === 'code' ? [] : [wire]));
  if (wires.length === 0) return [];
  const made = wires.map((wire) =>
    wire.kind === 'openapi' ? define.openapiTool(wire.tool) : define.postgresTool(wire.tool),
  );
  const definitions = define.toolDefinitionsOf(
    define.defineAgent({ name: entry.name, instructions: '', tools: made }),
  );
  return wires.map((wire, index) => {
    const definition = definitions[index];
    if (definition === undefined) throw new Error('toolDefinitionsOf() dropped a tool');
    return { file: wire.file, definition };
  });
}

interface PendingAgent {
  readonly file: string;
  readonly name: string;
  readonly body: AgentVersionBody;
  readonly surfaces: SurfaceDefinition[];
  readonly surfaceFiles: string[];
  /** Applied only if the agent passes every check below. */
  readonly tools: readonly LoadedTool[];
  readonly codeTools: readonly LoadedCodeTool[];
  refused: boolean;
}

/**
 * Group the child's answers: surfaces join the agent they name, and the names C9 makes unique
 * across a workspace (agents, surfaces) are checked across the project. `agentRefused` says an
 * agent file was refused before the fork, so a surface naming an unknown agent may name it.
 */
function assemble(reply: LoadedMessage, agentRefused: boolean): ProjectLoad {
  const problems: ProjectProblem[] = [];
  const agents = new Map<string, PendingAgent>();
  const secrets = new Set<string>();
  const tools = new Map<string, LoadedTool>();
  const codeTools = new Map<string, LoadedCodeTool>();
  let agentFailed = agentRefused;
  for (const entry of reply.files) {
    if (entry.kind !== 'agent') continue;
    if ('problem' in entry) {
      problems.push({ file: entry.file, ...entry.problem });
      agentFailed = true;
    } else if (agents.has(entry.name)) {
      problems.push(localProblem(entry.file, 'agent_name_duplicate', [entry.name]));
    } else {
      agents.set(entry.name, {
        file: entry.file,
        name: entry.name,
        body: entry.body,
        surfaces: [],
        surfaceFiles: [],
        tools: catalogTools(entry),
        codeTools: entry.tools.flatMap((wire) =>
          wire.kind === 'code'
            ? [
                {
                  file: wire.file,
                  name: wire.tool.name,
                  run: wire.tool.run,
                  pinned: define.pinnedOf(wire.tool),
                },
              ]
            : [],
        ),
        refused: false,
      });
      for (const name of entry.secrets) secrets.add(name);
    }
  }
  const surfaceNames = new Set<string>();
  for (const entry of reply.files) {
    if (entry.kind !== 'surface') continue;
    if ('problem' in entry) {
      problems.push({ file: entry.file, ...entry.problem });
      continue;
    }
    const { surface } = entry;
    const agent = agents.get(surface.agent);
    if (surfaceNames.has(surface.name)) {
      problems.push(localProblem(entry.file, 'surface_name_duplicate', [surface.name]));
      if (agent !== undefined) agent.refused = true;
      continue;
    }
    surfaceNames.add(surface.name);
    if (agent === undefined) {
      // An agent file that failed to load may be the one this surface names, so the refusal
      // would only repeat that failure.
      if (!agentFailed)
        problems.push(localProblem(entry.file, 'surface_agent_unknown', [surface.agent]));
      continue;
    }
    agent.surfaces.push(surface);
    agent.surfaceFiles.push(entry.file);
  }
  const loaded: LoadedAgent[] = [];
  for (const pending of agents.values()) {
    if (pending.refused) continue;
    const parsed = AgentVersionBodySchema.safeParse({
      ...pending.body,
      surfaces: pending.surfaces,
    });
    const agent: LoadedAgent = {
      file: pending.file,
      name: pending.name,
      body: parsed.success ? parsed.data : { definition: pending.body.definition, surfaces: [] },
      surfaceFiles: pending.surfaceFiles,
      codeTools: pending.codeTools,
    };
    if (parsed.success) {
      loaded.push(agent);
      for (const tool of pending.tools) {
        const seen = tools.get(tool.definition.name);
        if (seen === undefined) tools.set(tool.definition.name, tool);
        else if (seen.file !== tool.file || !deepEqual(seen.definition, tool.definition)) {
          problems.push(localProblem(tool.file, 'tool_name_duplicate', [tool.definition.name]));
        }
      }
      for (const tool of pending.codeTools) {
        const seen = codeTools.get(tool.name);
        if (seen === undefined) codeTools.set(tool.name, tool);
        else if (seen.file !== tool.file) {
          problems.push(localProblem(tool.file, 'tool_name_duplicate', [tool.name]));
        }
      }
    } else problems.push(...bodyProblems(agent, parsed.error));
  }
  return {
    agents: loaded,
    problems,
    secrets: [...secrets].sort(),
    tools: [...tools.values()],
    codeTools: [...codeTools.values()],
  };
}

/** Whether the reply answers exactly the files that were asked for, each once. */
function answersRequest(reply: LoadedMessage, request: LoadMessage): boolean {
  const asked = [...request.agents, ...request.surfaces];
  const answered = reply.files.map((entry) => entry.file);
  return asked.length === answered.length && asked.every((file, index) => answered[index] === file);
}

/**
 * Load a project's `agents/*.ts` and `surfaces/*.ts` (issue #452): each is evaluated in a child
 * process with Node's own type stripping and a closed linker that serves
 * `@indx-workspace/sdk/define` and project-relative `.ts` modules whose real path stays inside the
 * root, outside any `node_modules` (ADR-0111 and its slice-2 amendment), then the answers are
 * checked and grouped here.
 *
 * Refuses with {@link CommandRefusedError} when there is no `agents/*.ts` at all, or when the child
 * fails without an answer. Every per-file refusal is a {@link ProjectProblem} instead.
 */
export async function loadProject(options: LoadProjectOptions): Promise<ProjectLoad> {
  const features = options.features ?? process.features;
  if (features.typescript === false) {
    return {
      agents: [],
      problems: [
        localProblem(PROJECT_FILE, 'typescript_unavailable', [
          `Node.js ${process.version} runs with TypeScript type stripping turned off; remove --no-experimental-strip-types from NODE_OPTIONS`,
        ]),
      ],
      secrets: [],
      tools: [],
      codeTools: [],
    };
  }
  const rootReal = await realpath(options.root);
  const agents = await definitionFiles(options.root, rootReal, 'agents');
  if (agents.files.length === 0 && agents.problems.length === 0) {
    throw new CommandRefusedError('no agents/*.ts in this directory', 'aw init --yes');
  }
  const surfaces = await definitionFiles(options.root, rootReal, 'surfaces');
  const refused = [...agents.problems, ...surfaces.problems];
  if (agents.files.length === 0)
    return { agents: [], problems: refused, secrets: [], tools: [], codeTools: [] };
  const request: LoadMessage = {
    type: 'load',
    root: options.root,
    agents: agents.files,
    surfaces: surfaces.files,
    ...(options.defaultEngine === undefined ? {} : { defaultEngine: options.defaultEngine }),
  };
  const timeoutMs = options.timeoutMs ?? LOADER_TIMEOUT_MS;
  const env = await childEnv(options.io, options.withheld);
  const outcome = await runChild(request, options, env, timeoutMs);
  if (outcome.kind === 'timeout') {
    return {
      agents: [],
      problems: [
        ...refused,
        localProblem(outcome.file ?? PROJECT_FILE, 'loader_timeout', [
          `the definition files did not finish loading within ${String(timeoutMs)} ms`,
        ]),
      ],
      secrets: [],
      tools: [],
      codeTools: [],
    };
  }
  if (outcome.kind === 'unfinished') {
    return {
      agents: [],
      problems: [
        ...refused,
        localProblem(outcome.file, 'module_unfinished', [
          `the loader exited (code ${String(outcome.code)}) while this file was evaluating: a top-level await that never settles, or process.exit()`,
        ]),
      ],
      secrets: [],
      tools: [],
      codeTools: [],
    };
  }
  const malformed = new CommandRefusedError('the project loader answered with a malformed message');
  const reply = LoadedMessageSchema.safeParse(outcome.message);
  if (!reply.success || !answersRequest(reply.data, request)) throw malformed;
  let load: ProjectLoad;
  try {
    load = assemble(reply.data, agents.problems.length > 0);
  } catch (error) {
    if (error instanceof define.DefinitionError) throw malformed;
    throw error;
  }
  return { ...load, problems: [...refused, ...load.problems] };
}

/** The directory of a project's evaluation case files, one `<agent>.yaml` per agent (issue #618). */
const EVALS_DIRECTORY = 'evals';

/** The agents with an `evals/<agent>.yaml`, sorted; none is a usage error that says to name one. */
export async function evalAgents(root: string): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = (await readdir(path.join(root, EVALS_DIRECTORY))).filter((name) =>
      name.endsWith('.yaml'),
    );
  } catch {
    names = [];
  }
  if (names.length === 0) {
    throw new UsageError(
      `missing <agent>: name the agent whose ${EVALS_DIRECTORY}/<agent>.yaml to run`,
    );
  }
  return names.map((name) => name.slice(0, -'.yaml'.length)).sort();
}

/**
 * The agent an `aw feedback` without one is about: the only `evals/*.yaml` file's agent. Several,
 * or none, is a usage error that says to name one.
 */
export async function soleEvalAgent(root: string): Promise<string> {
  const names = await evalAgents(root);
  const [only] = names;
  if (only === undefined || names.length > 1) {
    throw new UsageError(
      `missing <agent>: name the agent whose ${EVALS_DIRECTORY}/<agent>.yaml to run` +
        ` (found ${names.map((name) => `${name}.yaml`).join(', ')})`,
    );
  }
  return only;
}

/**
 * `evals/<agentName>.yaml`, relative to the project root. A name that is not one file name is a
 * usage error, so no agent name can reach outside `evals/`.
 */
export function evalCaseFileLabel(agentName: string): string {
  if (agentName !== path.basename(agentName) || agentName === '.' || agentName === '..') {
    throw new UsageError(
      `<agent> ${JSON.stringify(agentName)} is not a file name in ${EVALS_DIRECTORY}/`,
    );
  }
  return `${EVALS_DIRECTORY}/${agentName}.yaml`;
}

/**
 * Read `evals/<agentName>.yaml` under `root` (issue #618). A missing or unreadable file, a name that
 * is not one file name, and a file the reader or `EvalCaseFileSchema` refuses are usage errors
 * naming the file (and the line and column).
 */
export async function loadEvalCases(root: string, agentName: string): Promise<EvalCaseFile> {
  const label = evalCaseFileLabel(agentName);
  let text: string;
  try {
    text = await readFile(path.join(root, label), 'utf8');
  } catch {
    throw new UsageError(`could not read ${label}: write the agent's evaluation cases there`);
  }
  try {
    return readEvalCaseFile(text, label);
  } catch (error) {
    if (error instanceof ProjectFileError) throw new UsageError(error.message);
    throw error;
  }
}
