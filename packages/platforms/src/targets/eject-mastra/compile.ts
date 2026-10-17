import {
  AGENT_PERMISSION_KEYS,
  MASTRA_TOOL_NAMES,
  MASTRA_TOOL_PERMISSION,
  type AgentPermissionKey,
} from '@indx-workspace/contracts/agents';
import type { FieldVerdict } from '@indx-workspace/contracts/platforms';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';

import { dropped, mapped, native } from '../../paths.js';
import type { PlatformCompileResult } from '../../port.js';
import {
  REQUIRE_ENV_LINES,
  agentMainSource,
  code,
  ejectAgents,
  ejectShellFiles,
  engineVerdict,
  importLine,
  lit,
  mapTools,
  modelProvider,
  nestedSubagentVerdicts,
  platformExtensionVerdicts,
  refusal,
  render,
  sharedVerdicts,
  skillFiles,
  toolEndpointVerdicts,
  unreachableVerdicts,
  type CodeValue,
  type EjectOptions,
  type McpShape,
  type ToolBuild,
} from '../eject/project.js';
import { EJECT_PINS, EJECT_SDK_PACKAGES } from '../eject/versions.js';

const TARGET_ID = 'eject-mastra';
const SKILLS_DIRECTORY = '.mastra/skills';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-5';
const PROVIDER_KEYS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as const;

type PortableTool = PortableAgent['tools'][number];

interface Build extends ToolBuild {
  readonly skillNames: Set<string>;
  readonly providers: Set<keyof typeof PROVIDER_KEYS>;
}

const MCP_SHAPE: McpShape = {
  stdio: (tool) => ({
    command: tool.command,
    ...(tool.args === undefined ? {} : { args: [...tool.args] }),
  }),
  remote: (tool, headers) => ({
    url: code(`new URL(${lit(tool.url)})`),
    requestInit: headers === undefined ? undefined : { headers },
  }),
};

/** The workspace tools a permission switch enables, by Mastra's own names. */
function toolsOf(permission: AgentPermissionKey): string[] {
  return MASTRA_TOOL_NAMES.filter((name) => MASTRA_TOOL_PERMISSION[name] === permission);
}

function enabledWorkspaceTools(agent: PortableAgent): string[] {
  return MASTRA_TOOL_NAMES.filter((name) => agent.permissions[MASTRA_TOOL_PERMISSION[name]]);
}

function mapPermissions(agent: PortableAgent): FieldVerdict[] {
  return AGENT_PERMISSION_KEYS.map((key) => {
    const path = `${agent.name}.permissions.${key}`;
    if (key === 'unrestrictedNetwork') {
      return agent.permissions[key]
        ? native(path, 'the sandbox’s network is left open')
        : mapped(path, 'LocalSandbox does not isolate the network; no web tool is offered');
    }
    const names = toolsOf(key).map((name) => name.replace('mastra_workspace_', ''));
    return native(
      path,
      agent.permissions[key]
        ? `the workspace tools ${names.join(', ')} are enabled`
        : `the workspace tools ${names.join(', ')} stay disabled`,
    );
  });
}

function mapBuiltinTool(
  tool: Extract<PortableTool, { kind: 'builtin' }>,
  path: string,
): FieldVerdict {
  switch (tool.id) {
    case 'web_search':
    case 'web_fetch':
      return dropped(path, 'builtin_unsupported', `Mastra has no built-in ${tool.id} tool`);
    case 'code_execution':
      return mapped(path, 'the workspace’s execute_command, governed by permissions.runCommands');
    case 'file_access':
      return mapped(
        path,
        'the workspace’s file tools, governed by permissions.readFiles and permissions.writeFiles',
      );
  }
}

function mapModel(agent: PortableAgent, build: Build): FieldVerdict[] {
  if (agent.model === undefined) {
    build.providers.add('anthropic');
    return [];
  }
  const provider = modelProvider(agent.model);
  if (provider === undefined) return [];
  build.providers.add(provider);
  const path = `${agent.name}.model`;
  return [
    agent.model.provider === undefined
      ? mapped(path, `the provider ${provider} is read from the model id`)
      : native(path, `routed by Mastra as ${provider}/${agent.model.id}`),
  ];
}

function modelString(agent: PortableAgent): string {
  if (agent.model === undefined) return DEFAULT_MODEL;
  return `${modelProvider(agent.model) ?? 'anthropic'}/${agent.model.id}`;
}

function mapOtherFields(agent: PortableAgent, isRoot: boolean, build: Build): FieldVerdict[] {
  const at = (field: string): string => `${agent.name}.${field}`;
  const verdicts: FieldVerdict[] = [native(at('instructions'), 'the agent’s instructions')];
  if (agent.description !== undefined) {
    verdicts.push(
      native(
        at('description'),
        isRoot
          ? 'the agent’s description and the description of package.json'
          : 'the agent’s description, which the root sees on the tool that delegates to it',
      ),
    );
  }
  verdicts.push(
    ...mapModel(agent, build),
    ...engineVerdict(agent, 'mastra', 'Mastra'),
    ...agent.skills.map((skill, index) =>
      native(
        at(`skills.${index}`),
        `copied to ${SKILLS_DIRECTORY}/${skill.name}/ and given to the agent’s workspace`,
      ),
    ),
  );
  if (agent.limits?.maxTurns !== undefined) {
    verdicts.push(native(at('limits.maxTurns'), 'defaultOptions.maxSteps'));
  }
  if (agent.limits?.maxBudgetUsd !== undefined) {
    verdicts.push(
      dropped(at('limits.maxBudgetUsd'), 'limits_unsupported', 'Mastra has no spend cap'),
    );
  }
  verdicts.push(
    ...platformExtensionVerdicts(agent, TARGET_ID, isRoot),
    ...nestedSubagentVerdicts(agent, isRoot),
  );
  return verdicts;
}

function mapSubagents(root: PortableAgent): FieldVerdict[] {
  return root.subagents.map((subagent, index) =>
    native(
      `${root.name}.subagents.${index}`,
      `emitted as an Agent in agents.${subagent.name}; it has its own workspace, tools and MCP servers`,
    ),
  );
}

function agentCall(
  agent: PortableAgent,
  isRoot: boolean,
  build: Build,
  subagentVariables: ReadonlyMap<string, string>,
): string {
  const servers = build.usedBy.get(agent.name) ?? [];
  const codeTools = agent.tools.flatMap((tool) => (tool.kind === 'code' ? [tool.name] : []));
  const tools = [
    ...(servers.length === 0 ? [] : [`...mcpTools(${render(servers)})`]),
    ...(codeTools.length === 0 ? [] : [`...codeToolsFor(${render(codeTools)})`]),
  ];
  const workspaceTools = enabledWorkspaceTools(agent);
  const skills = agent.skills.map((skill) => `${SKILLS_DIRECTORY}/${skill.name}`);
  const toolSwitches: Record<string, CodeValue> = { enabled: false };
  for (const name of workspaceTools) toolSwitches[name] = { enabled: true };
  const config: CodeValue = {
    id: agent.name,
    name: agent.name,
    description: isRoot ? agent.description : (agent.description ?? agent.name),
    instructions: agent.instructions,
    model: modelString(agent),
    tools: tools.length === 0 ? undefined : code(`{ ${tools.join(', ')} }`),
    workspace:
      workspaceTools.length === 0 && skills.length === 0
        ? undefined
        : code(
            `workspaceFor(${lit(agent.name)}, ${render(toolSwitches)}, ${render(skills)}, ${String(agent.permissions.runCommands)})`,
          ),
    agents: isRoot
      ? Object.fromEntries(
          agent.subagents.map((subagent) => [
            subagent.name,
            code(subagentVariables.get(subagent.name) ?? 'undefined'),
          ]),
        )
      : undefined,
    defaultOptions:
      agent.limits?.maxTurns === undefined ? undefined : { maxSteps: agent.limits.maxTurns },
  };
  return `new Agent(${render(config, 1)})`;
}

function agentSource(
  root: PortableAgent,
  subagents: readonly PortableAgent[],
  build: Build,
): string {
  const hasCodeTools = build.codeToolNames.length > 0;
  const hasMcp = build.servers.size > 0;
  const hasWorkspace = [root, ...subagents].some(
    (agent) => enabledWorkspaceTools(agent).length > 0 || agent.skills.length > 0,
  );
  const servers: Record<string, CodeValue> = {};
  for (const [name, server] of build.servers) servers[name] = server.config;
  const variables = new Map(subagents.map((agent, index) => [agent.name, `subagent${index}`]));
  const closers = [
    ...(hasWorkspace ? ['...workspaces.map((workspace) => workspace.destroy())'] : []),
    ...(hasMcp ? ['mcp.disconnect()'] : []),
  ];
  const lines = [
    importLine(['Agent'], EJECT_SDK_PACKAGES['mastra-agent']),
    ...(hasCodeTools ? [importLine(['createTool'], EJECT_SDK_PACKAGES['mastra-tools'])] : []),
    ...(hasWorkspace
      ? [
          importLine(
            ['LocalFilesystem', 'LocalSandbox', 'Workspace', 'type WorkspaceToolsConfig'],
            EJECT_SDK_PACKAGES['mastra-workspace'],
          ),
        ]
      : []),
    ...(hasMcp ? [importLine(['MCPClient'], EJECT_SDK_PACKAGES['mastra-mcp'])] : []),
    importLine(['fileURLToPath'], 'node:url'),
    'import path from "node:path";',
    ...(hasCodeTools ? [importLine(['loadCodeTools'], './code-tools.ts')] : []),
    '',
    'const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
    '',
    ...(build.envNames.length > 0 ? REQUIRE_ENV_LINES : []),
    ...(hasWorkspace
      ? [
          'const workspaces: Workspace[] = [];',
          '',
          'function workspaceFor(',
          '  id: string,',
          '  tools: WorkspaceToolsConfig,',
          '  skills: readonly string[],',
          '  commands: boolean,',
          '): Workspace {',
          '  const workspace = new Workspace({',
          '    id,',
          '    filesystem: new LocalFilesystem({ basePath: projectRoot }),',
          '    ...(commands ? { sandbox: new LocalSandbox({ workingDirectory: projectRoot }) } : {}),',
          '    ...(skills.length === 0 ? {} : { skills: [...skills] }),',
          '    tools,',
          '  });',
          '  workspaces.push(workspace);',
          '  return workspace;',
          '}',
          '',
        ]
      : []),
    'export async function createAgent(): Promise<{ agent: Agent; close(): Promise<void> }> {',
    ...(hasCodeTools
      ? [
          `  const codeTools = await loadCodeTools(projectRoot, ${render(build.codeToolNames, 1)}, ${lit(root.name)});`,
          '  const codeToolsFor = (names: readonly string[]) =>',
          '    Object.fromEntries(',
          '      codeTools',
          '        .filter((codeTool) => names.includes(codeTool.name))',
          '        .map((codeTool) => [',
          '          codeTool.name,',
          '          createTool({',
          '            id: codeTool.name,',
          '            description: codeTool.description,',
          '            inputSchema: codeTool.input,',
          '            execute: async (input) => codeTool.call(input),',
          '          }),',
          '        ]),',
          '    );',
        ]
      : []),
    ...(hasMcp
      ? [
          `  const mcp = new MCPClient({ id: ${lit(root.name)}, servers: ${render(servers, 1)} });`,
          '  const toolsets = await mcp.listToolsets().catch(async (error: unknown) => {',
          '    await mcp.disconnect();',
          '    throw error;',
          '  });',
          '  const mcpTools = (names: readonly string[]) =>',
          '    Object.fromEntries(',
          '      names.flatMap((server) =>',
          '        Object.entries(toolsets[server] ?? {}).map(([name, tool]) => [server + "_" + name, tool]),',
          '      ),',
          '    );',
        ]
      : []),
    ...subagents.map(
      (agent) =>
        `  const ${variables.get(agent.name) ?? ''} = ${agentCall(agent, false, build, variables)};`,
    ),
    `  const agent = ${agentCall(root, true, build, variables)};`,
    closers.length === 0
      ? '  return { agent, close: async () => {} };'
      : `  return { agent, close: async () => { await Promise.all([${closers.join(', ')}]); } };`,
    '}',
    '',
  ];
  return lines.join('\n');
}

function mainSource(root: PortableAgent): string {
  const maxSteps = root.limits?.maxTurns;
  return agentMainSource(
    [],
    [
      `const result = await agent.generate(prompt${maxSteps === undefined ? '' : `, { maxSteps: ${String(maxSteps)} }`});`,
      'console.log(result.text);',
    ],
  );
}

const README_SECTION = [
  '## Mastra',
  '',
  'The agent is a Mastra `Agent`. `src/agent.ts` exports `createAgent()`, which holds the workspace tools each permission enables, the MCP servers, the skills and the subagents; `.mastra/skills/` holds the skills.',
  'The model is routed by Mastra from `<provider>/<id>`; an agent that names none runs on `anthropic/claude-sonnet-4-5`. Set the key of each provider in `.env`.',
  'A remote MCP server is reached over streamable HTTP, with a fall back to SSE.',
].join('\n');

/** Compiles a portable project to a standalone Mastra project. */
export function compileEjectMastra(
  project: PortableProject,
  options: EjectOptions,
): PlatformCompileResult {
  const agents = ejectAgents(project);
  if (!agents.ok) return agents;
  const { root, subagents, unreachable } = agents;

  const unsupportedModels = [root, ...subagents].flatMap((agent) =>
    agent.model !== undefined && modelProvider(agent.model) === undefined
      ? [
          agent.model.provider === undefined
            ? `${agent.name}.model: no provider, and ${agent.model.id} is neither a claude nor a gpt/o model`
            : `${agent.name}.model: provider ${agent.model.provider}`,
        ]
      : [],
  );
  if (unsupportedModels.length > 0) {
    return refusal(
      'platform_model_unsupported',
      'A Mastra project in this export runs Anthropic and OpenAI models only.',
      unsupportedModels,
    );
  }

  const build: Build = {
    root: root.name,
    servers: new Map(),
    usedBy: new Map(),
    envNames: [],
    skillNames: new Set(),
    codeToolNames: [],
    providers: new Set(),
  };
  const verdicts: FieldVerdict[] = [];
  [root, ...subagents].forEach((agent) => {
    for (const skill of agent.skills) build.skillNames.add(skill.name);
    verdicts.push(
      ...mapPermissions(agent),
      ...mapTools(agent, agent === root, build, MCP_SHAPE, mapBuiltinTool),
      ...sharedVerdicts(agent, agent.name),
      ...mapOtherFields(agent, agent === root, build),
    );
  });
  verdicts.push(...mapSubagents(root));
  for (const agent of unreachable) verdicts.push(...unreachableVerdicts(agent));
  verdicts.push(...toolEndpointVerdicts(project));

  const shell = ejectShellFiles({
    engine: 'mastra',
    packageName: options.packageName ?? root.name,
    description: root.description,
    dependencies: {
      '@mastra/core': EJECT_PINS['@mastra/core'],
      zod: EJECT_PINS.zod,
      ...(build.servers.size > 0 ? { '@mastra/mcp': EJECT_PINS['@mastra/mcp'] } : {}),
    },
    envNames: [
      ...(['anthropic', 'openai'] as const)
        .filter((provider) => build.providers.has(provider))
        .map((provider) => PROVIDER_KEYS[provider]),
      ...build.envNames,
    ],
    hasCodeTools: build.codeToolNames.length > 0,
    readmeSections: [README_SECTION],
  });
  return {
    ok: true,
    files: [
      ...shell,
      { path: 'src/agent.ts', content: agentSource(root, subagents, build) },
      { path: 'src/main.ts', content: mainSource(root) },
      ...skillFiles(project, build.skillNames, SKILLS_DIRECTORY),
    ],
    report: verdicts,
  };
}
