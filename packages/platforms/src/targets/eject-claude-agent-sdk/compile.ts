import { AGENT_PERMISSION_KEYS, claudeDeniedToolsFor } from '@indx-workspace/contracts/agents';
import type { FieldVerdict } from '@indx-workspace/contracts/platforms';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';

import { dropped, mapped, native } from '../../paths.js';
import type { PlatformCompileResult } from '../../port.js';
import {
  MAIN_PROMPT_LINES,
  REQUIRE_ENV_LINES,
  code,
  ejectAgents,
  ejectShellFiles,
  engineVerdict,
  importLine,
  lit,
  mapTools,
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

const TARGET_ID = 'eject-claude-agent-sdk';
const SDK_PACKAGE = EJECT_SDK_PACKAGES['claude-agent-sdk'];
const CODE_TOOLS_SERVER = 'code-tools';
const ROOT_DENIES =
  'the root agent denies it, and the root’s disallowedTools apply to its subagents';

type PortableTool = PortableAgent['tools'][number];

interface Build extends ToolBuild {
  readonly skillNames: Set<string>;
}

const MCP_SHAPE: McpShape = {
  stdio: (tool) => ({
    type: 'stdio',
    command: tool.command,
    ...(tool.args === undefined ? {} : { args: [...tool.args] }),
  }),
  remote: (tool, headers) => ({
    type: tool.transport === 'sse' ? 'sse' : 'http',
    url: tool.url,
    headers,
  }),
};

function mapBuiltinTool(
  tool: Extract<PortableTool, { kind: 'builtin' }>,
  path: string,
  agent: PortableAgent,
  root: PortableAgent,
): FieldVerdict {
  switch (tool.id) {
    case 'web_search':
    case 'web_fetch': {
      const claudeTool = tool.id === 'web_search' ? 'WebSearch' : 'WebFetch';
      if (!agent.permissions.unrestrictedNetwork) {
        return dropped(
          path,
          'permissions_unsupported',
          `${claudeTool} is in disallowedTools because permissions.unrestrictedNetwork is false`,
        );
      }
      return root.permissions.unrestrictedNetwork
        ? native(path, `Claude Code's ${claudeTool}`)
        : dropped(path, 'permissions_unsupported', ROOT_DENIES);
    }
    case 'code_execution':
      return mapped(path, 'Claude Code’s Bash, governed by permissions.runCommands');
    case 'file_access':
      return mapped(
        path,
        'Claude Code’s Read, Write and Edit, governed by permissions.readFiles and permissions.writeFiles',
      );
  }
}

function mapPermissions(agent: PortableAgent, root: PortableAgent): FieldVerdict[] {
  return AGENT_PERMISSION_KEYS.map((key) => {
    const path = `${agent.name}.permissions.${key}`;
    if (agent.permissions[key] && !root.permissions[key]) {
      return dropped(path, 'permissions_unsupported', ROOT_DENIES);
    }
    if (key === 'unrestrictedNetwork' && !agent.permissions[key]) {
      return mapped(
        path,
        'WebFetch and WebSearch are removed; the process network is not isolated',
      );
    }
    return native(
      path,
      agent.permissions[key]
        ? 'the tools it governs are allowed'
        : 'the tools it governs are listed in disallowedTools',
    );
  });
}

function mapOtherFields(agent: PortableAgent, isRoot: boolean): FieldVerdict[] {
  const at = (field: string): string => `${agent.name}.${field}`;
  const verdicts: FieldVerdict[] = [
    native(
      at('instructions'),
      agent.instructions.trim() === ''
        ? 'empty, so no system prompt is appended'
        : isRoot
          ? 'appended to the claude_code system prompt'
          : 'the subagent’s prompt',
    ),
  ];
  if (agent.description !== undefined) {
    verdicts.push(
      isRoot
        ? mapped(at('description'), 'the description of package.json')
        : native(at('description'), 'the subagent’s description'),
    );
  }
  if (agent.model !== undefined) verdicts.push(native(at('model'), 'model'));
  verdicts.push(...engineVerdict(agent, 'claude-agent-sdk', 'the Claude Agent SDK'));
  agent.skills.forEach((skill, index) =>
    verdicts.push(
      native(
        at(`skills.${index}`),
        `copied to .claude/skills/${skill.name}/ and enabled by skills`,
      ),
    ),
  );
  if (agent.limits?.maxTurns !== undefined) {
    verdicts.push(native(at('limits.maxTurns'), 'maxTurns'));
  }
  if (agent.limits?.maxBudgetUsd !== undefined) {
    verdicts.push(
      isRoot
        ? native(at('limits.maxBudgetUsd'), 'maxBudgetUsd')
        : dropped(
            at('limits.maxBudgetUsd'),
            'limits_unsupported',
            'the SDK budgets the whole run, not a subagent',
          ),
    );
  }
  verdicts.push(
    ...platformExtensionVerdicts(agent, TARGET_ID, isRoot),
    ...nestedSubagentVerdicts(agent, isRoot),
  );
  return verdicts;
}

function modelOf(agent: PortableAgent): string | undefined {
  return agent.model === undefined ? undefined : agent.model.id;
}

function subagentDefinition(agent: PortableAgent, build: Build): CodeValue {
  const denied = claudeDeniedToolsFor(agent.permissions);
  const rootServers = build.usedBy.get(build.root) ?? [];
  const mcpServers = (build.usedBy.get(agent.name) ?? []).flatMap((name) => {
    const server = build.servers.get(name);
    if (server === undefined) return [];
    return [rootServers.includes(name) ? name : { [name]: server.config }];
  });
  return {
    description: agent.description ?? agent.name,
    prompt: agent.instructions,
    disallowedTools: denied.length === 0 ? undefined : [...denied],
    model: modelOf(agent),
    skills: agent.skills.length === 0 ? undefined : agent.skills.map((skill) => skill.name),
    mcpServers: mcpServers.length === 0 ? undefined : mcpServers,
    maxTurns: agent.limits?.maxTurns,
  };
}

function mapSubagents(root: PortableAgent): FieldVerdict[] {
  return root.subagents.map((subagent, index) =>
    mapped(
      `${root.name}.subagents.${index}`,
      `emitted as agents.${subagent.name}; it inherits the root’s tools, minus those its own permissions deny, and its own MCP servers are listed in its mcpServers`,
    ),
  );
}

function agentSource(
  root: PortableAgent,
  subagents: readonly PortableAgent[],
  build: Build,
): string {
  const hasCodeTools = build.codeToolNames.length > 0;
  const servers: Record<string, CodeValue> = {};
  for (const name of build.usedBy.get(root.name) ?? []) {
    const server = build.servers.get(name);
    if (server !== undefined) servers[name] = server.config;
  }
  if (hasCodeTools) servers[CODE_TOOLS_SERVER] = code('codeToolsServer(codeTools)');
  const allowed = [...build.servers.keys(), ...(hasCodeTools ? [CODE_TOOLS_SERVER] : [])]
    .sort()
    .map((name) => `mcp__${name}__*`);
  const denied = claudeDeniedToolsFor(root.permissions);
  const agents: Record<string, CodeValue> = {};
  for (const subagent of subagents) agents[subagent.name] = subagentDefinition(subagent, build);
  const options: CodeValue = {
    cwd: code('projectRoot'),
    model: modelOf(root),
    systemPrompt:
      root.instructions.trim() === ''
        ? undefined
        : { type: 'preset', preset: 'claude_code', append: root.instructions },
    tools: { type: 'preset', preset: 'claude_code' },
    disallowedTools: [...denied],
    allowedTools: allowed,
    permissionMode: 'default',
    settingSources: ['project'],
    strictMcpConfig: true,
    mcpServers: servers,
    skills: root.skills.map((skill) => skill.name),
    agents: subagents.length === 0 ? undefined : agents,
    maxTurns: root.limits?.maxTurns,
    maxBudgetUsd: root.limits?.maxBudgetUsd,
  };
  const usesSecrets = build.envNames.length > 0;
  const lines = [
    hasCodeTools
      ? importLine(['createSdkMcpServer', 'tool', 'type Options'], SDK_PACKAGE)
      : `import type { Options } from ${lit(SDK_PACKAGE)};`,
    importLine(['fileURLToPath'], 'node:url'),
    'import path from "node:path";',
    ...(hasCodeTools
      ? [importLine(['loadCodeTools', 'type LoadedCodeTool'], './code-tools.ts')]
      : []),
    '',
    'const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
    '',
    ...(usesSecrets ? REQUIRE_ENV_LINES : []),
    ...(hasCodeTools
      ? [
          'function codeToolsServer(codeTools: readonly LoadedCodeTool[]) {',
          '  return createSdkMcpServer({',
          `    name: ${lit(CODE_TOOLS_SERVER)},`,
          '    version: "1.0.0",',
          '    tools: codeTools.map((codeTool) =>',
          '      tool(codeTool.name, codeTool.description, codeTool.input.shape, async (args) => ({',
          '        content: [',
          '          { type: "text", text: JSON.stringify(await codeTool.call(args)) ?? "null" },',
          '        ],',
          '      })),',
          '    ),',
          '  });',
          '}',
          '',
        ]
      : []),
    'export async function agentOptions(): Promise<Options> {',
    ...(hasCodeTools
      ? [
          `  const codeTools = await loadCodeTools(projectRoot, ${render(build.codeToolNames, 1)}, ${lit(root.name)});`,
        ]
      : []),
    `  const options: Options = ${render(options, 1)};`,
    '  return options;',
    '}',
    '',
  ];
  return lines.join('\n');
}

function mainSource(): string {
  return [
    importLine(['query'], SDK_PACKAGE),
    '',
    'import { agentOptions } from "./agent.ts";',
    '',
    ...MAIN_PROMPT_LINES,
    'try {',
    '  const options = await agentOptions();',
    '  for await (const message of query({ prompt, options })) {',
    '    if (message.type !== "result") continue;',
    '    if (message.subtype === "success") {',
    '      console.log(message.result);',
    '    } else {',
    '      throw new Error(message.errors.join("; ") || message.subtype);',
    '    }',
    '  }',
    '} catch (error) {',
    '  console.error(error instanceof Error ? error.message : String(error));',
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
}

const README_SECTION = [
  '## Claude Agent SDK',
  '',
  'The agent runs through `query()` of the Claude Agent SDK. `src/agent.ts` exports `agentOptions()`, which holds the permissions, MCP servers, skills and subagents; `.claude/skills/` holds the skills.',
  'Set `ANTHROPIC_API_KEY` in `.env`.',
].join('\n');

/** Compiles a portable project to a standalone Claude Agent SDK project. */
export function compileEjectClaude(
  project: PortableProject,
  options: EjectOptions,
): PlatformCompileResult {
  const agents = ejectAgents(project);
  if (!agents.ok) return agents;
  const { root, subagents, unreachable } = agents;

  const unsupportedModels = [root, ...subagents].flatMap((agent) =>
    agent.model?.provider !== undefined && agent.model.provider !== 'anthropic'
      ? [`${agent.name}.model: provider ${agent.model.provider}`]
      : [],
  );
  if (unsupportedModels.length > 0) {
    return refusal(
      'platform_model_unsupported',
      'The Claude Agent SDK runs Anthropic models only.',
      unsupportedModels,
    );
  }

  const build: Build = {
    reserved: CODE_TOOLS_SERVER,
    root: root.name,
    servers: new Map(),
    usedBy: new Map(),
    envNames: [],
    skillNames: new Set(),
    codeToolNames: [],
  };
  const verdicts: FieldVerdict[] = [];
  [root, ...subagents].forEach((agent) => {
    for (const skill of agent.skills) build.skillNames.add(skill.name);
    verdicts.push(
      ...mapPermissions(agent, root),
      ...mapTools(agent, agent === root, build, MCP_SHAPE, (tool, path) =>
        mapBuiltinTool(tool, path, agent, root),
      ),
      ...sharedVerdicts(agent, agent.name),
      ...mapOtherFields(agent, agent === root),
    );
  });
  verdicts.push(...mapSubagents(root));
  for (const agent of unreachable) verdicts.push(...unreachableVerdicts(agent));
  verdicts.push(...toolEndpointVerdicts(project));

  const hasCodeTools = build.codeToolNames.length > 0;
  const shell = ejectShellFiles({
    engine: 'claude-agent-sdk',
    packageName: options.packageName ?? root.name,
    description: root.description,
    dependencies: { [SDK_PACKAGE]: EJECT_PINS[SDK_PACKAGE] },
    envNames: ['ANTHROPIC_API_KEY', ...build.envNames],
    hasCodeTools,
    readmeSections: [README_SECTION],
  });
  return {
    ok: true,
    files: [
      ...shell,
      { path: 'src/agent.ts', content: agentSource(root, subagents, build) },
      { path: 'src/main.ts', content: mainSource() },
      ...skillFiles(project, build.skillNames, '.claude/skills'),
    ],
    report: verdicts,
  };
}
