import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import {
  AgentToolPolicySchema,
  claudeBaseToolPolicyFor,
  engineSettingsOf,
  policyNarrowedPermissions,
  type AgentPermissionKey,
  type AgentPolicy,
  type AgentToolPolicy,
} from '@indx-workspace/contracts/agents';
import { DEFAULT_ENGINE_ID, ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  PortableAgentSchema,
  PortableKnowledgeSourceSchema,
  PortableToolSchema,
  type PORTABLE_BUILTIN_TOOL_IDS,
  type PortableAgent,
  type PortableAgentInput,
} from '@indx-workspace/contracts/portable-agent';
import {
  NAME_KEY_PATTERN,
  type ProjectConnector,
  type ProjectDocument,
  type ProjectModelConnection,
} from '@indx-workspace/contracts/project-file';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import {
  DefineAgentInputSchema,
  defineAgent,
  type DefineTool,
  type DefinedAgent,
  type KnowledgeSource,
  type ModelReference,
} from '../define/agent.js';
import { DefinitionError, issuesFromZod } from '../define/errors.js';
import {
  CODE_TOOL_DEFAULT_TIMEOUT_MS,
  isCodeTool,
  isMcpTool,
  files,
  mcp,
  openapiTool,
  skill,
  type FileGrant,
} from '../define/references.js';
import {
  toAgentVersionBody,
  toolDefinitionsOf,
  type OpenApiToolDefinition,
  type ToAgentVersionBodyOptions,
  type ToolDefinition,
} from '../define/version-body.js';

/** One thing a conversion could not carry, at the input's dotted path, with the reason a person acts on. */
export interface PortableDrop {
  readonly path: string;
  readonly reason: string;
}

/** A conversion's answer: the value, and everything it left out. Never silent (ADR-0133 D5). */
export interface PortableConversion<T> {
  readonly value: T;
  readonly dropped: readonly PortableDrop[];
}

/** A code tool's declaration as a version pins it or `defineTool()` makes it. */
export interface PortableCodeToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Not carried by `PortableTool`; reported in `dropped` when present. */
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
  /** Not carried; reported only when it differs from {@link CODE_TOOL_DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Secret names, never values. Not carried; reported in `dropped` when present. */
  readonly secrets?: readonly string[] | undefined;
  /** An egress restriction. Not carried; always reported in `dropped` when present. */
  readonly allowedDomains?: readonly string[] | undefined;
}

/** What resolves the names a version body holds. Every field is optional; an unresolved name is dropped, never guessed. */
export interface PortableAgentContext {
  /** agent-workspace.yaml `connectors:`, by name. */
  readonly connectors?: Readonly<Record<string, ProjectConnector>> | undefined;
  /** agent-workspace.yaml `models:`, by connection name. */
  readonly models?: Readonly<Record<string, ProjectModelConnection>> | undefined;
  /** The catalog tools of the project or workspace, by name. */
  readonly catalogTools?: readonly ToolDefinition[] | undefined;
  /** Code tool declarations; when absent, the body's own `toolBundles` declarations are used. */
  readonly codeTools?: readonly PortableCodeToolDeclaration[] | undefined;
}

/** The one `./` prefix `openapiTool()` allows on a spec path; `PortableRelativePathSchema` refuses it. */
const CURRENT_DIRECTORY_PREFIX = /^\.\//u;

/** The permission switch whose absence makes a builtin tool unreachable. */
const BUILTIN_SWITCH = {
  web_search: 'unrestrictedNetwork',
  web_fetch: 'unrestrictedNetwork',
  file_access: 'readFiles',
  code_execution: 'runCommands',
} as const satisfies Record<(typeof PORTABLE_BUILTIN_TOOL_IDS)[number], AgentPermissionKey>;

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function finish<T>(value: T, drops: readonly PortableDrop[]): PortableConversion<T> {
  return Object.freeze({
    value,
    dropped: Object.freeze(drops.map((drop) => Object.freeze({ ...drop }))),
  });
}

/** What `tools` can say about an engine: its catalogue settings, plus Claude's tool grammar. */
function engineBlockOf(policy: AgentPolicy): Record<string, unknown> {
  return {
    ...engineSettingsOf(policy),
    ...('tools' in policy ? { tools: policy.tools } : {}),
  };
}

function openApiToolOf(tool: OpenApiToolDefinition): unknown {
  return {
    kind: 'openapi',
    name: tool.name,
    specRef: tool.spec.replace(CURRENT_DIRECTORY_PREFIX, ''),
    allow: [...tool.allow],
    ...(tool.baseUrl === undefined ? {} : { baseUrl: tool.baseUrl }),
    ...(tool.auth === 'none' || tool.credential === undefined
      ? {}
      : {
          auth: {
            secretRef: tool.credential.secret,
            ...(tool.auth === 'bearer' ? {} : { header: tool.auth.header }),
          },
        }),
  };
}

function mcpToolOf(name: string, connector: ProjectConnector): unknown {
  return {
    kind: 'mcp',
    name,
    transport: connector.transport === 'sse' ? 'sse' : 'streamable-http',
    url: connector.url,
    ...(connector.auth === undefined
      ? {}
      : { auth: { scheme: connector.auth.scheme, secretRef: connector.auth.credential.secret } }),
  };
}

/** The portable agent for a parsed body: the one mapping every entry point shares. */
function convertBody(
  body: AgentVersionBody,
  context: PortableAgentContext,
  subject: string,
): PortableConversion<PortableAgent> {
  const { agent, policy, policySource, resources } = body.definition;
  if (!NAME_KEY_PATTERN.test(agent.name)) {
    throw new DefinitionError(subject, [
      {
        path: 'definition.agent.name',
        message: 'rename the agent to lower-case kebab (1-64 characters) to export it',
      },
    ]);
  }
  const drops: PortableDrop[] = [];
  const drop = (path: string, reason: string): void => {
    drops.push({ path, reason });
  };

  const stored = policySource === 'stored';
  const permissions = policyNarrowedPermissions(agent.permissions, stored ? policy : null);

  let model: { provider?: string; id: string } | undefined;
  if (agent.model !== null) {
    const provider = own(context.models, agent.modelConnectionName ?? '')?.provider;
    model = { ...(provider === undefined ? {} : { provider }), id: agent.model };
  } else if (agent.modelConnectionName !== null && agent.modelConnectionName !== 'default') {
    drop(
      'definition.agent.model',
      `the model connection "${agent.modelConnectionName}" names no model id; set model: { connection, id } to export it`,
    );
  }
  if (agent.runtimeProfileName !== null) {
    drop('definition.agent.runtimeProfileName', 'runtime profiles are Agent Workspace resources');
  }

  const engineBlock = stored ? engineBlockOf(policy) : {};
  const limits = {
    ...(policy.limits.maxTurns === null ? {} : { maxTurns: policy.limits.maxTurns }),
    ...(policy.limits.maxBudgetUsd === null ? {} : { maxBudgetUsd: policy.limits.maxBudgetUsd }),
  };

  const allowed = policy.skills.mode === 'all' ? null : new Set(policy.skills.names);
  const skills: { name: string; path: string }[] = [];
  resources.skills.forEach((name, index) => {
    if (allowed !== null && !allowed.has(name)) {
      drop(`definition.resources.skills.${index}`, "the policy's skill allowlist excludes it");
    } else {
      skills.push({ name, path: `skills/${name}` });
    }
  });

  const knowledgeFiles = new Set(
    (body.knowledge ?? []).flatMap((source) => (source.kind === 'files' ? source.paths : [])),
  );
  const writable = new Set(
    resources.files.filter((file) => file.access === 'read-write').map((file) => file.path),
  );
  resources.files.forEach((file, index) => {
    if (knowledgeFiles.has(file.path)) return;
    drop(
      `definition.resources.files.${index}`,
      'workspace file grants are Agent Workspace resources',
    );
  });

  const subagents: { name: string }[] = [];
  (body.subagents ?? []).forEach((subagent, index) => {
    if (NAME_KEY_PATTERN.test(subagent.name)) subagents.push({ name: subagent.name });
    else drop(`subagents.${index}`, 'rename the subagent to lower-case kebab to export it');
  });

  const knowledge: unknown[] = [];
  (body.knowledge ?? []).forEach((source, index) => {
    const readWrite =
      source.kind === 'files' ? source.paths.filter((path) => writable.has(path)) : [];
    const candidates: unknown[] =
      source.kind === 'files' && readWrite.length > 0
        ? [
            { kind: 'files', paths: source.paths.filter((path) => !writable.has(path)) },
            { kind: 'files', paths: readWrite, access: 'read-write' },
          ].filter((part) => part.paths.length > 0)
        : [source];
    const kept: unknown[] = [];
    let failure: Parameters<typeof issuesFromZod>[0] | undefined;
    for (const candidate of candidates) {
      const parsed = PortableKnowledgeSourceSchema.safeParse(candidate);
      if (!parsed.success) {
        failure = parsed.error;
        break;
      }
      kept.push(parsed.data);
    }
    if (failure === undefined) {
      knowledge.push(...kept);
      return;
    }
    const why = issuesFromZod(failure)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    drop(`knowledge.${index}`, `cannot be written as a portable knowledge source: ${why}`);
  });

  const tools: unknown[] = [];
  const keep = (path: string, tool: unknown): boolean => {
    const parsed = PortableToolSchema.safeParse(tool);
    if (parsed.success) {
      tools.push(parsed.data);
      return true;
    }
    const why = issuesFromZod(parsed.error)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    drop(path, `cannot be written as a portable tool: ${why}`);
    return false;
  };
  const codeTool = (path: string, declaration: PortableCodeToolDeclaration): void => {
    const { outputSchema, timeoutMs, secrets, allowedDomains, ...portable } = declaration;
    if (!keep(path, { kind: 'code', ...portable })) return;
    const enforced = (field: string, what: string): void => {
      drop(
        `${path}.${field}`,
        `${what} is enforced by the workspace tool runtime (ADR-0134) and is not carried in the portable definition`,
      );
    };
    if (outputSchema !== undefined) enforced('outputSchema', 'the output schema');
    if (timeoutMs !== undefined && timeoutMs !== CODE_TOOL_DEFAULT_TIMEOUT_MS) {
      enforced('timeoutMs', `the ${timeoutMs} ms timeout`);
    }
    if (secrets !== undefined) enforced('secrets', `the secrets ${secrets.join(', ')}`);
    if (allowedDomains !== undefined) {
      enforced('allowedDomains', `the egress restriction to ${allowedDomains.join(', ')}`);
    }
  };

  // The portable tool has no identity field: the assertion is an Agent Workspace feature (ADR-0142).
  const dropIdentity = (path: string, secretName: string): void => {
    drop(
      `${path}.identity`,
      `the signed identity assertion (secret ${secretName}) is an Agent Workspace feature and is not carried in the portable definition`,
    );
  };

  let codeToolsSeen = false;
  resources.connectors.forEach((name, index) => {
    const path = `definition.resources.connectors.${index}`;
    if (name === AW_DEV_TOOLS_CONNECTOR) {
      codeToolsSeen = true;
      if (context.codeTools !== undefined) {
        context.codeTools.forEach((declaration, at) => {
          codeTool(`codeTools.${at}`, declaration);
        });
        return;
      }
      (body.toolBundles ?? []).forEach((bundle, at) => {
        if (bundle.description === undefined || bundle.inputSchema === undefined) {
          drop(
            `toolBundles.${at}`,
            'pinned before its declaration was recorded; push the agent again',
          );
        } else {
          codeTool(`toolBundles.${at}`, {
            name: bundle.tool,
            description: bundle.description,
            inputSchema: bundle.inputSchema,
            outputSchema: bundle.outputSchema,
            timeoutMs: bundle.timeoutMs,
            secrets: bundle.secrets,
            allowedDomains: bundle.allowedDomains,
          });
        }
      });
      return;
    }
    const catalogTool = context.catalogTools?.find((tool) => tool.name === name);
    const connector = own(context.connectors, name);
    if (catalogTool?.kind === 'openapi') {
      if (catalogTool.auth !== 'none' && catalogTool.credential === undefined) {
        drop(path, 'its credential secret is not named');
      } else if (keep(path, openApiToolOf(catalogTool)) && catalogTool.identity !== undefined) {
        dropIdentity(path, catalogTool.identity.secret);
      }
    } else if (catalogTool?.kind === 'postgres') {
      drop(path, 'postgres tools run only inside Agent Workspace');
    } else if (connector !== undefined) {
      if (keep(path, mcpToolOf(name, connector)) && connector.identity !== undefined) {
        dropIdentity(path, connector.identity.secret);
      }
    } else {
      drop(
        path,
        `connector "${name}" is not declared in agent-workspace.yaml connectors:, so its URL is unknown`,
      );
    }
  });
  if (!codeToolsSeen && context.codeTools === undefined) {
    (body.toolBundles ?? []).forEach((_bundle, index) => {
      drop(
        `toolBundles.${index}`,
        `the agent does not use the ${AW_DEV_TOOLS_CONNECTOR} connector`,
      );
    });
  }

  body.surfaces.forEach((_surface, index) => {
    drop(`surfaces.${index}`, 'surfaces are served by Agent Workspace');
  });

  const parsed = PortableAgentSchema.safeParse({
    apiVersion: PORTABLE_AGENT_API_VERSION,
    kind: PORTABLE_AGENT_KIND,
    name: agent.name,
    ...(body.description === undefined ? {} : { description: body.description }),
    instructions: agent.instructions,
    ...(model === undefined ? {} : { model }),
    engine: policy.engine,
    permissions,
    tools,
    skills,
    knowledge,
    subagents,
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(Object.keys(engineBlock).length === 0
      ? {}
      : { extensions: { engines: { [policy.engine]: engineBlock } } }),
  });
  if (!parsed.success) throw new DefinitionError(subject, issuesFromZod(parsed.error));
  return finish(parsed.data, drops);
}

/**
 * Turns the body of an agent version into a portable agent, and reports everything it could not
 * carry (ADR-0133 D5). Names the body holds — connectors, model connections, catalog tools — are
 * resolved through `context`; one it does not resolve is dropped, never guessed.
 *
 * @throws {DefinitionError} when the body does not parse as `AgentVersionBodySchema`, or the
 *   agent's name is not lower-case kebab.
 */
export function portableFromAgentVersionBody(
  body: AgentVersionBody,
  context: PortableAgentContext = {},
): PortableConversion<PortableAgent> {
  const subject = 'portableFromAgentVersionBody()';
  const parsed = AgentVersionBodySchema.safeParse(body);
  if (!parsed.success) throw new DefinitionError(subject, issuesFromZod(parsed.error));
  return convertBody(parsed.data, context, subject);
}

/**
 * `toAgentVersionBody(agent, options)` then {@link portableFromAgentVersionBody}, with the agent's
 * own tools as the catalog and code tools, and `options.project`'s connectors and model
 * connections as the names to resolve.
 *
 * @throws {DefinitionError} when the agent cannot be turned into a version body, or its name is
 *   not lower-case kebab.
 */
export function toPortableAgent(
  agent: DefinedAgent,
  options: ToAgentVersionBodyOptions & { readonly project?: ProjectDocument | undefined } = {},
): PortableConversion<PortableAgent> {
  const subject = 'toPortableAgent()';
  const { project, ...bodyOptions } = options;
  let body: AgentVersionBody;
  try {
    body = toAgentVersionBody(agent, bodyOptions);
  } catch (error) {
    throw error instanceof DefinitionError ? new DefinitionError(subject, error.issues) : error;
  }
  const codeTools = (agent.tools ?? []).filter(isCodeTool).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    timeoutMs: tool.limits.timeoutMs,
    secrets: tool.secrets,
    allowedDomains: tool.allowedDomains,
  }));
  return convertBody(
    body,
    {
      connectors: project?.connectors,
      models: project?.models,
      catalogTools: toolDefinitionsOf(agent),
      codeTools,
    },
    subject,
  );
}

function modelReferenceOf(
  model: PortableAgent['model'],
  models: PortableAgentContext['models'],
): ModelReference | undefined {
  if (model === undefined) return undefined;
  const [connection] = Object.entries(models ?? {})
    .filter(
      ([, candidate]) => model.provider !== undefined && candidate.provider === model.provider,
    )
    .map(([name]) => name)
    .sort();
  return { connection: connection ?? 'default', id: model.id };
}

/** `base` (when a list), `autoApprove` and `deny` are sets of rules: their order carries no meaning. */
function withSortedRules(policy: AgentToolPolicy): AgentToolPolicy {
  return {
    ...policy,
    base: typeof policy.base === 'string' ? policy.base : [...policy.base].sort(),
    autoApprove: [...policy.autoApprove].sort(),
    deny: [...policy.deny].sort(),
  };
}

/**
 * The `autoApprove` rules of `tools` when the rest of it is the base policy `permissions` compiles
 * to — `defineAgent()` writes exactly that from `engine.autoApprove` — else `undefined`.
 */
function autoApproveOverBasePolicy(
  tools: unknown,
  portable: PortableAgent,
): readonly string[] | undefined {
  const parsed = AgentToolPolicySchema.safeParse(tools);
  if (!parsed.success) return undefined;
  const base = AgentToolPolicySchema.parse(claudeBaseToolPolicyFor(portable.permissions));
  return JSON.stringify(withSortedRules({ ...parsed.data, autoApprove: base.autoApprove })) ===
    JSON.stringify(withSortedRules(base))
    ? parsed.data.autoApprove
    : undefined;
}

/**
 * The reverse direction, through `defineAgent()` so every Agent Workspace check applies. A model
 * becomes the first of `context.models` (by name) with its provider, else `default`.
 *
 * @throws {DefinitionError} when the input is not a portable agent, or `defineAgent()` refuses what
 *   the input carries — an `extensions.engines` block with a setting its engine does not have.
 */
export function defineAgentFromPortable(
  agent: PortableAgentInput,
  context: Pick<PortableAgentContext, 'models'> = {},
): PortableConversion<DefinedAgent> {
  const subject = 'defineAgentFromPortable()';
  const parsed = PortableAgentSchema.safeParse(agent);
  if (!parsed.success) throw new DefinitionError(subject, issuesFromZod(parsed.error));
  const portable = parsed.data;
  const drops: PortableDrop[] = [];
  const drop = (path: string, reason: string): void => {
    drops.push({ path, reason });
  };

  const engine = portable.engine ?? DEFAULT_ENGINE_ID;
  const block = portable.extensions?.engines?.[engine] ?? {};
  const toolRules = ENGINE_CATALOGUE[engine].narrowing === 'tool-rules';
  const autoApprove =
    toolRules && Object.hasOwn(block, 'tools')
      ? autoApproveOverBasePolicy(block['tools'], portable)
      : [];
  if (autoApprove === undefined) {
    drop(
      `extensions.engines.${engine}.tools`,
      'a stored Claude tool policy cannot be written in defineAgent(); set it with aw agents policy',
    );
  }
  const nativeSettings = {
    ...Object.fromEntries(Object.entries(block).filter(([key]) => !(toolRules && key === 'tools'))),
    ...(autoApprove === undefined || autoApprove.length === 0 ? {} : { autoApprove }),
  };
  for (const other of Object.keys(portable.extensions?.engines ?? {})) {
    if (other !== engine) {
      drop(`extensions.engines.${other}`, 'settings for an engine this agent does not use');
    }
  }
  for (const platform of Object.keys(portable.extensions?.platforms ?? {})) {
    drop(
      `extensions.platforms.${platform}`,
      'platform options apply to aw platforms export, not to the agent',
    );
  }

  const tools: DefineTool[] = [];
  portable.tools.forEach((tool, index) => {
    const path = `tools.${index}`;
    if (tool.kind === 'mcp') {
      if (tool.transport === 'stdio') {
        drop(path, 'Agent Workspace project files name remote connectors only (http or sse)');
      } else {
        tools.push(mcp(tool.name));
      }
    } else if (tool.kind === 'code') {
      drop(path, 'a code tool needs its run file; declare it with defineTool()');
    } else if (tool.kind === 'openapi') {
      if (tool.allow === undefined) {
        drop(path, 'Agent Workspace needs explicit allow rules for an OpenAPI tool');
        return;
      }
      try {
        tools.push(
          openapiTool({
            name: tool.name,
            spec: tool.specRef,
            allow: tool.allow,
            ...(tool.baseUrl === undefined ? {} : { baseUrl: tool.baseUrl }),
            ...(tool.auth === undefined
              ? {}
              : {
                  auth:
                    tool.auth.header === undefined
                      ? { secret: tool.auth.secretRef }
                      : { header: tool.auth.header, credential: { secret: tool.auth.secretRef } },
                }),
          }),
        );
      } catch (error) {
        if (!(error instanceof DefinitionError)) throw error;
        drop(path, error.message);
      }
    } else {
      const permission = BUILTIN_SWITCH[tool.id];
      if (!portable.permissions[permission]) {
        drop(path, `grant permissions.${permission} to keep it`);
      }
    }
  });

  portable.skills.forEach((entry, index) => {
    if (entry.path !== `skills/${entry.name}`) {
      drop(`skills.${index}.path`, `a skill is read from skills/${entry.name}/ in the project`);
    }
  });
  const mcpConnectors = new Set(tools.filter(isMcpTool).map((tool) => tool.connector));
  const knowledge: KnowledgeSource[] = [];
  const grants: FileGrant[] = [];
  portable.knowledge.forEach((source, index) => {
    if (source.kind === 'url') {
      drop(
        `knowledge.${index}`,
        'Agent Workspace engines cannot read a URL knowledge source; add a connector or a file',
      );
    } else if (source.kind === 'connector' && !mcpConnectors.has(source.name)) {
      drop(`knowledge.${index}`, `its connector "${source.name}" was dropped from tools`);
    } else {
      if (source.kind === 'files' && source.access === 'read-write') {
        if (portable.permissions.writeFiles) {
          for (const path of source.paths) {
            if (!grants.some((grant) => grant.path === path))
              grants.push(files(path, 'read-write'));
          }
        } else {
          drop(`knowledge.${index}.access`, 'grant permissions.writeFiles to keep it read-write');
        }
      }
      knowledge.push(
        source.kind === 'files' ? { kind: 'files', paths: [...source.paths] } : source,
      );
    }
  });

  const model = modelReferenceOf(portable.model, context.models);
  const checked = DefineAgentInputSchema.safeParse({
    name: portable.name,
    ...(portable.description === undefined ? {} : { description: portable.description }),
    ...(portable.subagents.length === 0
      ? {}
      : { subagents: portable.subagents.map((subagent) => subagent.name) }),
    ...(knowledge.length === 0 ? {} : { knowledge }),
    instructions: portable.instructions,
    ...(model === undefined ? {} : { model }),
    ...(Object.keys(nativeSettings).length === 0
      ? portable.engine === undefined
        ? {}
        : { engine: portable.engine }
      : { engine: { id: engine, ...nativeSettings } }),
    permissions: portable.permissions,
    tools,
    skills: portable.skills.map((entry) => skill(entry.name)),
    ...(grants.length === 0 ? {} : { files: grants }),
    ...(portable.limits === undefined ? {} : { limits: portable.limits }),
  });
  if (!checked.success) throw new DefinitionError(subject, issuesFromZod(checked.error));
  return finish(defineAgent(checked.data), drops);
}
