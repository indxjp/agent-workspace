import type {
  FieldVerdict,
  PlatformFile,
  PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';

import { prettyJson } from '../../json.js';
import { capabilityOfPath, dropped, mapped, native, portableFieldPaths } from '../../paths.js';
import type { PlatformCompileResult } from '../../port.js';
import { BEDROCK_CLAUDE_MODEL_IDS, partitionOf, type AwsAgentCoreOptions } from './options.js';

type Refused = Extract<PlatformCompileResult, { ok: false }>;
type PortableTool = PortableAgent['tools'][number];
type Json = Record<string, unknown>;
interface HarnessTool {
  readonly type: string;
  readonly name: string;
  readonly config?: Json;
}

const PLATFORM_ID = 'aws-agentcore';
export const AW_TOOLS_NAME = 'aw-tools';
const HARNESS_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/u;
const PROJECT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,22}$/u;
const MAX_ALLOWED_TOOL_LENGTH = 64;

/** Everything one compile accumulates; `names` records who owns each harness tool name. */
interface Build {
  readonly project: PortableProject;
  readonly options: AwsAgentCoreOptions;
  readonly tools: HarnessTool[];
  readonly allowedTools: string[];
  readonly credentials: Set<string>;
  readonly names: Map<string, 'user' | 'synthetic'>;
  readonly verdicts: FieldVerdict[];
  readonly files: PlatformFile[];
}

function refuse(code: PlatformRefusal['code'], message: string, details: string[]): Refused {
  return { ok: false, refusal: { code, message, details } };
}

function isRefused(value: object): value is Refused {
  return 'refusal' in value;
}

// VERIFY: AgentCore availability in the aws-cn and aws-us-gov partitions is unconfirmed; the partition
// comes from the region (AWS's own rule), so a region outside `aws` yields that partition's ARN.
// VERIFY V2: the token-vault path segment equals the `credentials[].name` the CLI creates. Evidence
// (CLI mapper source), not AWS docs: https://github.com/aws/agentcore-cli/blob/dd6304eef85dac8135acb01579a1cf41313148e5/src/cli/commands/export/harness-mapper.ts#L641-L652
function credentialRef(options: AwsAgentCoreOptions, name: string): string {
  return `arn:${partitionOf(options.region)}:bedrock-agentcore:${options.region}:${options.accountId}:token-vault/default/apikeycredentialprovider/${name}`;
}

/** The harness resolves `${arn:...}` at invocation time, so no secret value is ever written. */
function interpolated(options: AwsAgentCoreOptions, name: string): string {
  return `\${${credentialRef(options, name)}}`;
}

function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function deriveNames(
  root: PortableAgent,
  options: AwsAgentCoreOptions,
): { harness: string; project: string } | Refused {
  const harness = options.harnessName ?? root.name.replaceAll('-', '_');
  if (!HARNESS_NAME_PATTERN.test(harness)) {
    return refuse(
      'platform_limit_exceeded',
      `The harness name ${harness} must start with a letter and be at most 40 characters of letters, digits and "_"; set platforms.aws-agentcore.options.harnessName.`,
      ['limit: harnessName'],
    );
  }
  const project = options.projectName ?? pascalCase(root.name);
  if (!PROJECT_NAME_PATTERN.test(project)) {
    return refuse(
      'platform_limit_exceeded',
      `The project name ${project} must start with a letter and be at most 23 letters and digits; set platforms.aws-agentcore.options.projectName.`,
      ['limit: projectName'],
    );
  }
  return { harness, project };
}

function mapModel(agent: PortableAgent, build: Build): Json | undefined | Refused {
  const { options } = build;
  const path = `${agent.name}.model`;
  if (options.model !== undefined) {
    const { provider, modelId, apiKeyCredential } = options.model;
    if (apiKeyCredential !== undefined) build.credentials.add(apiKeyCredential);
    if (agent.model !== undefined) {
      build.verdicts.push(mapped(path, 'replaced by platforms.aws-agentcore.options.model'));
    }
    return {
      provider,
      modelId,
      ...(apiKeyCredential === undefined
        ? {}
        : { apiKeyArn: credentialRef(options, apiKeyCredential) }),
    };
  }
  if (agent.model === undefined) return undefined;
  const { provider, id } = agent.model;
  if (
    (provider === undefined || provider === 'anthropic') &&
    Object.hasOwn(BEDROCK_CLAUDE_MODEL_IDS, id)
  ) {
    build.verdicts.push(
      mapped(path, `${id} is served on Bedrock as ${BEDROCK_CLAUDE_MODEL_IDS[id]}`),
    );
    return { provider: 'bedrock', modelId: BEDROCK_CLAUDE_MODEL_IDS[id] };
  }
  return refuse(
    'platform_model_unsupported',
    `The model ${id} has no known Bedrock id; set platforms.aws-agentcore.options.model.`,
    [id],
  );
}

function addPermissions(agent: PortableAgent, build: Build): void {
  const { readFiles, writeFiles, runCommands, unrestrictedNetwork } = agent.permissions;
  const at = (key: string): string => `${agent.name}.permissions.${key}`;
  const { verdicts, allowedTools } = build;
  if (runCommands) allowedTools.push('@builtin/shell');
  if (writeFiles) allowedTools.push('@builtin/file_operations');

  verdicts.push(native(at('runCommands'), runCommands ? '@builtin/shell is allowed' : 'no shell'));
  verdicts.push(
    native(at('writeFiles'), writeFiles ? '@builtin/file_operations is allowed' : 'no file edits'),
  );
  if (readFiles && !writeFiles) {
    verdicts.push(
      dropped(
        at('readFiles'),
        'permissions_unsupported',
        'the harness has no read-only file tool, and write access is never granted to give read access',
      ),
    );
  } else if (writeFiles && !readFiles) {
    verdicts.push(mapped(at('readFiles'), '@builtin/file_operations also views files'));
  } else {
    verdicts.push(
      native(at('readFiles'), readFiles ? '@builtin/file_operations is allowed' : 'no file access'),
    );
  }
  if (unrestrictedNetwork) {
    verdicts.push(native(at('unrestrictedNetwork'), 'the PUBLIC network mode is unrestricted'));
  } else if (!runCommands) {
    verdicts.push(
      mapped(at('unrestrictedNetwork'), 'without a shell the agent has no arbitrary egress'),
    );
  } else {
    verdicts.push(
      dropped(
        at('unrestrictedNetwork'),
        'permissions_unsupported',
        'the PUBLIC network mode has no egress allow-list, and the shell is allowed',
      ),
    );
  }
}

/** Adds `tool` and its `allowedTools` entry; otherwise returns why the tool is dropped. */
function use(
  build: Build,
  origin: 'user' | 'synthetic',
  tool: HarnessTool,
  allowed: string,
): string | undefined {
  if (allowed.length > MAX_ALLOWED_TOOL_LENGTH) {
    return `the allowedTools entry ${allowed} is longer than the ${String(MAX_ALLOWED_TOOL_LENGTH)} characters the harness accepts`;
  }
  const owner = build.names.get(tool.name);
  if (owner === undefined) {
    build.names.set(tool.name, origin);
    build.tools.push(tool);
  } else if (origin !== 'synthetic' || owner !== 'synthetic') {
    return `the harness tool name ${tool.name} is already used by another tool`;
  }
  if (!build.allowedTools.includes(allowed)) build.allowedTools.push(allowed);
  return undefined;
}

function remoteMcp(name: string, url: string, header?: readonly [string, string]): HarnessTool {
  return {
    type: 'remote_mcp',
    name,
    config: {
      remoteMcp: { url, ...(header === undefined ? {} : { headers: { [header[0]]: header[1] } }) },
    },
  };
}

// VERIFY V1: docs show `${arn:...}` only as a whole header value (`x-api-key`); a `Bearer ` prefix is unconfirmed.
function authHeader(
  options: AwsAgentCoreOptions,
  scheme: 'bearer' | 'api-key' | 'oauth2',
  secretRef: string,
): readonly [string, string] | undefined {
  const reference = interpolated(options, secretRef);
  if (scheme === 'bearer') return ['Authorization', `Bearer ${reference}`];
  if (scheme === 'api-key') return ['x-api-key', reference];
  return undefined;
}

function addMcpTool(
  build: Build,
  path: string,
  tool: Extract<PortableTool, { kind: 'mcp' }>,
): FieldVerdict {
  if (tool.transport === 'stdio') {
    return dropped(path, 'stdio_mcp_unsupported', 'the harness reaches remote MCP servers only');
  }
  const header =
    tool.auth === undefined
      ? undefined
      : authHeader(build.options, tool.auth.scheme, tool.auth.secretRef);
  if (tool.auth !== undefined && header === undefined) {
    return dropped(path, 'field_unsupported', 'OAuth2 has no static header form in the harness');
  }
  const problem = use(build, 'user', remoteMcp(tool.name, tool.url, header), `@${tool.name}`);
  if (problem !== undefined) return dropped(path, 'field_unsupported', problem);
  if (tool.auth !== undefined) build.credentials.add(tool.auth.secretRef);
  return native(path, 'a remote_mcp tool');
}

function addCodeTool(build: Build, path: string, name: string): FieldVerdict {
  const endpoint = build.project.toolEndpoint;
  if (endpoint === undefined) {
    return dropped(
      path,
      'code_tool_needs_public_mcp',
      'there is no public tool endpoint to run it on',
    );
  }
  const header = authHeader(build.options, endpoint.auth.scheme, endpoint.auth.secretRef);
  if (header === undefined) {
    return dropped(
      path,
      'code_tool_needs_public_mcp',
      'the tool endpoint uses OAuth2, which has no static header form in the harness',
    );
  }
  const problem = use(
    build,
    'synthetic',
    remoteMcp(AW_TOOLS_NAME, endpoint.url, header),
    `@${AW_TOOLS_NAME}/${name}`,
  );
  if (problem !== undefined) return dropped(path, 'field_unsupported', problem);
  build.credentials.add(endpoint.auth.secretRef);
  return mapped(
    path,
    `served by the ${AW_TOOLS_NAME} remote MCP tool at the project tool endpoint`,
  );
}

function addGatewayTool(
  build: Build,
  origin: 'user' | 'synthetic',
  name: string,
  gatewayArn: string,
  outboundAuth: boolean,
): string | undefined {
  const gateway = { gatewayArn, ...(outboundAuth ? { outboundAuth: { awsIam: {} } } : {}) };
  return use(
    build,
    origin,
    { type: 'agentcore_gateway', name, config: { agentCoreGateway: gateway } },
    `@${name}`,
  );
}

function addOpenApiTool(
  build: Build,
  path: string,
  tool: Extract<PortableTool, { kind: 'openapi' }>,
): FieldVerdict {
  const { name } = tool;
  const gateways = build.options.openapiGateways;
  const arn = gateways !== undefined && Object.hasOwn(gateways, name) ? gateways[name] : undefined;
  if (arn === undefined) {
    return dropped(
      path,
      'field_unsupported',
      'no gateway fronts this API; set options.openapiGateways',
    );
  }
  if (tool.allow !== undefined) {
    return dropped(
      path,
      'permissions_unsupported',
      'allow rules cannot be applied: the gateway target defines the spec; narrow the gateway target and remove allow',
    );
  }
  const problem = addGatewayTool(build, 'user', name, arn, true);
  if (problem !== undefined) return dropped(path, 'field_unsupported', problem);
  const notCarried = [
    ...(tool.baseUrl === undefined ? [] : ['baseUrl']),
    ...(tool.auth === undefined ? [] : ['auth']),
    'specRef',
  ];
  const notes = [
    'served through the gateway that fronts the API as an OpenAPI target',
    `${notCarried.join(', ')} not carried: the gateway target defines the spec, base URL and outbound auth`,
  ];
  return mapped(path, notes.join('; '));
}

function addBuiltinTool(build: Build, path: string, id: string, writeFiles: boolean): FieldVerdict {
  const synthetic = (type: string, name: string, note: string): FieldVerdict => {
    const problem = use(build, 'synthetic', { type, name }, name);
    return problem === undefined
      ? mapped(path, note)
      : dropped(path, 'builtin_unsupported', problem);
  };
  switch (id) {
    case 'web_search': {
      const arn = build.options.webSearchGatewayArn;
      if (arn === undefined) {
        return dropped(
          path,
          'builtin_unsupported',
          'web search needs a gateway; set options.webSearchGatewayArn',
        );
      }
      const problem = addGatewayTool(build, 'synthetic', 'web-search', arn, false);
      return problem === undefined
        ? mapped(path, 'the Web Search connector behind the configured gateway')
        : dropped(path, 'builtin_unsupported', problem);
    }
    case 'web_fetch':
      return synthetic(
        'agentcore_browser',
        'browser',
        'the AgentCore browser, a superset of fetching',
      );
    case 'code_execution':
      return synthetic(
        'agentcore_code_interpreter',
        'code_interpreter',
        'the AgentCore code interpreter',
      );
    default:
      if (!writeFiles) {
        return dropped(
          path,
          'builtin_unsupported',
          'file_operations is withheld because permissions.writeFiles is false',
        );
      }
      return mapped(
        path,
        'granted by permissions.writeFiles (@builtin/file_operations), not by a tool entry',
      );
  }
}

function addTools(agent: PortableAgent, build: Build): void {
  agent.tools.forEach((tool, index) => {
    const path = `${agent.name}.tools.${index}`;
    switch (tool.kind) {
      case 'mcp':
        build.verdicts.push(addMcpTool(build, path, tool));
        break;
      case 'code':
        build.verdicts.push(addCodeTool(build, path, tool.name));
        break;
      case 'openapi':
        build.verdicts.push(addOpenApiTool(build, path, tool));
        break;
      case 'builtin':
        build.verdicts.push(addBuiltinTool(build, path, tool.id, agent.permissions.writeFiles));
        break;
    }
  });
  const endpoint = build.project.toolEndpoint;
  if (endpoint === undefined) return;
  build.verdicts.push(
    build.names.get(AW_TOOLS_NAME) === 'synthetic'
      ? mapped('toolEndpoint', `the ${AW_TOOLS_NAME} remote MCP tool points at it`)
      : dropped(
          'toolEndpoint',
          'field_unsupported',
          endpoint.auth.scheme === 'oauth2'
            ? 'OAuth2 has no static header form in the harness'
            : 'no code tool uses it',
        ),
  );
}

function addSkills(agent: PortableAgent, build: Build, harness: string): Json[] {
  const prefix = build.options.skillsS3Uri;
  const skills: Json[] = [];
  agent.skills.forEach((skill, index) => {
    const path = `${agent.name}.skills.${index}`;
    const files = build.project.skills.find((candidate) => candidate.name === skill.name)?.files;
    if (prefix === undefined || files === undefined) {
      build.verdicts.push(
        dropped(
          path,
          'skills_unsupported',
          'path skills need a custom container; set options.skillsS3Uri',
        ),
      );
      return;
    }
    for (const file of files) {
      build.files.push({
        path: `app/${harness}/skills/${skill.name}/${file.path}`,
        content: file.content,
      });
    }
    skills.push({ s3Uri: `${prefix}${skill.name}/` });
    build.verdicts.push(mapped(path, 'uploaded to options.skillsS3Uri by the publish executor'));
  });
  return skills;
}

/** The report entries of fields that have no mapping; for a subagent, every field. */
function unmappedVerdicts(
  project: PortableProject,
  agent: PortableAgent,
  isRoot: boolean,
): FieldVerdict[] {
  const prefix = `${agent.name}.`;
  const verdicts: FieldVerdict[] = [];
  for (const path of portableFieldPaths(project)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const platform = rest.startsWith('extensions.platforms.')
      ? rest.slice('extensions.platforms.'.length)
      : undefined;
    if (platform !== undefined) {
      verdicts.push(
        platform === PLATFORM_ID
          ? mapped(path, 'read as this target’s options')
          : dropped(path, 'field_unsupported', `options for ${platform}, not for this target`),
      );
    } else if (rest === 'engine' || rest.startsWith('extensions.engines.')) {
      verdicts.push(dropped(path, 'field_unsupported', 'the harness runs its own loop'));
    } else if (isRoot) {
      if (rest === 'description') {
        verdicts.push(dropped(path, 'field_unsupported', 'the harness has no description'));
      } else if (rest.startsWith('knowledge.')) {
        verdicts.push(
          dropped(path, 'knowledge_unsupported', 'the harness has no file-search tool'),
        );
      } else if (rest.startsWith('subagents.')) {
        verdicts.push(dropped(path, 'subagents_unsupported', 'one harness holds one agent'));
      }
    } else {
      const capability = capabilityOfPath(project, path);
      if (capability === 'mcpStdio') {
        verdicts.push(
          dropped(path, 'stdio_mcp_unsupported', 'the harness reaches remote MCP servers only'),
        );
      } else if (capability === 'codeTools' && project.toolEndpoint === undefined) {
        verdicts.push(
          dropped(path, 'code_tool_needs_public_mcp', 'there is no public tool endpoint'),
        );
      } else {
        verdicts.push(
          dropped(path, 'subagents_unsupported', 'only the root agent becomes a harness'),
        );
      }
    }
  }
  return verdicts;
}

function projectFiles(
  build: Build,
  names: { harness: string; project: string },
  root: PortableAgent,
  model: Json | undefined,
  skills: readonly Json[],
): PlatformFile[] {
  const { options, tools, allowedTools, credentials } = build;
  // VERIFY: `allowedTools: []` allows no tool, builtins included (evidence: CLI mapper source, not
  // AWS docs); an omitted list grants every tool, so `[]` is the fail-closed form. Upstream
  // `HarnessSpecSchema` requires `model`, so omitting it for an agent without a model is rejected by
  // the CLI; the mapping is a follow-up. See vendor-fixtures/agentcore-cli-dd6304e/SOURCE.md.
  const harness = {
    name: names.harness,
    ...(model === undefined ? {} : { model }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(skills.length === 0 ? {} : { skills }),
    allowedTools,
    memory: { mode: 'disabled' },
    ...(root.limits?.maxTurns === undefined ? {} : { maxIterations: root.limits.maxTurns }),
  };
  const agentcore = {
    $schema: 'https://schema.agentcore.aws.dev/v1/agentcore.json',
    name: names.project,
    version: 1,
    managedBy: 'CDK',
    credentials: [...credentials].map((name) => ({
      authorizerType: 'ApiKeyCredentialProvider',
      name,
    })),
    harnesses: [{ name: names.harness, path: `app/${names.harness}` }],
  };
  return [
    { path: 'agentcore/agentcore.json', content: prettyJson(agentcore) },
    {
      path: 'agentcore/aws-targets.json',
      content: prettyJson([
        { name: 'default', account: options.accountId, region: options.region },
      ]),
    },
    { path: `app/${names.harness}/harness.json`, content: prettyJson(harness) },
    { path: `app/${names.harness}/system-prompt.md`, content: `${root.instructions}\n` },
    ...build.files,
  ];
}

/** `PortableProject` → an AgentCore CLI project holding one managed harness (the root agent). */
export function compileAwsAgentCore(
  project: PortableProject,
  options: AwsAgentCoreOptions,
): PlatformCompileResult {
  const root = project.agents.find((agent) => agent.name === project.root);
  if (root === undefined) {
    return refuse(
      'platform_agent_not_found',
      `The root agent ${project.root} is not in the project.`,
      [project.root],
    );
  }
  const names = deriveNames(root, options);
  if (isRefused(names)) return names;

  const build: Build = {
    project,
    options,
    tools: [],
    allowedTools: [],
    credentials: new Set(),
    names: new Map(),
    verdicts: [],
    files: [],
  };
  const model = mapModel(root, build);
  if (model !== undefined && isRefused(model)) return model;

  build.verdicts.push(native(`${root.name}.instructions`, 'written to system-prompt.md'));
  addPermissions(root, build);
  addTools(root, build);
  const skills = addSkills(root, build, names.harness);
  if (root.limits?.maxTurns !== undefined) {
    build.verdicts.push(
      mapped(`${root.name}.limits.maxTurns`, 'one iteration is one reason/act cycle'),
    );
  }
  if (root.limits?.maxBudgetUsd !== undefined) {
    build.verdicts.push(
      dropped(
        `${root.name}.limits.maxBudgetUsd`,
        'limits_unsupported',
        'the harness has token limits, not a USD budget',
      ),
    );
  }
  for (const agent of project.agents) {
    build.verdicts.push(...unmappedVerdicts(project, agent, agent === root));
  }
  return {
    ok: true,
    files: projectFiles(build, names, root, model, skills),
    report: build.verdicts,
  };
}
