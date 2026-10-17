import { AGENT_PERMISSION_KEYS } from '@indx-workspace/contracts/agents';
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
  toolEndpointVerdicts,
  unreachableVerdicts,
  type CodeValue,
  type EjectOptions,
  type McpShape,
  type ToolBuild,
} from '../eject/project.js';
import { EJECT_PINS, EJECT_SDK_PACKAGES } from '../eject/versions.js';

const TARGET_ID = 'eject-openai-agents';
const SDK_PACKAGE = EJECT_SDK_PACKAGES['openai-agents'];
const PROVIDER_KEYS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as const;
const FILE_OR_SHELL_TOOLS =
  'the OpenAI Agents SDK has no file or shell tool; add one with tool() in src/agent.ts';

type PortableTool = PortableAgent['tools'][number];
type Provider = keyof typeof PROVIDER_KEYS;
type BuiltinTool = Extract<PortableTool, { kind: 'builtin' }>;

interface Build extends ToolBuild {
  readonly providers: Set<Provider>;
  /** The MCP server classes the servers use. */
  readonly serverClasses: Set<string>;
}

function mcpShape(build: Build): McpShape {
  const serverClass = (name: string): string => {
    build.serverClasses.add(name);
    return name;
  };
  return {
    stdio: (tool, name) =>
      code(
        `new ${serverClass('MCPServerStdio')}(${render({
          name,
          command: tool.command,
          args: tool.args === undefined ? undefined : [...tool.args],
        })})`,
      ),
    remote: (tool, headers, name) =>
      code(
        `new ${serverClass(tool.transport === 'sse' ? 'MCPServerSSE' : 'MCPServerStreamableHttp')}(${render(
          {
            name,
            url: tool.url,
            requestInit: headers === undefined ? undefined : { headers },
          },
        )})`,
      ),
  };
}

/** Whose model the agent runs: the one it names, or the SDK’s default, which is OpenAI’s. */
function providerOf(agent: PortableAgent): Provider | undefined {
  const model = agent.model;
  if (model === undefined) return 'openai';
  if (model.provider === undefined && !model.id.startsWith('claude-')) return 'openai';
  return modelProvider(model);
}

/** A hosted tool runs on OpenAI’s side, so only for an OpenAI model; web search also needs the network. */
function hostedTool(agent: PortableAgent, tool: BuiltinTool): string | undefined {
  if (providerOf(agent) !== 'openai') return undefined;
  if (tool.id === 'web_search') {
    return agent.permissions.unrestrictedNetwork ? 'webSearchTool()' : undefined;
  }
  return tool.id === 'code_execution' ? 'codeInterpreterTool()' : undefined;
}

function mapPermissions(agent: PortableAgent): FieldVerdict[] {
  return AGENT_PERMISSION_KEYS.map((key) => {
    const path = `${agent.name}.permissions.${key}`;
    if (key === 'unrestrictedNetwork') {
      return agent.permissions[key]
        ? native(path, 'nothing restricts the network of the process')
        : mapped(path, 'the process network is not isolated; no hosted web tool is offered');
    }
    return agent.permissions[key]
      ? dropped(path, 'permissions_unsupported', FILE_OR_SHELL_TOOLS)
      : native(path, 'no tool that needs it is offered');
  });
}

function mapBuiltinTool(agent: PortableAgent, tool: BuiltinTool, path: string): FieldVerdict {
  const hosted = hostedTool(agent, tool);
  if (hosted !== undefined) return mapped(path, `${hosted}, a tool OpenAI hosts`);
  if (tool.id === 'web_search' && providerOf(agent) === 'openai') {
    return dropped(
      path,
      'permissions_unsupported',
      'webSearchTool() is not offered because permissions.unrestrictedNetwork is false',
    );
  }
  return dropped(
    path,
    'builtin_unsupported',
    tool.id === 'web_search' || tool.id === 'code_execution'
      ? 'a hosted tool runs on OpenAI’s side, so this agent’s model cannot use it'
      : `the OpenAI Agents SDK has no ${tool.id} tool`,
  );
}

function mapModel(agent: PortableAgent, build: Build): FieldVerdict[] {
  const provider = providerOf(agent);
  if (provider === undefined) return [];
  build.providers.add(provider);
  if (agent.model === undefined) return [];
  const path = `${agent.name}.model`;
  return [
    provider === 'openai'
      ? native(path, 'the model of the run')
      : mapped(
          path,
          'run through the AI SDK adapter (@openai/agents-extensions) on @ai-sdk/anthropic',
        ),
  ];
}

function mapOtherFields(agent: PortableAgent, isRoot: boolean, build: Build): FieldVerdict[] {
  const at = (field: string): string => `${agent.name}.${field}`;
  const verdicts: FieldVerdict[] = [native(at('instructions'), 'the agent’s instructions')];
  if (agent.description !== undefined) {
    verdicts.push(
      isRoot
        ? mapped(at('description'), 'the description of package.json')
        : native(at('description'), 'the handoff description, which the root sees'),
    );
  }
  verdicts.push(
    ...mapModel(agent, build),
    ...engineVerdict(agent, 'openai-agents', 'the OpenAI Agents SDK'),
    ...agent.skills.map((_, index) =>
      dropped(at(`skills.${index}`), 'skills_unsupported', 'the OpenAI Agents SDK has no skills'),
    ),
  );
  if (agent.limits?.maxTurns !== undefined) {
    verdicts.push(
      isRoot
        ? native(at('limits.maxTurns'), 'maxTurns of run()')
        : dropped(
            at('limits.maxTurns'),
            'limits_unsupported',
            'the maxTurns of the run covers the turns of a handoff',
          ),
    );
  }
  if (agent.limits?.maxBudgetUsd !== undefined) {
    verdicts.push(
      dropped(
        at('limits.maxBudgetUsd'),
        'limits_unsupported',
        'the OpenAI Agents SDK has no spend cap',
      ),
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
    mapped(
      `${root.name}.subagents.${index}`,
      `emitted as a handoff to ${subagent.name}; the conversation moves to it and does not return to the root`,
    ),
  );
}

function modelCode(agent: PortableAgent, id: string): CodeValue {
  return providerOf(agent) === 'anthropic' ? code(`aisdk(anthropic(${lit(id)}))`) : id;
}

function agentCall(
  agent: PortableAgent,
  isRoot: boolean,
  build: Build,
  subagentVariables: ReadonlyMap<string, string>,
): string {
  const servers = build.usedBy.get(agent.name) ?? [];
  const hosted = agent.tools.flatMap((tool) => {
    const call = tool.kind === 'builtin' ? hostedTool(agent, tool) : undefined;
    return call === undefined ? [] : [call];
  });
  const codeTools = agent.tools.flatMap((tool) => (tool.kind === 'code' ? [tool.name] : []));
  const tools = [
    ...hosted,
    ...(codeTools.length === 0 ? [] : [`...codeToolsFor(${render(codeTools)})`]),
  ];
  const config: CodeValue = {
    name: agent.name,
    instructions: agent.instructions,
    handoffDescription: isRoot ? undefined : (agent.description ?? agent.name),
    model: agent.model === undefined ? undefined : modelCode(agent, agent.model.id),
    tools: tools.length === 0 ? undefined : tools.map((call) => code(call)),
    mcpServers:
      servers.length === 0 ? undefined : servers.map((name) => code(`servers[${lit(name)}]`)),
    handoffs: isRoot
      ? agent.subagents.map((subagent) => code(subagentVariables.get(subagent.name) ?? ''))
      : undefined,
  };
  return `new Agent(${render(config, 1)})`;
}

function agentSource(
  root: PortableAgent,
  subagents: readonly PortableAgent[],
  build: Build,
): string {
  const everyone = [root, ...subagents];
  const hasCodeTools = build.codeToolNames.length > 0;
  const hasMcp = build.servers.size > 0;
  const hosted = new Set(
    everyone.flatMap((agent) =>
      agent.tools.flatMap((tool) => {
        const call = tool.kind === 'builtin' ? hostedTool(agent, tool) : undefined;
        return call === undefined ? [] : [call.replace('()', '')];
      }),
    ),
  );
  const servers: Record<string, CodeValue> = {};
  for (const [name, server] of build.servers) servers[name] = server.config;
  const variables = new Map(subagents.map((agent, index) => [agent.name, `subagent${index}`]));
  const anthropic = build.providers.has('anthropic');
  const lines = [
    importLine(
      [
        'Agent',
        ...[...build.serverClasses].sort(),
        ...[...hosted].sort(),
        ...(hasCodeTools ? ['tool'] : []),
      ],
      SDK_PACKAGE,
    ),
    ...(anthropic
      ? [
          importLine(['aisdk'], EJECT_SDK_PACKAGES['openai-agents-ai-sdk']),
          importLine(['anthropic'], EJECT_SDK_PACKAGES['ai-sdk-anthropic']),
        ]
      : []),
    importLine(['fileURLToPath'], 'node:url'),
    'import path from "node:path";',
    ...(hasCodeTools ? [importLine(['loadCodeTools'], './code-tools.ts')] : []),
    '',
    'const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
    '',
    ...(build.envNames.length > 0 ? REQUIRE_ENV_LINES : []),
    'export async function createAgent(): Promise<{ agent: Agent; close(): Promise<void> }> {',
    ...(hasCodeTools
      ? [
          `  const codeTools = await loadCodeTools(projectRoot, ${render(build.codeToolNames, 1)}, ${lit(root.name)});`,
          '  const codeToolsFor = (names: readonly string[]) =>',
          '    codeTools',
          '      .filter((codeTool) => names.includes(codeTool.name))',
          '      .map((codeTool) =>',
          '        tool({',
          '          name: codeTool.name,',
          '          description: codeTool.description,',
          '          parameters: codeTool.input,',
          '          execute: async (input) => JSON.stringify(await codeTool.call(input)) ?? "null",',
          '        }),',
          '      );',
        ]
      : []),
    ...(hasMcp
      ? [
          `  const servers = ${render(servers, 1)};`,
          '  const connected = Object.values(servers);',
          '  try {',
          '    await Promise.all(connected.map((server) => server.connect()));',
          '  } catch (error) {',
          '    await Promise.allSettled(connected.map((server) => server.close()));',
          '    throw error;',
          '  }',
        ]
      : []),
    ...subagents.map(
      (agent) =>
        `  const ${variables.get(agent.name) ?? ''} = ${agentCall(agent, false, build, variables)};`,
    ),
    `  const agent = ${agentCall(root, true, build, variables)};`,
    hasMcp
      ? '  return { agent, close: async () => { await Promise.all(connected.map((server) => server.close())); } };'
      : '  return { agent, close: async () => {} };',
    '}',
    '',
  ];
  return lines.join('\n');
}

function mainSource(root: PortableAgent): string {
  const maxTurns = root.limits?.maxTurns;
  return agentMainSource(
    [importLine(['run'], SDK_PACKAGE)],
    [
      `const result = await run(agent, prompt${maxTurns === undefined ? '' : `, { maxTurns: ${String(maxTurns)} }`});`,
      'console.log(result.finalOutput);',
    ],
  );
}

const README_SECTION = [
  '## OpenAI Agents SDK',
  '',
  'The agent runs through `run()` of the OpenAI Agents SDK. `src/agent.ts` exports `createAgent()`, which holds the models, MCP servers, code tools and handoffs.',
  'The SDK has no file or shell tool and no skills, so the agent has neither; add a file or shell tool with `tool()` where the report asks for one.',
  'A subagent is a handoff: the conversation moves to it and does not return to the root agent.',
].join('\n');

/** Compiles a portable project to a standalone OpenAI Agents SDK project. */
export function compileEjectOpenAiAgents(
  project: PortableProject,
  options: EjectOptions,
): PlatformCompileResult {
  const agents = ejectAgents(project);
  if (!agents.ok) return agents;
  const { root, subagents, unreachable } = agents;

  const unsupportedModels = [root, ...subagents].flatMap((agent) =>
    providerOf(agent) === undefined
      ? [`${agent.name}.model: provider ${agent.model?.provider}`]
      : [],
  );
  if (unsupportedModels.length > 0) {
    return refusal(
      'platform_model_unsupported',
      'An OpenAI Agents SDK project in this export runs OpenAI and Anthropic models only.',
      unsupportedModels,
    );
  }

  const build: Build = {
    root: root.name,
    servers: new Map(),
    usedBy: new Map(),
    envNames: [],
    codeToolNames: [],
    providers: new Set(),
    serverClasses: new Set(),
  };
  const shape = mcpShape(build);
  const verdicts: FieldVerdict[] = [];
  for (const agent of [root, ...subagents]) {
    verdicts.push(
      ...mapPermissions(agent),
      ...mapTools(agent, agent === root, build, shape, (tool, path) =>
        mapBuiltinTool(agent, tool, path),
      ),
      ...sharedVerdicts(agent, agent.name),
      ...mapOtherFields(agent, agent === root, build),
    );
  }
  verdicts.push(...mapSubagents(root));
  for (const agent of unreachable) verdicts.push(...unreachableVerdicts(agent));
  verdicts.push(...toolEndpointVerdicts(project));

  const shell = ejectShellFiles({
    engine: 'openai-agents',
    packageName: options.packageName ?? root.name,
    description: root.description,
    dependencies: {
      '@openai/agents': EJECT_PINS['@openai/agents'],
      zod: EJECT_PINS.zod,
      ...(build.providers.has('anthropic')
        ? {
            '@ai-sdk/anthropic': EJECT_PINS['@ai-sdk/anthropic'],
            '@openai/agents-extensions': EJECT_PINS['@openai/agents-extensions'],
          }
        : {}),
    },
    envNames: [
      ...(['openai', 'anthropic'] as const)
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
    ],
    report: verdicts,
  };
}
