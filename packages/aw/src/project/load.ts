import { realpath } from 'node:fs/promises';
import * as define from '@indx-workspace/sdk/define';
import { CommandRefusedError } from '../io.js';
import { localProblem, type ProjectProblem } from './problems.js';
import { assemble } from './load-assembly.js';
import { childEnv, runChild } from './load-child.js';
import { definitionFiles } from './load-discovery.js';
import { markdownAgents } from './load-markdown.js';
import { type LoadProjectOptions, type ProjectLoad } from './load-types.js';
import { LoadedMessageSchema, type LoadedMessage, type LoadMessage } from './protocol.js';

/** How long the child may take to evaluate every file before it is killed. */
const LOADER_TIMEOUT_MS = 30_000;

/** The file a whole-project refusal (the loader itself) is attributed to. */
const PROJECT_FILE = '.';

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
 * `agents/*.agent.md` files are read here, without the child, and join as agents (ADR-0166 D12).
 *
 * Refuses with {@link CommandRefusedError} when there is no `agents/*.ts` or `agents/*.agent.md` at
 * all, or when the child fails without an answer. Every per-file refusal is a
 * {@link ProjectProblem} instead.
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
  const markdown = await markdownAgents(options.root, rootReal, agents, options);
  if (
    agents.files.length === 0 &&
    agents.problems.length === 0 &&
    markdown.entries.length === 0 &&
    markdown.problems.length === 0
  ) {
    throw new CommandRefusedError(
      options.agentMarkdown === false
        ? 'no agents/*.ts in this directory'
        : 'no agents/*.ts or agents/*.agent.md in this directory',
      'aw init --yes',
    );
  }
  const surfaces = await definitionFiles(options.root, rootReal, 'surfaces');
  const refused = [...agents.problems, ...markdown.problems, ...surfaces.problems];
  if (agents.files.length === 0 && markdown.entries.length === 0)
    return { agents: [], problems: refused, secrets: [], tools: [], codeTools: [] };
  const request: LoadMessage = {
    type: 'load',
    root: options.root,
    agents: agents.files,
    surfaces: surfaces.files,
    ...(options.defaultEngine === undefined ? {} : { defaultEngine: options.defaultEngine }),
  };
  const answered = await loadTypeScript(request, options);
  if ('code' in answered) return emptyLoad([...refused, answered]);
  // The `.agent.md` agents join after the `.ts` ones and before the surfaces that may name them.
  const agentEntries = answered.files.filter((entry) => entry.kind === 'agent');
  const surfaceEntries = answered.files.filter((entry) => entry.kind === 'surface');
  let load: ProjectLoad;
  try {
    load = assemble(
      { type: 'loaded', files: [...agentEntries, ...markdown.entries, ...surfaceEntries] },
      agents.problems.length > 0 || markdown.problems.length > 0,
    );
  } catch (error) {
    if (error instanceof define.DefinitionError) throw malformedReply();
    throw error;
  }
  return { ...load, problems: [...refused, ...load.problems] };
}

function malformedReply(): CommandRefusedError {
  return new CommandRefusedError('the project loader answered with a malformed message');
}
export { escapes } from './load-discovery.js';
export { evalAgents, evalCaseFileLabel, loadEvalCases, soleEvalAgent } from './load-evaluations.js';
export type {
  LoadedCodeTool,
  LoadedTool,
  LoaderFeatures,
  LoadProjectOptions,
  ProjectLoad,
} from './load-types.js';

function emptyLoad(problems: readonly ProjectProblem[]): ProjectLoad {
  return { agents: [], problems, secrets: [], tools: [], codeTools: [] };
}

async function loadTypeScript(
  request: LoadMessage,
  options: LoadProjectOptions,
): Promise<LoadedMessage | ProjectProblem> {
  if (request.agents.length === 0 && request.surfaces.length === 0) {
    // Only `.agent.md` agents, which are read here: there is no code to run.
    return { type: 'loaded', files: [] };
  } else {
    const timeoutMs = options.timeoutMs ?? LOADER_TIMEOUT_MS;
    const env = await childEnv(options.io, options.withheld);
    const outcome = await runChild(request, options, env, timeoutMs);
    const problem = childProblem(outcome, timeoutMs);
    if (problem !== undefined) return problem;
    if (outcome.kind !== 'reply') throw malformedReply();
    const reply = LoadedMessageSchema.safeParse(outcome.message);
    if (!reply.success || !answersRequest(reply.data, request)) throw malformedReply();
    return reply.data;
  }
}

function childProblem(
  outcome: Awaited<ReturnType<typeof runChild>>,
  timeoutMs: number,
): ProjectProblem | undefined {
  if (outcome.kind === 'timeout')
    return localProblem(outcome.file ?? PROJECT_FILE, 'loader_timeout', [
      `the definition files did not finish loading within ${String(timeoutMs)} ms`,
    ]);
  if (outcome.kind === 'unfinished')
    return localProblem(outcome.file, 'module_unfinished', [
      `the loader exited (code ${String(outcome.code)}) while this file was evaluating: a top-level await that never settles, or process.exit()`,
    ]);
  return undefined;
}
