import type {
  FieldVerdict,
  PlatformCapabilityKey,
  PlatformDropCode,
} from '@indx-workspace/contracts/platforms';
import { AGENT_PERMISSION_KEYS } from '@indx-workspace/contracts/agents';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';

/**
 * The path convention every translator reports in (ADR-0133 D7). `apiVersion`, `kind` and `name`
 * are identity and are not reported. Every other field of every agent is, once, in this order:
 * `toolEndpoint`, then per agent in `project.agents` order `<agent>.description`, `.instructions`,
 * `.model`, `.engine`, `.permissions.<key>`, `.tools.<i>`, `.skills.<i>`, `.knowledge.<i>`,
 * `.subagents.<i>`, `.limits.maxTurns`, `.limits.maxBudgetUsd`, `.extensions.engines.<id>` and
 * `.extensions.platforms.<id>`.
 *
 * With `withGeneratedDescriptions`, `<agent>.description` is also listed for an agent that has none,
 * for a target that generates one (A2A requires it) and reports it as `mapped`.
 */
export function portableFieldPaths(
  project: PortableProject,
  options: { readonly withGeneratedDescriptions?: boolean } = {},
): readonly string[] {
  const paths: string[] = [];
  if (project.toolEndpoint !== undefined) paths.push('toolEndpoint');
  for (const agent of project.agents) {
    const at = (field: string): string => `${agent.name}.${field}`;
    if (agent.description !== undefined || options.withGeneratedDescriptions === true) {
      paths.push(at('description'));
    }
    paths.push(at('instructions'));
    if (agent.model !== undefined) paths.push(at('model'));
    if (agent.engine !== undefined) paths.push(at('engine'));
    for (const key of AGENT_PERMISSION_KEYS) paths.push(at(`permissions.${key}`));
    agent.tools.forEach((_, index) => paths.push(at(`tools.${index}`)));
    agent.skills.forEach((_, index) => paths.push(at(`skills.${index}`)));
    agent.knowledge.forEach((_, index) => paths.push(at(`knowledge.${index}`)));
    agent.subagents.forEach((_, index) => paths.push(at(`subagents.${index}`)));
    if (agent.limits?.maxTurns !== undefined) paths.push(at('limits.maxTurns'));
    if (agent.limits?.maxBudgetUsd !== undefined) paths.push(at('limits.maxBudgetUsd'));
    for (const id of Object.keys(agent.extensions?.engines ?? {})) {
      paths.push(at(`extensions.engines.${id}`));
    }
    for (const id of Object.keys(agent.extensions?.platforms ?? {})) {
      paths.push(at(`extensions.platforms.${id}`));
    }
  }
  return paths;
}

const SIMPLE_FIELD_CAPABILITY = {
  description: 'description',
  instructions: 'instructions',
  model: 'model',
  engine: 'engine',
  permissions: 'permissions',
  skills: 'skills',
  subagents: 'subagents',
  limits: 'limits',
} as const satisfies Record<string, PlatformCapabilityKey>;

function toolCapability(tool: PortableAgent['tools'][number]): PlatformCapabilityKey {
  switch (tool.kind) {
    case 'mcp':
      return tool.transport === 'stdio' ? 'mcpStdio' : 'mcpRemote';
    case 'code':
      return 'codeTools';
    case 'openapi':
      return 'openapiTools';
    case 'builtin':
      return 'builtinTools';
  }
}

function knowledgeCapability(source: PortableAgent['knowledge'][number]): PlatformCapabilityKey {
  switch (source.kind) {
    case 'files':
      return 'knowledgeFiles';
    case 'url':
      return 'knowledgeUrls';
    case 'connector':
      return 'knowledgeConnectors';
  }
}

/**
 * The capability a reported path is governed by, or `null` when none is: `toolEndpoint`,
 * `extensions.platforms.*` (the target's own options) and a path that is not in
 * {@link portableFieldPaths}.
 */
export function capabilityOfPath(
  project: PortableProject,
  path: string,
): PlatformCapabilityKey | null {
  const dot = path.indexOf('.');
  if (dot < 0) return null;
  const agent = project.agents.find((candidate) => candidate.name === path.slice(0, dot));
  if (agent === undefined) return null;
  const [field, ...rest] = path.slice(dot + 1).split('.');
  if (field === undefined) return null;
  const index = Number(rest[0]);
  switch (field) {
    case 'tools': {
      const tool = agent.tools[index];
      return tool === undefined ? null : toolCapability(tool);
    }
    case 'knowledge': {
      const source = agent.knowledge[index];
      return source === undefined ? null : knowledgeCapability(source);
    }
    case 'extensions':
      return rest[0] === 'engines' ? 'engine' : null;
    default:
      return Object.hasOwn(SIMPLE_FIELD_CAPABILITY, field)
        ? SIMPLE_FIELD_CAPABILITY[field as keyof typeof SIMPLE_FIELD_CAPABILITY]
        : null;
  }
}

export function native(path: string, note: string): FieldVerdict {
  return Object.freeze({ path, verdict: 'native', note });
}

export function mapped(path: string, note: string): FieldVerdict {
  return Object.freeze({ path, verdict: 'mapped', note });
}

export function dropped(path: string, code: PlatformDropCode, note: string): FieldVerdict {
  return Object.freeze({ path, verdict: 'dropped', code, note });
}
