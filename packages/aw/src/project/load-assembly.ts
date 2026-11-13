import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';
import * as define from '@indx-workspace/sdk/define';
import type { z } from 'zod';
import { deepEqual } from './diff.js';
import { localProblem, type ProjectProblem } from './problems.js';
import {
  type LoadedAgent,
  type LoadedCodeTool,
  type LoadedTool,
  type ProjectLoad,
} from './load-types.js';
import { type LoadedMessage } from './protocol.js';

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

export type LoadedAgentEntry = Extract<LoadedMessage['files'][number], { readonly tools: unknown }>;

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
export function assemble(reply: LoadedMessage, agentRefused: boolean): ProjectLoad {
  const state = collectAgents(reply, agentRefused);
  attachSurfaces(reply, state);
  return validateAgents(state);
}

function collectAgents(reply: LoadedMessage, agentRefused: boolean) {
  const problems: ProjectProblem[] = [];
  const agents = new Map<string, PendingAgent>();
  const secrets = new Set<string>();
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
  return { agents, secrets, agentFailed, problems };
}

type AssemblyState = ReturnType<typeof collectAgents>;

function attachSurfaces(reply: LoadedMessage, state: AssemblyState): void {
  const { agents, agentFailed, problems } = state;
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
}

interface ToolRegistry {
  readonly tools: Map<string, LoadedTool>;
  readonly codeTools: Map<string, LoadedCodeTool>;
  readonly problems: ProjectProblem[];
}

function registerAgentTools(pending: PendingAgent, registry: ToolRegistry): void {
  const { tools, codeTools, problems } = registry;
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
}

function validateAgents(state: AssemblyState): ProjectLoad {
  const { agents, secrets, problems } = state;
  const tools = new Map<string, LoadedTool>();
  const codeTools = new Map<string, LoadedCodeTool>();
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
      registerAgentTools(pending, { tools, codeTools, problems });
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
