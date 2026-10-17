import { AGENT_PERMISSION_KEYS } from '@indx-workspace/contracts/agents';
import type {
  FieldVerdict,
  PlatformFile,
  PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';
import { parse, stringify } from 'yaml';

import { prettyJson } from '../../json.js';
import { dropped, mapped, native } from '../../paths.js';
import type { PlatformCompileResult } from '../../port.js';
import { COPILOT_STUDIO_LIMITS } from './limits.js';
import { buildMcpConnector } from './mcp-connector.js';
import { schemaNameOf, slugOf } from './names.js';
import type { CopilotStudioOptions } from './options.js';
import {
  agentDocument,
  childAgentDocument,
  mcpActionDocument,
  settingsDocument,
  urlKnowledgeDocument,
  type YamlDocument,
} from './vendor-shapes.js';

const OPTIONS_ID = 'copilot-studio';
const TOOL_ENDPOINT_NAME = 'aw-tools';
const PINNING_HINT = `set extensions.platforms.${OPTIONS_ID}.modelNameHint to pin`;
const BEARER_NOTE = "enter 'Bearer <token>' when creating the connection";

type Role = 'root' | 'child' | 'unreachable';
type Refusal = Extract<PlatformCompileResult, { ok: false }>;

function refuse(
  code: PlatformRefusal['code'],
  message: string,
  details: readonly string[],
): Refusal {
  return { ok: false, refusal: { code, message, details } };
}

function toYaml(document: YamlDocument): string {
  return stringify(document, { lineWidth: 0 });
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function sameModel(a: PortableAgent['model'], b: PortableAgent['model']): boolean {
  return a?.id === b?.id && a?.provider === b?.provider;
}

type RemoteMcpTool = Extract<PortableAgent['tools'][number], { url: string }>;

function isStreamableMcp(tool: PortableAgent['tools'][number]): tool is RemoteMcpTool {
  return tool.kind === 'mcp' && tool.transport === 'streamable-http';
}

type ToolAuth = NonNullable<RemoteMcpTool['auth']>;

/** The auth when its scheme has no connector shape that can authenticate: only bearer is emitted. */
function unsupportedAuth(auth: ToolAuth | undefined): ToolAuth | undefined {
  return auth !== undefined && auth.scheme !== 'bearer' ? auth : undefined;
}

function unsupportedAuthNote(auth: ToolAuth): string {
  return `auth scheme ${auth.scheme} (secret ${auth.secretRef}) has no confirmed Power Platform connector shape; only bearer is emitted`;
}

/** A streamable-http MCP tool whose action and connector are emitted. */
function isEmittedMcp(tool: PortableAgent['tools'][number]): tool is RemoteMcpTool {
  return isStreamableMcp(tool) && unsupportedAuth(tool.auth) === undefined;
}

function codeToolNames(agent: PortableAgent): string[] {
  return agent.tools.flatMap((tool) => (tool.kind === 'code' ? [tool.name] : []));
}

function uniqueKnowledgeFilePaths(agent: PortableAgent): string[] {
  const paths = agent.knowledge.flatMap((source) => (source.kind === 'files' ? source.paths : []));
  return [...new Set(paths)];
}

function knowledgeUrls(agent: PortableAgent): string[] {
  return agent.knowledge.flatMap((source) => (source.kind === 'url' ? [source.url] : []));
}

/** The first refusal, checked in a fixed order; details carry names and numbers only. */
function refusalFor(
  project: PortableProject,
  root: PortableAgent,
  children: readonly PortableAgent[],
  options: CopilotStudioOptions,
  endpointEmitted: boolean,
): Refusal | undefined {
  const tooLong = [root, ...children].filter(
    (agent) => agent.instructions.length > COPILOT_STUDIO_LIMITS.instructionsChars,
  );
  if (tooLong.length > 0) {
    return refuse(
      'platform_limit_exceeded',
      'The instructions are longer than Copilot Studio allows.',
      tooLong.map(
        (agent) =>
          `instructionsChars: max ${COPILOT_STUDIO_LIMITS.instructionsChars}, actual ${agent.instructions.length}, agent ${agent.name}`,
      ),
    );
  }

  const filePaths = uniqueKnowledgeFilePaths(root);
  if (filePaths.length > COPILOT_STUDIO_LIMITS.uploadedFiles) {
    return refuse(
      'platform_limit_exceeded',
      'The agent has more knowledge files than Copilot Studio allows.',
      [`uploadedFiles: max ${COPILOT_STUDIO_LIMITS.uploadedFiles}, actual ${filePaths.length}`],
    );
  }
  const sources = filePaths.length + new Set(knowledgeUrls(root)).size;
  if (sources > COPILOT_STUDIO_LIMITS.knowledgeSources) {
    return refuse(
      'platform_limit_exceeded',
      'The agent has more knowledge sources than Copilot Studio allows.',
      [`knowledgeSources: max ${COPILOT_STUDIO_LIMITS.knowledgeSources}, actual ${sources}`],
    );
  }
  const topics = Object.entries(options.topics ?? {});
  if (topics.length > COPILOT_STUDIO_LIMITS.topics) {
    return refuse('platform_limit_exceeded', 'There are more topics than Copilot Studio allows.', [
      `topics: max ${COPILOT_STUDIO_LIMITS.topics}, actual ${topics.length}`,
    ]);
  }

  const invalid: string[] = [];
  for (const [stem, text] of topics) {
    let kind: unknown;
    try {
      kind = (parse(text) as { kind?: unknown } | null)?.kind;
    } catch {
      invalid.push(`topics.${stem}: is not valid YAML`);
      continue;
    }
    if (kind !== 'AdaptiveDialog') invalid.push(`topics.${stem}: kind must be AdaptiveDialog`);
  }

  const byBasename = new Map<string, string>();
  for (const path of filePaths) {
    const base = basenameOf(path);
    const earlier = byBasename.get(base);
    if (earlier !== undefined) {
      invalid.push(`knowledge files ${earlier} and ${path} share the file name ${base}`);
    }
    byBasename.set(base, path);
    if (!project.knowledgeFiles.some((file) => file.path === path)) {
      invalid.push(`knowledge file ${path} is not in the project`);
    }
  }

  const connectorProblem = (name: string, url: string): string | undefined => {
    const connector = buildMcpConnector({ name, agentName: root.name, url, secretRef: undefined });
    return connector.ok ? undefined : connector.reason;
  };
  root.tools.forEach((tool, index) => {
    if (!isEmittedMcp(tool)) return;
    const problem = connectorProblem(tool.name, tool.url);
    if (problem !== undefined) {
      invalid.push(`tools.${index}: the MCP URL of ${tool.name}: ${problem}`);
    }
    if (tool.name === TOOL_ENDPOINT_NAME && endpointEmitted) {
      invalid.push(`tools.${index}: the MCP tool name ${TOOL_ENDPOINT_NAME} is reserved`);
    }
  });
  if (endpointEmitted && project.toolEndpoint !== undefined) {
    const problem = connectorProblem(TOOL_ENDPOINT_NAME, project.toolEndpoint.url);
    if (problem !== undefined) invalid.push(`toolEndpoint: the URL: ${problem}`);
  }

  return invalid.length > 0
    ? refuse('platform_options_invalid', `The ${OPTIONS_ID} export cannot be built.`, invalid)
    : undefined;
}

function toolVerdict(
  project: PortableProject,
  agent: PortableAgent,
  role: Role,
  index: number,
): FieldVerdict {
  const path = `${agent.name}.tools.${index}`;
  const tool = agent.tools[index];
  if (tool === undefined) return dropped(path, 'field_unsupported', 'no such tool');
  const endpoint = project.toolEndpoint;

  if (tool.kind === 'mcp' && tool.transport === 'stdio') {
    return dropped(
      path,
      'stdio_mcp_unsupported',
      'Copilot Studio is hosted and cannot start a local process',
    );
  }
  if (tool.kind === 'code' && endpoint === undefined) {
    return dropped(
      path,
      'code_tool_needs_public_mcp',
      'a code tool needs the project tool endpoint (a public MCP server) to run on',
    );
  }
  if (role !== 'root') {
    return dropped(
      path,
      'subagents_unsupported',
      role === 'child'
        ? 'child-scoped tools are not emitted; widening them to the whole agent would grant the root more than it declared'
        : 'the agent is not reachable from the root agent',
    );
  }
  const endpointAuth = unsupportedAuth(endpoint?.auth);
  if (tool.kind === 'code' && endpointAuth !== undefined) {
    return dropped(
      path,
      'field_unsupported',
      `the project tool endpoint cannot be reached: ${unsupportedAuthNote(endpointAuth)}`,
    );
  }

  switch (tool.kind) {
    case 'mcp': {
      if (tool.transport === 'sse') {
        return dropped(
          path,
          'field_unsupported',
          'Copilot Studio no longer supports SSE for MCP after August 2025; use streamable-http',
        );
      }
      const unsupported = unsupportedAuth(tool.auth);
      if (unsupported !== undefined) {
        return dropped(path, 'field_unsupported', unsupportedAuthNote(unsupported));
      }
      return mapped(
        path,
        tool.auth === undefined
          ? `agent/actions/${tool.name}.mcs.yml and connectors/${tool.name}/ (a custom connector with no authentication)`
          : `agent/actions/${tool.name}.mcs.yml and connectors/${tool.name}/; secret ${tool.auth.secretRef}: ${BEARER_NOTE}`,
      );
    }
    case 'code':
      // A code tool with no endpoint was dropped with code_tool_needs_public_mcp above.
      if (endpoint === undefined) throw new Error('unreachable: code tool without an endpoint');
      return mapped(
        path,
        `served by the project tool endpoint through agent/actions/${TOOL_ENDPOINT_NAME}.mcs.yml; secret ${endpoint.auth.secretRef}: ${BEARER_NOTE}`,
      );
    case 'openapi':
      return dropped(
        path,
        'field_unsupported',
        'a Power Platform connector needs the operations, which a pure translator cannot read from specRef; expose the tool through the project public MCP endpoint or build the connector by hand',
      );
    case 'builtin':
      switch (tool.id) {
        case 'web_search':
          return mapped(path, 'agent.mcs.yml gptCapabilities.webBrowsing');
        case 'code_execution':
          return mapped(path, 'agent.mcs.yml gptCapabilities.codeInterpreter');
        case 'web_fetch':
          return dropped(
            path,
            'builtin_unsupported',
            'there is no fetch-URL capability; a URL knowledge source is the closest feature',
          );
        case 'file_access':
          return dropped(
            path,
            'builtin_unsupported',
            'the standard harness has no agent file system',
          );
      }
  }
}

function knowledgeVerdict(agent: PortableAgent, role: Role, index: number): FieldVerdict {
  const path = `${agent.name}.knowledge.${index}`;
  const source = agent.knowledge[index];
  if (source === undefined) return dropped(path, 'field_unsupported', 'no such knowledge source');
  if (role !== 'root') {
    return dropped(
      path,
      'subagents_unsupported',
      role === 'child'
        ? 'child-scoped knowledge is not emitted'
        : 'the agent is not reachable from the root agent',
    );
  }
  switch (source.kind) {
    case 'files':
      return native(
        path,
        'copied to agent/knowledge/files/; uploaded when the workspace is applied',
      );
    case 'url':
      return mapped(
        path,
        'a public-website knowledge source: a Bing-scoped site search, not a crawl',
      );
    case 'connector':
      return dropped(
        path,
        'knowledge_unsupported',
        'a project connector has no Copilot Studio knowledge equivalent',
      );
  }
}

function agentVerdicts(
  project: PortableProject,
  root: PortableAgent,
  agent: PortableAgent,
  role: Role,
  options: CopilotStudioOptions,
): FieldVerdict[] {
  const at = (field: string): string => `${agent.name}.${field}`;
  const notReachable = 'the agent is not reachable from the root agent';
  const verdicts: FieldVerdict[] = [];

  if (agent.description !== undefined) {
    verdicts.push(
      role === 'unreachable'
        ? dropped(at('description'), 'subagents_unsupported', notReachable)
        : mapped(
            at('description'),
            role === 'root'
              ? 'agent.mcs.yml mcs.metadata.description'
              : 'the beginDialog description of the child agent',
          ),
    );
  }

  verdicts.push(
    role === 'unreachable'
      ? dropped(at('instructions'), 'subagents_unsupported', notReachable)
      : role === 'root'
        ? native(at('instructions'), 'agent.mcs.yml instructions')
        : mapped(at('instructions'), 'settings.instructions of the child agent'),
  );

  if (agent.model !== undefined) {
    if (role === 'root') {
      verdicts.push(
        mapped(
          at('model'),
          options.modelNameHint === undefined
            ? `environment default model; ${PINNING_HINT}`
            : `pinned with modelNameHint ${options.modelNameHint}; a portable model id is never guessed into a hint`,
        ),
      );
    } else if (role === 'child' && sameModel(agent.model, root.model)) {
      verdicts.push(mapped(at('model'), "child agents run on the parent's model"));
    } else {
      verdicts.push(
        dropped(
          at('model'),
          'subagents_unsupported',
          role === 'child' ? "child agents run on the parent's model" : notReachable,
        ),
      );
    }
  }

  if (agent.engine !== undefined) {
    verdicts.push(
      dropped(
        at('engine'),
        'field_unsupported',
        "Copilot Studio's generative orchestrator runs the loop; generative orchestration is always on",
      ),
    );
  }

  for (const key of AGENT_PERMISSION_KEYS) {
    if (role === 'unreachable') {
      verdicts.push(dropped(at(`permissions.${key}`), 'subagents_unsupported', notReachable));
    } else if (agent.permissions[key]) {
      verdicts.push(
        dropped(
          at(`permissions.${key}`),
          'permissions_unsupported',
          'the standard harness has no file system, shell or open network egress to grant',
        ),
      );
    } else {
      verdicts.push(
        mapped(at(`permissions.${key}`), 'false holds by construction on the standard harness'),
      );
    }
  }

  agent.tools.forEach((_, index) => verdicts.push(toolVerdict(project, agent, role, index)));

  agent.skills.forEach((_, index) => {
    verdicts.push(
      role === 'root'
        ? dropped(
            at(`skills.${index}`),
            'skills_unsupported',
            'skills exist only on the GitHub Copilot harness, by UI upload; upload skills/<name>/SKILL.md by hand',
          )
        : dropped(
            at(`skills.${index}`),
            'subagents_unsupported',
            role === 'child' ? 'child-scoped skills are not emitted' : notReachable,
          ),
    );
  });

  agent.knowledge.forEach((_, index) => verdicts.push(knowledgeVerdict(agent, role, index)));

  agent.subagents.forEach((subagent, index) => {
    verdicts.push(
      role === 'root'
        ? mapped(at(`subagents.${index}`), `agent/agents/${subagent.name}/agent.mcs.yml`)
        : dropped(
            at(`subagents.${index}`),
            'subagents_unsupported',
            role === 'child' ? 'child agents do not nest' : notReachable,
          ),
    );
  });

  for (const field of ['maxTurns', 'maxBudgetUsd'] as const) {
    if (agent.limits?.[field] !== undefined) {
      verdicts.push(
        dropped(
          at(`limits.${field}`),
          'limits_unsupported',
          'Copilot Studio has no per-run turn or budget limit',
        ),
      );
    }
  }

  for (const id of Object.keys(agent.extensions?.engines ?? {})) {
    verdicts.push(
      dropped(
        at(`extensions.engines.${id}`),
        'field_unsupported',
        'engine-native settings do not apply on a platform; not emitted',
      ),
    );
  }

  for (const id of Object.keys(agent.extensions?.platforms ?? {})) {
    verdicts.push(
      id === OPTIONS_ID && role === 'root'
        ? mapped(at(`extensions.platforms.${id}`), 'read as the options of this target')
        : dropped(
            at(`extensions.platforms.${id}`),
            'field_unsupported',
            id === OPTIONS_ID
              ? 'the options are read from the root agent only'
              : `options for ${id}, not for this target`,
          ),
    );
  }

  return verdicts;
}

function roleOf(
  root: PortableAgent,
  children: readonly PortableAgent[],
  agent: PortableAgent,
): Role {
  if (agent === root) return 'root';
  return children.includes(agent) ? 'child' : 'unreachable';
}

function toolEndpointVerdict(project: PortableProject, endpointEmitted: boolean): FieldVerdict[] {
  if (project.toolEndpoint === undefined) return [];
  const unsupported = unsupportedAuth(project.toolEndpoint.auth);
  if (unsupported !== undefined) {
    return [dropped('toolEndpoint', 'field_unsupported', unsupportedAuthNote(unsupported))];
  }
  return [
    endpointEmitted
      ? mapped(
          'toolEndpoint',
          `agent/actions/${TOOL_ENDPOINT_NAME}.mcs.yml and connectors/${TOOL_ENDPOINT_NAME}/; secret ${project.toolEndpoint.auth.secretRef}: ${BEARER_NOTE}`,
        )
      : dropped('toolEndpoint', 'field_unsupported', 'no code tool of the root agent uses it'),
  ];
}

export function compileCopilotStudio(
  project: PortableProject,
  options: CopilotStudioOptions,
): PlatformCompileResult {
  const root = project.agents.find((agent) => agent.name === project.root);
  if (root === undefined) {
    return refuse(
      'platform_agent_not_found',
      `The root agent ${project.root} is not in the project.`,
      [project.root],
    );
  }
  const missing = root.subagents.filter(
    (subagent) => !project.agents.some((agent) => agent.name === subagent.name),
  );
  if (missing.length > 0) {
    return refuse(
      'platform_agent_not_found',
      'A subagent of the root agent is not in the project.',
      missing.map((subagent) => subagent.name),
    );
  }
  const children = root.subagents.flatMap((subagent) =>
    project.agents.filter((agent) => agent.name === subagent.name),
  );

  const endpoint = project.toolEndpoint;
  const rootCodeTools = codeToolNames(root);
  const endpointEmitted =
    endpoint !== undefined &&
    unsupportedAuth(endpoint.auth) === undefined &&
    rootCodeTools.length > 0;

  const refusal = refusalFor(project, root, children, options, endpointEmitted);
  if (refusal !== undefined) return refusal;

  const report = [
    ...toolEndpointVerdict(project, endpointEmitted),
    ...project.agents.flatMap((agent) =>
      agentVerdicts(project, root, agent, roleOf(root, children, agent), options),
    ),
  ];

  const schemaName = options.schemaName ?? schemaNameOf(options.publisherPrefix, root.name);
  const files: PlatformFile[] = [];
  const addYaml = (path: string, document: YamlDocument): void => {
    files.push({ path, content: toYaml(document) });
  };

  addYaml(
    'agent/agent.mcs.yml',
    agentDocument({
      name: root.name,
      description: root.description,
      instructions: root.instructions,
      modelNameHint: options.modelNameHint,
      webBrowsing: root.tools.some((tool) => tool.kind === 'builtin' && tool.id === 'web_search'),
      codeInterpreter: root.tools.some(
        (tool) => tool.kind === 'builtin' && tool.id === 'code_execution',
      ),
      conversationStarters: options.conversationStarters,
    }),
  );
  addYaml(
    'agent/settings.mcs.yml',
    settingsDocument({ name: root.name, schemaName, language: options.language }),
  );

  const addMcpServer = (
    name: string,
    url: string,
    secretRef: string | undefined,
    toolNames: readonly string[] | undefined,
  ): void => {
    const connector = buildMcpConnector({ name, agentName: root.name, url, secretRef });
    // refusalFor already refused every URL buildMcpConnector rejects.
    if (!connector.ok) throw new Error(`unreachable: connector ${name} was not refused`);
    addYaml(
      `agent/actions/${name}.mcs.yml`,
      mcpActionDocument({
        name,
        connectionReference: `${schemaName}.mcp.${name}`,
        mode: options.mcpConnectionMode,
        toolNames,
      }),
    );
    files.push(
      {
        path: `connectors/${name}/apiDefinition.swagger.json`,
        content: prettyJson(connector.swagger),
      },
      {
        path: `connectors/${name}/apiProperties.json`,
        content: prettyJson(connector.apiProperties),
      },
    );
  };
  for (const tool of root.tools) {
    if (isEmittedMcp(tool)) addMcpServer(tool.name, tool.url, tool.auth?.secretRef, undefined);
  }
  if (endpointEmitted) {
    addMcpServer(TOOL_ENDPOINT_NAME, endpoint.url, endpoint.auth.secretRef, rootCodeTools);
  }

  for (const child of children) {
    addYaml(
      `agent/agents/${child.name}/agent.mcs.yml`,
      childAgentDocument({
        name: child.name,
        description: child.description,
        instructions: child.instructions,
      }),
    );
  }

  for (const path of uniqueKnowledgeFilePaths(root)) {
    const file = project.knowledgeFiles.find((candidate) => candidate.path === path);
    if (file !== undefined) {
      files.push({ path: `agent/knowledge/files/${basenameOf(path)}`, content: file.content });
    }
  }
  const usedSlugs = new Set<string>();
  for (const url of new Set(knowledgeUrls(root))) {
    const base = slugOf(url);
    let slug = base;
    for (let n = 2; usedSlugs.has(slug); n += 1) slug = `${base}-${n}`;
    usedSlugs.add(slug);
    addYaml(`agent/knowledge/${slug}.knowledge.mcs.yml`, urlKnowledgeDocument(url));
  }

  for (const [stem, text] of Object.entries(options.topics ?? {})) {
    files.push({ path: `agent/topics/${stem}.mcs.yml`, content: text });
  }

  return { ok: true, files, report };
}
