import { AGENT_PERMISSION_KEYS } from '@indx-workspace/contracts/agents';
import type {
  FieldVerdict,
  PlatformFile,
  PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';
import { stringify } from 'yaml';

import { dropped, mapped, native } from '../../paths.js';
import type { PlatformCompileResult } from '../../port.js';
import type { ClaudeManagedAgentsOptions } from './options.js';

export const AGENT_TOOLSET_TYPE = 'agent_toolset_20260401';
export const MULTIAGENT_TYPE = 'multiagent_20261001';
export const MAX_MCP_SERVERS_PER_AGENT = 20;
export const MAX_PREDEFINED_AGENTS = 20;
export const MCP_SERVER_URL_MAX_LENGTH = 2048;
export const MCP_SERVER_NAME_MAX_LENGTH = 255;
/** The MCP server name the project's public tool endpoint (D5/T1b) is emitted under. */
export const AW_TOOLS_SERVER_NAME = 'aw-tools';
export const CREDENTIAL_PLAN_FILE = 'aw-vault-credentials.json';

const PLATFORM_ID = 'claude-managed-agents';
const ENVIRONMENT_FILE = 'environments/default.yaml';
const ENVIRONMENT_SCHEMA = 'https://platform.claude.com/schemas/ant/beta/environment.json';
const VAULT_SCHEMA = 'https://platform.claude.com/schemas/ant/beta/vault.json';
const NAME_IN_MESSAGE_MAX = 64;

export const TOOLSET_ORDER = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
] as const;
export type ToolsetTool = (typeof TOOLSET_ORDER)[number];

export const READ_TOOLS: readonly ToolsetTool[] = ['read', 'glob', 'grep'];
export const WRITE_TOOLS: readonly ToolsetTool[] = ['write', 'edit'];

type Plain = Record<string, unknown>;
type RemoteMcpTool = Extract<PortableAgent['tools'][number], { kind: 'mcp' }> & {
  readonly transport: 'streamable-http' | 'sse';
};

interface McpServer {
  readonly name: string;
  readonly url: string;
  readonly secretRef: string | undefined;
}

function refuse(code: PlatformRefusal['code'], message: string): PlatformCompileResult {
  return { ok: false, refusal: { code, message, details: [] } };
}

function clip(text: string): string {
  return text.length > NAME_IN_MESSAGE_MAX ? `${text.slice(0, NAME_IN_MESSAGE_MAX)}…` : text;
}

function remoteMcpTools(agent: PortableAgent): RemoteMcpTool[] {
  return agent.tools.filter(
    (tool): tool is RemoteMcpTool => tool.kind === 'mcp' && tool.transport !== 'stdio',
  );
}

function hasCodeTools(agent: PortableAgent): boolean {
  return agent.tools.some((tool) => tool.kind === 'code');
}

/** Whether the agent gets the `aw-tools` server: it has code tools and the project has an endpoint. */
function usesToolEndpoint(project: PortableProject, agent: PortableAgent): boolean {
  return project.toolEndpoint !== undefined && hasCodeTools(agent);
}

function serversOf(project: PortableProject, agent: PortableAgent): McpServer[] {
  const servers: McpServer[] = remoteMcpTools(agent).map((tool) => ({
    name: tool.name,
    url: tool.url,
    secretRef: tool.auth?.secretRef,
  }));
  if (project.toolEndpoint !== undefined && usesToolEndpoint(project, agent)) {
    servers.push({
      name: AW_TOOLS_SERVER_NAME,
      url: project.toolEndpoint.url,
      secretRef: project.toolEndpoint.auth.secretRef,
    });
  }
  return servers;
}

function modelUnsupported(
  agent: PortableAgent,
  options: ClaudeManagedAgentsOptions,
): PlatformCompileResult | undefined {
  const override = options.model?.id;
  const id = override ?? agent.model?.id;
  const provider = override === undefined ? agent.model?.provider : undefined;
  if (id !== undefined && id.startsWith('claude-') && (provider ?? 'anthropic') === 'anthropic') {
    return undefined;
  }
  return refuse(
    'platform_model_unsupported',
    `Claude Managed Agents runs Claude models only (claude-*, Claude 4.5 or later); "${clip(agent.name)}" uses "${clip(id ?? '(no model)')}"`,
  );
}

type Checked =
  | { readonly ok: false; readonly refusal: PlatformCompileResult }
  | { readonly ok: true; readonly root: PortableAgent; readonly emitted: readonly PortableAgent[] };

/** Every refusal, in the order of the issue's table; the first one wins. */
function refusalFor(project: PortableProject, options: ClaudeManagedAgentsOptions): Checked {
  const byName = new Map(project.agents.map((agent) => [agent.name, agent]));
  const root = byName.get(project.root);
  if (root === undefined) {
    return {
      ok: false,
      refusal: refuse(
        'platform_agent_not_found',
        `agent "${clip(project.root)}" is not in the project`,
      ),
    };
  }
  const subagents: PortableAgent[] = [];
  for (const { name } of root.subagents) {
    const agent = byName.get(name);
    if (agent === undefined) {
      return {
        ok: false,
        refusal: refuse('platform_agent_not_found', `agent "${clip(name)}" is not in the project`),
      };
    }
    subagents.push(agent);
  }
  const emitted = [root, ...subagents];

  for (const agent of emitted) {
    const refusal = modelUnsupported(agent, options);
    if (refusal !== undefined) return { ok: false, refusal };
  }

  for (const agent of emitted) {
    const servers = serversOf(project, agent);
    if (servers.length > MAX_MCP_SERVERS_PER_AGENT) {
      return {
        ok: false,
        refusal: refuse(
          'platform_limit_exceeded',
          `"${clip(agent.name)}" declares ${servers.length} MCP servers; Claude Managed Agents allows ${MAX_MCP_SERVERS_PER_AGENT}`,
        ),
      };
    }
  }
  if (root.subagents.length > MAX_PREDEFINED_AGENTS) {
    return {
      ok: false,
      refusal: refuse(
        'platform_limit_exceeded',
        `"${clip(root.name)}" lists ${root.subagents.length} subagents; Claude Managed Agents allows ${MAX_PREDEFINED_AGENTS} predefined subagents`,
      ),
    };
  }
  for (const agent of emitted) {
    for (const server of serversOf(project, agent)) {
      if (server.url.length > MCP_SERVER_URL_MAX_LENGTH) {
        return {
          ok: false,
          refusal: refuse(
            'platform_limit_exceeded',
            `the URL of the MCP server "${clip(server.name)}" on "${clip(agent.name)}" is longer than ${MCP_SERVER_URL_MAX_LENGTH} characters`,
          ),
        };
      }
      if (server.name.length > MCP_SERVER_NAME_MAX_LENGTH) {
        return {
          ok: false,
          refusal: refuse(
            'platform_limit_exceeded',
            `the MCP server "${clip(server.name)}" on "${clip(agent.name)}" has a name longer than ${MCP_SERVER_NAME_MAX_LENGTH} characters`,
          ),
        };
      }
    }
  }

  for (const agent of emitted) {
    if (
      usesToolEndpoint(project, agent) &&
      remoteMcpTools(agent).some((tool) => tool.name === AW_TOOLS_SERVER_NAME)
    ) {
      return {
        ok: false,
        refusal: refuse(
          'platform_options_invalid',
          `the MCP server name "${AW_TOOLS_SERVER_NAME}" is reserved for the project's tool endpoint`,
        ),
      };
    }
  }

  const secretByUrl = new Map<string, McpServer>();
  for (const agent of emitted) {
    for (const server of serversOf(project, agent)) {
      if (server.secretRef === undefined) continue;
      const seen = secretByUrl.get(server.url);
      if (seen === undefined) {
        secretByUrl.set(server.url, server);
      } else if (seen.secretRef !== server.secretRef) {
        return {
          ok: false,
          refusal: refuse(
            'platform_options_invalid',
            `the MCP servers "${clip(seen.name)}" and "${clip(server.name)}" reach the same URL with different secrets; a vault holds one credential per URL`,
          ),
        };
      }
    }
  }
  return { ok: true, root, emitted };
}

function enabledTools(agent: PortableAgent): ToolsetTool[] {
  const enabled = new Set<ToolsetTool>();
  const addAll = (names: readonly ToolsetTool[]): void => {
    for (const name of names) enabled.add(name);
  };
  if (agent.permissions.readFiles) addAll(READ_TOOLS);
  if (agent.permissions.writeFiles) addAll(WRITE_TOOLS);
  if (agent.permissions.runCommands) enabled.add('bash');
  for (const tool of agent.tools) {
    if (tool.kind !== 'builtin') continue;
    switch (tool.id) {
      case 'web_search':
      case 'web_fetch':
        enabled.add(tool.id);
        break;
      case 'code_execution':
        enabled.add('bash');
        break;
      case 'file_access':
        addAll(READ_TOOLS);
        if (agent.permissions.writeFiles) addAll(WRITE_TOOLS);
        break;
    }
  }
  return TOOLSET_ORDER.filter((name) => enabled.has(name));
}

function modelValue(agent: PortableAgent, options: ClaudeManagedAgentsOptions): string | Plain {
  const id = options.model?.id ?? agent.model?.id ?? '';
  const effort = options.model?.effort;
  const geo = options.model?.inferenceGeo;
  if (effort === undefined && geo === undefined) return id;
  return {
    id,
    ...(effort === undefined ? {} : { effort }),
    ...(geo === undefined ? {} : { inference_geo: geo }),
  };
}

function policy(type: string | undefined): Plain {
  return type === undefined ? {} : { permission_policy: { type } };
}

function frontmatterOf(
  project: PortableProject,
  agent: PortableAgent,
  root: PortableAgent | undefined,
  options: ClaudeManagedAgentsOptions,
): Plain {
  const servers = remoteMcpTools(agent);
  const endpoint = usesToolEndpoint(project, agent) ? project.toolEndpoint : undefined;
  const mcpServers: Plain[] = servers.map((tool) => ({
    type: 'url',
    name: tool.name,
    url: tool.url,
  }));
  const tools: Plain[] = [];

  const enabled = enabledTools(agent);
  if (enabled.length > 0) {
    tools.push({
      type: AGENT_TOOLSET_TYPE,
      default_config: { enabled: false, ...policy(options.toolsetPermissionPolicy) },
      configs: enabled.map((name) => ({ name, enabled: true })),
    });
  }
  for (const tool of servers) {
    const defaults = policy(options.mcpPermissionPolicy);
    tools.push({
      type: 'mcp_toolset',
      mcp_server_name: tool.name,
      ...(options.mcpPermissionPolicy === undefined ? {} : { default_config: defaults }),
    });
  }
  if (endpoint !== undefined) {
    mcpServers.push({ type: 'url', name: AW_TOOLS_SERVER_NAME, url: endpoint.url });
    tools.push({
      type: 'mcp_toolset',
      mcp_server_name: AW_TOOLS_SERVER_NAME,
      default_config: { enabled: false, ...policy(options.mcpPermissionPolicy) },
      configs: agent.tools.flatMap((tool) =>
        tool.kind === 'code' ? [{ name: tool.name, enabled: true }] : [],
      ),
    });
  }

  const subagents = root === agent ? agent.subagents : [];
  return {
    name: agent.name,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    model: modelValue(agent, options),
    ...(mcpServers.length === 0 ? {} : { mcp_servers: mcpServers }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(agent.skills.length === 0
      ? {}
      : { skills: agent.skills.map((skill) => `../skills/${skill.name}`) }),
    ...(subagents.length === 0
      ? {}
      : {
          multiagent: {
            type: MULTIAGENT_TYPE,
            subagents: {
              type: 'enabled',
              inline_agents: { type: 'disabled' },
              predefined_agents: subagents.map((subagent) => ({
                type: 'agent',
                id: `./${subagent.name}.md`,
              })),
            },
            workflows: { type: 'disabled' },
          },
        }),
  };
}

function yamlText(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}

function agentFile(frontmatter: Plain, instructions: string): PlatformFile {
  const body =
    instructions === ''
      ? ''
      : `\n${instructions.endsWith('\n') ? instructions : `${instructions}\n`}`;
  return {
    path: `agents/${String(frontmatter['name'])}.md`,
    content: `---\n${yamlText(frontmatter)}---\n${body}`,
  };
}

function environmentFile(root: PortableAgent, options: ClaudeManagedAgentsOptions): PlatformFile {
  const unrestricted = root.permissions.unrestrictedNetwork;
  const packages = Object.fromEntries(
    (['apt', 'cargo', 'gem', 'go', 'npm', 'pip'] as const).flatMap((manager) => {
      const names = options.packages?.[manager];
      return names !== undefined && names.length > 0 ? [[manager, names]] : [];
    }),
  );
  const hasPackages = Object.keys(packages).length > 0;
  const hosts = options.allowedHosts ?? [];
  const environment = {
    name: root.name,
    config: {
      type: 'cloud',
      ...(hasPackages ? { packages } : {}),
      networking: {
        type: unrestricted ? 'unrestricted' : 'limited',
        ...(!unrestricted && hosts.length > 0 ? { allowed_hosts: hosts } : {}),
        ...(unrestricted ? {} : { allow_mcp_servers: true }),
        ...(hasPackages ? { allow_package_managers: true } : {}),
      },
    },
  };
  return {
    path: ENVIRONMENT_FILE,
    content: `# yaml-language-server: $schema=${ENVIRONMENT_SCHEMA}\n${yamlText(environment)}`,
  };
}

function vaultFiles(root: PortableAgent, credentials: readonly Plain[]): readonly PlatformFile[] {
  if (credentials.length === 0) return [];
  const vaultPath = `vaults/${root.name}.yaml`;
  return [
    {
      path: vaultPath,
      content: `# yaml-language-server: $schema=${VAULT_SCHEMA}\n${yamlText({ display_name: root.name })}`,
    },
    {
      path: CREDENTIAL_PLAN_FILE,
      content: `${JSON.stringify({ vault: `./${vaultPath}`, credentials }, null, 2)}\n`,
    },
  ];
}

function skillFiles(
  project: PortableProject,
  emitted: readonly PortableAgent[],
): readonly PlatformFile[] {
  const names = [...new Set(emitted.flatMap((agent) => agent.skills.map((skill) => skill.name)))];
  return names.flatMap((name) =>
    (project.skills.find((skill) => skill.name === name)?.files ?? []).map((file) => ({
      path: `skills/${name}/${file.path}`,
      content: typeof file.content === 'string' ? file.content : new Uint8Array(file.content),
    })),
  );
}

interface ReportContext {
  readonly project: PortableProject;
  readonly root: PortableAgent;
  readonly limited: boolean;
}

/** Every planned credential is a `static_bearer`; a note names the scheme it was flattened from. */
function originalScheme(scheme: string): string {
  return scheme === 'bearer' ? '' : ` (original scheme: ${scheme})`;
}

function toolVerdict(context: ReportContext, agent: PortableAgent, index: number): FieldVerdict {
  const path = `${agent.name}.tools.${index}`;
  const tool = agent.tools[index];
  if (tool === undefined) throw new Error(`no tool at ${path}`);
  switch (tool.kind) {
    case 'mcp':
      if (tool.transport === 'stdio') {
        return dropped(
          path,
          'stdio_mcp_unsupported',
          'Claude Managed Agents connects to remote MCP servers only',
        );
      }
      if (tool.transport === 'sse') {
        return mapped(
          path,
          'Emitted as a url server; Managed Agents falls back to SSE for servers that do not speak streamable HTTP (reference page, "Supported MCP server types")',
        );
      }
      return tool.auth === undefined
        ? native(path, 'Emitted as an mcp_servers entry plus an mcp_toolset')
        : mapped(
            path,
            `Emitted as an mcp_servers entry plus an mcp_toolset; the credential is planned in ${CREDENTIAL_PLAN_FILE} as a static_bearer vault credential${originalScheme(tool.auth.scheme)}, never written into a file`,
          );
    case 'code':
      return context.project.toolEndpoint === undefined
        ? dropped(
            path,
            'code_tool_needs_public_mcp',
            'The project has no public tool endpoint, and Managed Agents cannot run the code tool itself',
          )
        : mapped(
            path,
            `Served by the project's tool endpoint as the MCP server ${AW_TOOLS_SERVER_NAME}`,
          );
    case 'openapi':
      return dropped(
        path,
        'field_unsupported',
        'Managed Agents has no OpenAPI tool type; expose the API through an MCP server and add it as an mcp tool',
      );
    case 'builtin': {
      const reach = context.limited
        ? 'with limited networking its results are limited to the environment allowed_hosts'
        : 'the environment has unrestricted networking';
      switch (tool.id) {
        case 'web_search':
        case 'web_fetch':
          return native(path, `Enabled as the ${tool.id} tool; ${reach}`);
        case 'code_execution':
          return mapped(path, 'Code runs through the sandbox shell: the bash tool is enabled');
        case 'file_access':
          return mapped(
            path,
            agent.permissions.writeFiles
              ? 'The sandbox file tools read, glob, grep, write and edit are enabled'
              : 'The sandbox file tools read, glob and grep are enabled',
          );
      }
    }
  }
}

function permissionVerdict(
  context: ReportContext,
  agent: PortableAgent,
  key: (typeof AGENT_PERMISSION_KEYS)[number],
): FieldVerdict {
  const path = `${agent.name}.permissions.${key}`;
  switch (key) {
    case 'readFiles':
      return mapped(
        path,
        'Enables the sandbox file tools read, glob and grep (not workspace files)',
      );
    case 'writeFiles':
      return mapped(path, 'Enables the sandbox file tools write and edit (not workspace files)');
    case 'runCommands':
      return mapped(path, 'Enables the sandbox shell: the bash tool');
    case 'unrestrictedNetwork':
      if (agent !== context.root) {
        return agent.permissions.unrestrictedNetwork && context.limited
          ? dropped(
              path,
              'permissions_unsupported',
              'The sandbox is shared and its networking follows the root agent, which is limited',
            )
          : mapped(
              path,
              context.limited || agent.permissions.unrestrictedNetwork
                ? 'The sandbox is shared and its networking follows the root agent'
                : "The sandbox is shared; this agent gets the root agent's unrestricted networking",
            );
      }
      return mapped(
        path,
        agent.permissions.unrestrictedNetwork
          ? 'The environment networking type is unrestricted'
          : 'The environment networking type is limited, with allow_mcp_servers',
      );
  }
}

function agentVerdicts(
  context: ReportContext,
  agent: PortableAgent,
  options: ClaudeManagedAgentsOptions,
): FieldVerdict[] {
  const at = (field: string): string => `${agent.name}.${field}`;
  const report: FieldVerdict[] = [];
  if (agent.description !== undefined) {
    report.push(native(at('description'), 'Emitted as the description'));
  }
  report.push(
    native(at('instructions'), 'Emitted as the Markdown body, which is the system prompt'),
  );
  if (agent.model !== undefined) {
    report.push(
      native(
        at('model'),
        options.model?.id === undefined
          ? 'Emitted as the model'
          : 'Replaced by the model id from the platform options',
      ),
    );
  }
  if (agent.engine !== undefined) {
    report.push(
      dropped(
        at('engine'),
        'field_unsupported',
        'Managed Agents runs its own harness; the engine choice does not apply',
      ),
    );
  }
  for (const key of AGENT_PERMISSION_KEYS) {
    report.push(permissionVerdict(context, agent, key));
  }
  agent.tools.forEach((_, index) => report.push(toolVerdict(context, agent, index)));
  agent.skills.forEach((skill, index) =>
    report.push(native(at(`skills.${index}`), `Copied to skills/${skill.name} and listed by path`)),
  );
  agent.knowledge.forEach((source, index) => {
    const hint =
      source.kind === 'connector'
        ? 'declare it as an mcp tool instead'
        : 'attach the content to a session instead';
    report.push(
      dropped(
        at(`knowledge.${index}`),
        'knowledge_unsupported',
        `Agents have no knowledge field; ${hint}`,
      ),
    );
  });
  agent.subagents.forEach((_, index) => {
    report.push(
      agent === context.root
        ? mapped(
            at(`subagents.${index}`),
            'VERIFY-1: ant apply resolving a relative file path as the agent id is not yet confirmed; see #1003',
          )
        : dropped(
            at(`subagents.${index}`),
            'subagents_unsupported',
            'A listed agent must not have multiagent itself',
          ),
    );
  });
  if (agent.limits?.maxTurns !== undefined) {
    report.push(dropped(at('limits.maxTurns'), 'limits_unsupported', 'Agents have no turn limit'));
  }
  if (agent.limits?.maxBudgetUsd !== undefined) {
    report.push(
      dropped(
        at('limits.maxBudgetUsd'),
        'limits_unsupported',
        'Budgets are set per session at creation',
      ),
    );
  }
  for (const id of Object.keys(agent.extensions?.engines ?? {})) {
    report.push(
      dropped(
        at(`extensions.engines.${id}`),
        'field_unsupported',
        'Engine-native settings are not emitted',
      ),
    );
  }
  for (const id of Object.keys(agent.extensions?.platforms ?? {})) {
    report.push(
      id === PLATFORM_ID
        ? mapped(
            at(`extensions.platforms.${id}`),
            agent === context.root
              ? 'Read as the options of this target'
              : 'Options are read from the root agent only',
          )
        : dropped(
            at(`extensions.platforms.${id}`),
            'field_unsupported',
            `Options for ${id} belong to another target`,
          ),
    );
  }
  return report;
}

/** Pure translation of a portable project to the `ant apply` layout. */
export function compileClaudeManagedAgents(
  project: PortableProject,
  options: ClaudeManagedAgentsOptions,
): PlatformCompileResult {
  const checked = refusalFor(project, options);
  if (!checked.ok) return checked.refusal;
  const { root, emitted } = checked;

  const context: ReportContext = { project, root, limited: !root.permissions.unrestrictedNetwork };
  const credentialUrls = new Set<string>();
  const credentials: Plain[] = [];
  for (const agent of emitted) {
    for (const server of serversOf(project, agent)) {
      if (server.secretRef === undefined || credentialUrls.has(server.url)) continue;
      credentialUrls.add(server.url);
      credentials.push({
        type: 'static_bearer',
        mcp_server_url: server.url,
        secretRef: server.secretRef,
      });
    }
  }

  const endpointUsed = emitted.some((agent) => usesToolEndpoint(project, agent));
  const report: FieldVerdict[] = [];
  if (project.toolEndpoint !== undefined) {
    report.push(
      endpointUsed
        ? mapped(
            'toolEndpoint',
            `Emitted as the MCP server ${AW_TOOLS_SERVER_NAME}; its credential is planned as a static_bearer vault credential${originalScheme(project.toolEndpoint.auth.scheme)}`,
          )
        : dropped(
            'toolEndpoint',
            'field_unsupported',
            `No emitted agent has a code tool, so no ${AW_TOOLS_SERVER_NAME} server is added`,
          ),
    );
  }
  for (const agent of emitted) report.push(...agentVerdicts(context, agent, options));

  const files: PlatformFile[] = [
    ...emitted.map((agent) =>
      agentFile(frontmatterOf(project, agent, root, options), agent.instructions),
    ),
    ...skillFiles(project, emitted),
    environmentFile(root, options),
    ...vaultFiles(root, credentials),
  ];
  return { ok: true, files, report };
}
