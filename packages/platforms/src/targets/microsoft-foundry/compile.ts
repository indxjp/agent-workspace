import { AGENT_PERMISSION_KEYS } from '@indx-workspace/contracts/agents';
import type {
  FieldVerdict,
  PlatformFile,
  PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';

import { prettyJson } from '../../json.js';
import { narrowOpenApiSpec } from '../../openapi-allow.js';
import { dropped, mapped, native } from '../../paths.js';
import type { PlatformCompileResult } from '../../port.js';
import {
  FOUNDRY_AGENT_NAME_PATTERN,
  FOUNDRY_API_VERSION,
  FoundryAgentVersionBodySchema,
  FoundryPublishPlanSchema,
  type FoundryAgentVersionBody,
  type FoundryConnection,
  type FoundryEndpointPatch,
  type FoundryOptions,
  type FoundryPublishPlan,
  type FoundryTool,
} from './wire.js';

const CONNECTION_NAME_MAX = 63;
export const TOOL_ENDPOINT_LABEL = 'aw-tools';
export const A2A_CONNECTION_PREFIX = 'aw-agent-';
const A2A_AUDIENCE = 'https://ai.azure.com';

type PortableTool = PortableAgent['tools'][number];

interface PlanState {
  readonly connections: FoundryConnection[];
  readonly openapiSpecs: FoundryPublishPlan['openapiSpecs'];
  /** Every connection name handed out, planned or manual, with what it connects to. */
  readonly reserved: Map<string, string>;
  /** The connection ids the shared aw-tools server was given, one per distinct name. */
  readonly toolEndpointConnections: Set<string>;
}

interface Mapped<TItem> {
  readonly items: readonly TItem[];
  readonly verdicts: readonly FieldVerdict[];
}

function refusal(
  code: PlatformRefusal['code'],
  message: string,
  details: readonly string[],
): PlatformCompileResult {
  return { ok: false, refusal: { code, message, details } };
}

function modelLabel(model: NonNullable<PortableAgent['model']>): string {
  return model.provider === undefined ? model.id : `${model.provider}/${model.id}`;
}

function deploymentOf(agent: PortableAgent, options: FoundryOptions): string | undefined {
  return options.modelDeployment ?? agent.model?.id;
}

/** True when a JSON Schema uses a construct Foundry rejects as "Invalid tool schema". */
function hasUnsupportedSchemaKeyword(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(hasUnsupportedSchemaKeyword);
  if (typeof schema !== 'object' || schema === null) return false;
  return Object.entries(schema).some(
    ([key, value]) =>
      key === 'anyOf' ||
      key === 'allOf' ||
      key === 'oneOf' ||
      (key === 'type' && Array.isArray(value)) ||
      hasUnsupportedSchemaKeyword(value),
  );
}

// ponytail: 32-bit FNV-1a; reserveName's collision loop still keeps every planned name unique
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A connection name over the vendor's 63 characters becomes 54 of them, `-` and 8 hex of its hash. */
export function fitConnectionName(name: string): string {
  return name.length <= CONNECTION_NAME_MAX
    ? name
    : `${name.slice(0, CONNECTION_NAME_MAX - 9)}-${fnv1a32(name)}`;
}

/**
 * Reserves a connection name for `identity` and returns the name it ended up with. A name that two
 * agents use for different targets or secrets is suffixed with the agent, so one agent's secret
 * never reaches the other agent's server. A name over the vendor limit is shortened first.
 */
function reserveName(state: PlanState, agentName: string, name: string, identity: string): string {
  const fitted = fitConnectionName(name);
  const existing = state.reserved.get(fitted);
  if (existing === undefined) {
    state.reserved.set(fitted, identity);
    return fitted;
  }
  if (existing === identity) return fitted;
  return reserveName(state, agentName, `${name}-${agentName}`, identity);
}

/** Adds a project connection to the plan and returns the name it ended up with. */
function registerConnection(
  state: PlanState,
  agentName: string,
  connection: FoundryConnection,
): string {
  const identity = JSON.stringify({ ...connection, name: undefined });
  const name = reserveName(state, agentName, connection.name, identity);
  if (!state.connections.some((candidate) => candidate.name === name)) {
    state.connections.push({ ...connection, name });
  }
  return name;
}

interface McpAuth {
  readonly scheme: 'bearer' | 'api-key' | 'oauth2';
  readonly secretRef: string;
}

type McpConnectionAuth = Extract<FoundryConnection, { kind: 'mcp' }>['auth'];

/** A bearer token is a documented `Authorization` header; the other schemes stay neutral (V6). */
function connectionAuth(auth: McpAuth): McpConnectionAuth {
  return auth.scheme === 'bearer'
    ? {
        type: 'custom-keys',
        header: 'Authorization',
        valuePrefix: 'Bearer ',
        secretRef: auth.secretRef,
      }
    : { type: auth.scheme, secretRef: auth.secretRef };
}

function heldBy(auth: McpAuth, id: string): string {
  const scheme =
    auth.scheme === 'bearer'
      ? ''
      : ` (scheme ${auth.scheme}; the publish step picks the ARM authType, V6)`;
  return `secret ${auth.secretRef} is held by project connection ${id}${scheme}`;
}

function connectMcp(
  state: PlanState,
  options: FoundryOptions,
  agentName: string,
  key: string,
  target: string,
  auth: McpAuth | undefined,
): { readonly id: string; readonly note: string } | undefined {
  if (auth === undefined) return undefined;
  const id = registerConnection(state, agentName, {
    name: options.connections?.[key] ?? (key === TOOL_ENDPOINT_LABEL ? key : `aw-${key}`),
    kind: 'mcp',
    target,
    auth: connectionAuth(auth),
  });
  return { id, note: heldBy(auth, id) };
}

function mcpTool(
  label: string,
  url: string,
  options: FoundryOptions,
  connectionId: string | undefined,
  allowedTools?: readonly string[],
): FoundryTool {
  return {
    type: 'mcp',
    // VERIFY(V4): the server_label charset is undocumented; kebab names are sent unchanged.
    // https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol
    server_label: label,
    server_url: url,
    require_approval: options.requireApproval,
    ...(allowedTools === undefined ? {} : { allowed_tools: [...allowedTools] }),
    ...(connectionId === undefined ? {} : { project_connection_id: connectionId }),
  };
}

function mapRemoteMcp(
  tool: Extract<PortableTool, { kind: 'mcp'; transport: 'streamable-http' | 'sse' }>,
  path: string,
  agent: PortableAgent,
  options: FoundryOptions,
  state: PlanState,
): Mapped<FoundryTool> {
  const connection = connectMcp(state, options, agent.name, tool.name, tool.url, tool.auth);
  const notes = [
    // VERIFY(V2): https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol
    ...(tool.transport === 'sse'
      ? ['SSE support unconfirmed (V2): the docs say only "remote"']
      : []),
    ...(connection === undefined ? [] : [connection.note]),
  ];
  return {
    items: [mcpTool(tool.name, tool.url, options, connection?.id)],
    verdicts: [
      notes.length === 0 ? native(path, 'remote MCP server') : mapped(path, notes.join('; ')),
    ],
  };
}

function mapOpenApiTool(
  tool: Extract<PortableTool, { kind: 'openapi' }>,
  path: string,
  agent: PortableAgent,
  project: PortableProject,
  options: FoundryOptions,
  state: PlanState,
): Mapped<FoundryTool> {
  const connectionId = options.connections?.[tool.name];
  const narrowed = tool.allow === undefined ? undefined : narrowOpenApiSpec(project, tool);
  if (narrowed?.ok === false) {
    return {
      items: [],
      verdicts: [dropped(path, 'permissions_unsupported', narrowed.reason)],
    };
  }
  if (narrowed === undefined) {
    state.openapiSpecs.push({ agent: agent.name, tool: tool.name, specRef: tool.specRef });
  }
  const notes = [
    narrowed === undefined
      ? 'Foundry needs the spec inline: the publish step replaces the $ref (see openapiSpecs in project.plan.json)'
      : `allow applied: the spec is inlined with ${narrowed.operations} operations`,
    'every operation needs an operationId of letters, "-" and "_"',
    ...(tool.baseUrl === undefined ? [] : ['baseUrl is not applied']),
    ...(tool.auth !== undefined && connectionId === undefined
      ? [`credential ${tool.auth.secretRef} is not carried: set connections.${tool.name}`]
      : []),
  ];
  return {
    items: [
      {
        type: 'openapi',
        openapi: {
          name: tool.name,
          spec: narrowed === undefined ? { $ref: tool.specRef } : narrowed.spec,
          auth:
            connectionId === undefined
              ? { type: 'anonymous' }
              : { type: 'connection', security_scheme: { project_connection_id: connectionId } },
        },
      },
    ],
    verdicts: [mapped(path, notes.join('; '))],
  };
}

function mapBuiltinTool(
  tool: Extract<PortableTool, { kind: 'builtin' }>,
  path: string,
): Mapped<FoundryTool> {
  switch (tool.id) {
    case 'web_search':
      return { items: [{ type: 'web_search' }], verdicts: [native(path, 'web search')] };
    case 'code_execution':
      return {
        items: [{ type: 'code_interpreter', container: { type: 'auto' } }],
        verdicts: [native(path, 'Python sandbox, no outbound network')],
      };
    case 'web_fetch':
    case 'file_access':
      return {
        items: [],
        verdicts: [dropped(path, 'builtin_unsupported', `Foundry has no direct ${tool.id} tool`)],
      };
  }
}

/** One shared MCP tool for every code tool of an agent, placed where the first code tool is. */
function mapCodeTool(
  tool: Extract<PortableTool, { kind: 'code' }>,
  path: string,
  agent: PortableAgent,
  project: PortableProject,
  options: FoundryOptions,
  state: PlanState,
  isFirst: boolean,
): Mapped<FoundryTool> {
  const endpoint = project.toolEndpoint;
  if (endpoint === undefined) {
    return {
      items: [],
      verdicts: [
        dropped(
          path,
          'code_tool_needs_public_mcp',
          'a Foundry agent reaches a code tool only through a public MCP endpoint; the project has no toolEndpoint',
        ),
      ],
    };
  }
  const warning = hasUnsupportedSchemaKeyword(tool.inputSchema)
    ? '; inputSchema uses anyOf, allOf, oneOf or a type array, which Foundry rejects as "Invalid tool schema"'
    : '';
  const verdicts = [
    mapped(path, `served by the shared ${TOOL_ENDPOINT_LABEL} MCP server${warning}`),
  ];
  if (!isFirst) return { items: [], verdicts };
  const connection = connectMcp(
    state,
    options,
    agent.name,
    TOOL_ENDPOINT_LABEL,
    endpoint.url,
    endpoint.auth,
  );
  if (connection !== undefined) state.toolEndpointConnections.add(connection.id);
  const codeToolNames = agent.tools.flatMap((candidate) =>
    candidate.kind === 'code' ? [candidate.name] : [],
  );
  return {
    items: [mcpTool(TOOL_ENDPOINT_LABEL, endpoint.url, options, connection?.id, codeToolNames)],
    verdicts,
  };
}

function mapTools(
  agent: PortableAgent,
  project: PortableProject,
  options: FoundryOptions,
  state: PlanState,
): Mapped<FoundryTool> {
  const items: FoundryTool[] = [];
  const verdicts: FieldVerdict[] = [];
  let codeToolSeen = false;
  agent.tools.forEach((tool, index) => {
    const path = `${agent.name}.tools.${index}`;
    let result: Mapped<FoundryTool>;
    switch (tool.kind) {
      case 'mcp':
        result =
          tool.transport === 'stdio'
            ? {
                items: [],
                verdicts: [
                  dropped(
                    path,
                    'stdio_mcp_unsupported',
                    'Foundry accepts only remote MCP endpoints',
                  ),
                ],
              }
            : mapRemoteMcp(tool, path, agent, options, state);
        break;
      case 'code':
        result = mapCodeTool(tool, path, agent, project, options, state, !codeToolSeen);
        codeToolSeen = true;
        break;
      case 'openapi':
        result = mapOpenApiTool(tool, path, agent, project, options, state);
        break;
      case 'builtin':
        result = mapBuiltinTool(tool, path);
        break;
    }
    items.push(...result.items);
    verdicts.push(...result.verdicts);
  });
  return { items, verdicts };
}

function mapKnowledge(agent: PortableAgent, options: FoundryOptions): Mapped<FoundryTool> {
  const vectorStore = options.vectorStores?.[agent.name];
  const verdicts = agent.knowledge.map((source, index): FieldVerdict => {
    const path = `${agent.name}.knowledge.${index}`;
    if (source.kind !== 'files') {
      return dropped(
        path,
        'knowledge_unsupported',
        `Foundry has no ${source.kind} knowledge source`,
      );
    }
    if (vectorStore === undefined) {
      return dropped(
        path,
        'knowledge_unsupported',
        `set the vectorStores option for ${agent.name} to search files`,
      );
    }
    return mapped(
      path,
      `upload the paths to vector store ${vectorStore} yourself; at most 10,000 files of 512 MB each`,
    );
  });
  const searchesFiles =
    vectorStore !== undefined && agent.knowledge.some((s) => s.kind === 'files');
  return {
    // VERIFY(V1): the Learn page shows only the SDK form; this is the Responses shape (the
    // hand-rendered fixture in __golden__/vendor-fixtures, not verified).
    // https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/file-search
    items: searchesFiles ? [{ type: 'file_search', vector_store_ids: [vectorStore] }] : [],
    verdicts,
  };
}

function mapSubagents(
  agent: PortableAgent,
  options: FoundryOptions,
  state: PlanState,
): Mapped<FoundryTool> {
  const items: FoundryTool[] = [];
  const verdicts = agent.subagents.map((subagent, index): FieldVerdict => {
    const id = registerConnection(state, agent.name, {
      name: options.connections?.[subagent.name] ?? `${A2A_CONNECTION_PREFIX}${subagent.name}`,
      kind: 'a2a',
      targetPath: `/agents/${subagent.name}/endpoint/protocols/a2a`,
      auth: { type: 'agentic-identity', audience: A2A_AUDIENCE },
    });
    items.push({ type: 'a2a', a2a_version: '1.0', project_connection_id: id });
    return mapped(
      `${agent.name}.subagents.${index}`,
      `called over A2A through project connection ${id}`,
    );
  });
  return { items, verdicts };
}

function mapPermissions(agent: PortableAgent): FieldVerdict[] {
  return AGENT_PERMISSION_KEYS.map((key) => {
    const path = `${agent.name}.permissions.${key}`;
    return agent.permissions[key]
      ? dropped(path, 'permissions_unsupported', `a prompt agent has no ${key}`)
      : mapped(path, 'a prompt agent has no file system or shell, so this holds');
  });
}

function mapModel(agent: PortableAgent, options: FoundryOptions): FieldVerdict[] {
  if (agent.model === undefined) return [];
  const note =
    options.modelDeployment === undefined
      ? "deployment name assumed equal to the model id; set extensions.platforms['microsoft-foundry'].modelDeployment"
      : 'Foundry runs a deployment, not a model id; the model is kept in metadata aw.model';
  return [mapped(`${agent.name}.model`, note)];
}

function mapRemainingFields(agent: PortableAgent, isRoot: boolean): FieldVerdict[] {
  const at = (field: string): string => `${agent.name}.${field}`;
  const verdicts: FieldVerdict[] = [native(at('instructions'), 'definition.instructions')];
  if (agent.description !== undefined) verdicts.push(native(at('description'), 'description'));
  if (agent.engine !== undefined) {
    verdicts.push(dropped(at('engine'), 'field_unsupported', 'Foundry runs its own loop'));
  }
  agent.skills.forEach((_, index) =>
    verdicts.push(
      dropped(
        at(`skills.${index}`),
        'skills_unsupported',
        'skills attach to Foundry only through a Toolbox (preview)',
      ),
    ),
  );
  const { maxTurns, maxBudgetUsd } = agent.limits ?? {};
  if (maxTurns !== undefined) {
    verdicts.push(
      dropped(at('limits.maxTurns'), 'limits_unsupported', 'Foundry has no turn limit'),
    );
  }
  if (maxBudgetUsd !== undefined) {
    verdicts.push(
      dropped(at('limits.maxBudgetUsd'), 'limits_unsupported', 'Foundry has no budget limit'),
    );
  }
  for (const id of Object.keys(agent.extensions?.engines ?? {})) {
    verdicts.push(
      dropped(at(`extensions.engines.${id}`), 'field_unsupported', 'Foundry runs its own loop'),
    );
  }
  for (const id of Object.keys(agent.extensions?.platforms ?? {})) {
    const path = at(`extensions.platforms.${id}`);
    if (id !== 'microsoft-foundry') {
      verdicts.push(dropped(path, 'field_unsupported', `options for ${id}, not for this target`));
    } else {
      verdicts.push(
        mapped(
          path,
          isRoot ? 'read as this target’s options' : 'only the root agent’s options are read',
        ),
      );
    }
  }
  return verdicts;
}

function versionBody(
  agent: PortableAgent,
  deployment: string,
  tools: readonly FoundryTool[],
): FoundryAgentVersionBody {
  return {
    ...(agent.description === undefined ? {} : { description: agent.description }),
    metadata: {
      'aw.apiVersion': agent.apiVersion,
      ...(agent.model === undefined ? {} : { 'aw.model': modelLabel(agent.model) }),
    },
    definition: {
      kind: 'prompt',
      model: deployment,
      instructions: agent.instructions,
      ...(tools.length === 0 ? {} : { tools: [...tools] }),
    },
  };
}

function endpointPatch(agent: PortableAgent): FoundryEndpointPatch {
  const description = agent.description ?? agent.name;
  return {
    agent_card: {
      description,
      version: '1.0',
      skills: [{ id: agent.name, name: agent.name, description }],
    },
    agent_endpoint: { protocol_configuration: { responses: {}, a2a: {} } },
  };
}

/** Subagents first (they must exist before a caller links them), then the rest, the root last. */
function publishOrder(project: PortableProject): readonly PortableAgent[] {
  const subagentNames = new Set(
    project.agents.flatMap((agent) => agent.subagents.map((subagent) => subagent.name)),
  );
  const others = project.agents.filter((agent) => agent.name !== project.root);
  return [
    ...others.filter((agent) => subagentNames.has(agent.name)),
    ...others.filter((agent) => !subagentNames.has(agent.name)),
    ...project.agents.filter((agent) => agent.name === project.root),
  ];
}

function toolEndpointVerdict(project: PortableProject, state: PlanState): FieldVerdict | undefined {
  const endpoint = project.toolEndpoint;
  if (endpoint === undefined) return undefined;
  const usedBy = project.agents.some((agent) => agent.tools.some((tool) => tool.kind === 'code'));
  if (!usedBy) return mapped('toolEndpoint', 'no code tool uses it');
  const name = [...state.toolEndpointConnections].join(', ');
  return mapped(
    'toolEndpoint',
    `served as the ${TOOL_ENDPOINT_LABEL} MCP server; ${heldBy(endpoint.auth, name)}`,
  );
}

function checkProject(
  project: PortableProject,
  options: FoundryOptions,
): PlatformCompileResult | undefined {
  const names = new Set(project.agents.map((agent) => agent.name));
  if (!names.has(project.root)) {
    return refusal(
      'platform_agent_not_found',
      `The root agent ${project.root} is not in the project.`,
      [project.root],
    );
  }
  const badNames = project.agents.flatMap((agent, index) =>
    FOUNDRY_AGENT_NAME_PATTERN.test(agent.name) ? [] : [`agents[${index}].name`],
  );
  if (badNames.length > 0) {
    return refusal(
      'platform_limit_exceeded',
      'A Foundry agent name has 1-63 letters, digits and inner hyphens.',
      badNames,
    );
  }
  const unknown = project.agents.flatMap((agent) =>
    agent.subagents
      .filter((sub) => !names.has(sub.name))
      .map((sub) => `${agent.name}.subagents.${sub.name}`),
  );
  if (unknown.length > 0) {
    return refusal(
      'platform_agent_not_found',
      'A subagent is not an agent of the project.',
      unknown,
    );
  }
  const noModel = project.agents.filter((agent) => deploymentOf(agent, options) === undefined);
  if (noModel.length > 0) {
    return refusal(
      'platform_options_invalid',
      'The microsoft-foundry options need a modelDeployment.',
      noModel.map((agent) => `modelDeployment: required when agent ${agent.name} has no model`),
    );
  }
  return undefined;
}

interface AgentBuild {
  readonly files: readonly PlatformFile[];
  readonly verdicts: readonly FieldVerdict[];
  readonly planEntry: FoundryPublishPlan['agents'][number];
  readonly violations: readonly string[];
}

function buildAgent(
  agent: PortableAgent,
  project: PortableProject,
  options: FoundryOptions,
  state: PlanState,
  isSubagent: boolean,
): AgentBuild {
  const tools = mapTools(agent, project, options, state);
  const knowledge = mapKnowledge(agent, options);
  const subagents = mapSubagents(agent, options, state);
  // checkProject guarantees a deployment for every agent
  const body = versionBody(agent, deploymentOf(agent, options) ?? agent.name, [
    ...tools.items,
    ...subagents.items,
    ...knowledge.items,
  ]);
  const parsed = FoundryAgentVersionBodySchema.safeParse(body);
  const version = `agents/${agent.name}.version.json`;
  const endpoint = isSubagent ? `agents/${agent.name}.endpoint.json` : undefined;
  return {
    files: [
      { path: version, content: prettyJson(body) },
      ...(endpoint === undefined
        ? []
        : [{ path: endpoint, content: prettyJson(endpointPatch(agent)) }]),
    ],
    verdicts: [
      ...mapModel(agent, options),
      ...mapPermissions(agent),
      ...tools.verdicts,
      ...knowledge.verdicts,
      ...subagents.verdicts,
      ...mapRemainingFields(agent, agent.name === project.root),
    ],
    planEntry: { name: agent.name, version, ...(endpoint === undefined ? {} : { endpoint }) },
    violations: parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${agent.name}: ${issue.path.join('.')}`),
  };
}

const V5_NOTE: FoundryPublishPlan['notes'][number] = {
  id: 'V5',
  note: 'Unconfirmed: whether a Claude deployment is accepted as a prompt agent model. Check at publish time; the translator never refuses on provider.',
  source: 'https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/model-router-agents',
};
const V6_NOTE: FoundryPublishPlan['notes'][number] = {
  id: 'V6',
  note: 'Unconfirmed: the ARM connection category and authType for an MCP connection. The A2A page shows PUT .../connections/{name}?api-version=2025-04-01-preview with authType CustomKeys and category RemoteA2A; the publish step maps custom-keys, api-key and oauth2 from the neutral auth.',
  source: 'https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/agent-to-agent',
};

function buildPlan(
  project: PortableProject,
  state: PlanState,
  builds: readonly AgentBuild[],
): FoundryPublishPlan {
  return {
    platform: 'microsoft-foundry',
    foundryApiVersion: FOUNDRY_API_VERSION,
    root: project.root,
    connections: state.connections,
    agents: builds.map((build) => build.planEntry),
    openapiSpecs: state.openapiSpecs,
    notes: [
      ...(project.agents.some((agent) => agent.model?.provider === 'anthropic') ? [V5_NOTE] : []),
      ...(state.connections.some((connection) => connection.kind === 'mcp') ? [V6_NOTE] : []),
    ],
  };
}

/** Compiles a project to Foundry prompt-agent version bodies, A2A endpoint patches and a publish plan. */
export function compileFoundry(
  project: PortableProject,
  options: FoundryOptions,
): PlatformCompileResult {
  const refused = checkProject(project, options);
  if (refused !== undefined) return refused;

  const state: PlanState = {
    connections: [],
    openapiSpecs: [],
    reserved: new Map(),
    toolEndpointConnections: new Set(),
  };
  const subagentNames = new Set(
    project.agents.flatMap((agent) => agent.subagents.map((subagent) => subagent.name)),
  );
  const builds = publishOrder(project).map((agent) =>
    buildAgent(agent, project, options, state, subagentNames.has(agent.name)),
  );
  const plan = buildPlan(project, state, builds);
  const planParsed = FoundryPublishPlanSchema.safeParse(plan);
  const violations = [
    ...builds.flatMap((build) => build.violations),
    ...(planParsed.success
      ? []
      : planParsed.error.issues.map((issue) => `plan: ${issue.path.join('.')}`)),
  ];
  if (violations.length > 0) {
    return refusal(
      'platform_limit_exceeded',
      'A Foundry request body or name is outside the vendor limits.',
      violations,
    );
  }

  const endpointVerdict = toolEndpointVerdict(project, state);
  return {
    ok: true,
    files: [
      ...builds.flatMap((build) => build.files),
      { path: 'project.plan.json', content: prettyJson(plan) },
    ],
    report: [
      ...builds.flatMap((build) => build.verdicts),
      ...(endpointVerdict === undefined ? [] : [endpointVerdict]),
    ],
  };
}
