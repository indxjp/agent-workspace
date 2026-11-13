import {
  type PortableDrop,
  type PortableConversion,
  type PortableAgentContext,
  finish,
} from './convert-contract.js';

import {
  AgentToolPolicySchema,
  claudeBaseToolPolicyFor,
  type AgentPermissionKey,
  type AgentToolPolicy,
} from '@indx-workspace/contracts/agents';
import { DEFAULT_ENGINE_ID, ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import {
  PortableAgentSchema,
  type PORTABLE_BUILTIN_TOOL_IDS,
  type PortableAgent,
  type PortableAgentInput,
} from '@indx-workspace/contracts/portable-agent';

import {
  DefineAgentInputSchema,
  defineAgent,
  type DefineTool,
  type DefinedAgent,
  type KnowledgeSource,
  type ModelReference,
} from '../define/agent.js';
import { DefinitionError, issuesFromZod } from '../define/errors.js';
import { isMcpTool, files, mcp, openapiTool, skill, type FileGrant } from '../define/references.js';

/** The permission switch whose absence makes a builtin tool unreachable. */
const BUILTIN_SWITCH = {
  web_search: 'unrestrictedNetwork',
  web_fetch: 'unrestrictedNetwork',
  file_access: 'readFiles',
  code_execution: 'runCommands',
} as const satisfies Record<(typeof PORTABLE_BUILTIN_TOOL_IDS)[number], AgentPermissionKey>;

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

function definedToolsOf(
  portable: PortableAgent,
  drop: (path: string, reason: string) => void,
): DefineTool[] {
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

  return tools;
}

function definedKnowledgeOf(
  portable: PortableAgent,
  tools: readonly DefineTool[],
  drop: (path: string, reason: string) => void,
) {
  const mcpConnectors = new Set(tools.filter(isMcpTool).map((tool) => tool.connector));
  const knowledge: KnowledgeSource[] = [];
  const grants: FileGrant[] = [];
  portable.knowledge.forEach((source, index) => {
    if (source.kind === 'url') {
      drop(
        `knowledge.${index}`,
        'Agent Workspace engines cannot read a URL knowledge source; add a connector or a file',
      );
      return;
    }
    if (source.kind === 'connector' && !mcpConnectors.has(source.name)) {
      drop(`knowledge.${index}`, `its connector "${source.name}" was dropped from tools`);
      return;
    }
    if (source.kind === 'files' && source.access === 'read-write') {
      if (!portable.permissions.writeFiles) {
        drop(`knowledge.${index}.access`, 'grant permissions.writeFiles to keep it read-write');
      } else {
        for (const path of source.paths) {
          if (!grants.some((grant) => grant.path === path)) grants.push(files(path, 'read-write'));
        }
      }
    }
    knowledge.push(source.kind === 'files' ? { kind: 'files', paths: [...source.paths] } : source);
  });

  return { knowledge, grants };
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

  const tools = definedToolsOf(portable, drop);

  portable.skills.forEach((entry, index) => {
    if (entry.path !== `skills/${entry.name}`) {
      drop(`skills.${index}.path`, `a skill is read from skills/${entry.name}/ in the project`);
    }
  });
  const { knowledge, grants } = definedKnowledgeOf(portable, tools, drop);

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
