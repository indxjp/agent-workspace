import { portableToolsOf } from './convert-tools.js';

export { defineAgentFromPortable } from './convert-definition.js';
import {
  type PortableDrop,
  type PortableConversion,
  type PortableAgentContext,
  own,
  finish,
} from './convert-contract.js';
export {
  type PortableDrop,
  type PortableConversion,
  type PortableCodeToolDeclaration,
  type PortableAgentContext,
} from './convert-contract.js';
import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import {
  engineSettingsOf,
  policyNarrowedPermissions,
  type AgentPolicy,
} from '@indx-workspace/contracts/agents';

import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  PortableAgentSchema,
  PortableKnowledgeSourceSchema,
  type PortableAgent,
} from '@indx-workspace/contracts/portable-agent';
import { NAME_KEY_PATTERN, type ProjectDocument } from '@indx-workspace/contracts/project-file';

import { type DefinedAgent } from '../define/agent.js';
import { DefinitionError, issuesFromZod } from '../define/errors.js';
import { isCodeTool } from '../define/references.js';
import {
  toAgentVersionBody,
  toolDefinitionsOf,
  type ToAgentVersionBodyOptions,
} from '../define/version-body.js';

/** What `tools` can say about an engine: its catalogue settings, plus Claude's tool grammar. */
function engineBlockOf(policy: AgentPolicy): Record<string, unknown> {
  return {
    ...engineSettingsOf(policy),
    ...('tools' in policy ? { tools: policy.tools } : {}),
  };
}

/** Validate each source atomically, preserving its drop-report position on failure. */
function portableKnowledgeOf(
  body: AgentVersionBody,
  writable: ReadonlySet<string>,
  drop: (path: string, reason: string) => void,
): unknown[] {
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

  return knowledge;
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

  const knowledge = portableKnowledgeOf(body, writable, drop);

  const tools = portableToolsOf(body, context, drop);

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
