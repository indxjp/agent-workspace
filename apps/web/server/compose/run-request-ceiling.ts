import type { AgentPermissions } from '@agent-workspace/run-protocol';

import {
  meetPolicyCeiling,
  policyWidenings,
  type EffectivePolicyConfiguration,
  type PolicyWidening,
  type ProjectPolicy,
} from '@indx-workspace/contracts/policy-ceiling';

import {
  AGENT_PERMISSION_KEYS,
  agentMemoryEnabled,
  type AgentPermissionKey,
  policyNarrowedPermissions,
} from '../../contracts/agents';
import type { AgentRecord } from '../agents/contract';
import { DomainError } from '../errors';
import { storedEffective } from '../policy-ceiling/ceiling';
import type { RunAgent } from '../agent-versions/session-version';
import type { AgentRunResourceLoader, AgentRunResourceSelection } from './resource-loader';

/** The switches the ceiling turned off: on after the withholding narrowing, off after the meet. */
export function ceilingCapsFor(
  permissions: AgentPermissions,
  policy: AgentRecord['policy'],
  met: AgentPermissions,
): AgentPermissionKey[] {
  const narrowed = policyNarrowedPermissions(permissions, policy);
  return AGENT_PERMISSION_KEYS.filter((key) => narrowed[key] && !met[key]);
}

/** The sentence a `policy_cannot_widen` run refusal carries, naming each detail in C14 order. */
export function ceilingRefusalMessage(refused: readonly PolicyWidening[]): string {
  return (
    "the run asks for more than this deployment's policy ceiling allows: " +
    `${refused.join(', ')}. Choose an engine and a model the ceiling lists.`
  );
}

/**
 * A run met with the deployment's policy ceiling (S2-04c, C14, ADR-0102 SD6): `met` is the stored
 * configuration (permissions after the stored arm's withholding, the stored limits, the engine and
 * the resolved `model`) narrowed by `meetPolicyCeiling`, and `refused` is what the meet cannot
 * narrow — by the contract only `engine:` and `model:` entries, which refuse the run. A `null`
 * ceiling meets to the input and refuses nothing. Tools are judged separately, once the loader has
 * named the run's connectors.
 */
export function meetRunCeiling(
  stored: {
    readonly agent: Pick<AgentRecord, 'policy'>;
    readonly permissions: AgentPermissions;
    readonly model: string | null;
    readonly subagentModels?: readonly (string | null)[] | undefined;
  },
  ceiling: ProjectPolicy | null,
): { readonly met: EffectivePolicyConfiguration; readonly refused: readonly PolicyWidening[] } {
  const { agent, permissions, model, subagentModels = [] } = stored;
  const met = meetPolicyCeiling(
    storedEffective({ permissions, policy: agent.policy }, model, []),
    ceiling,
  );
  const refused = [...policyWidenings(met, ceiling)];
  // A subagent's own model is judged like the parent's; its other switches only ever narrow.
  for (const subagentModel of subagentModels) {
    if (subagentModel === null) continue;
    for (const widening of policyWidenings({ ...met, model: subagentModel }, ceiling)) {
      if (widening.startsWith('model:') && !refused.includes(widening)) refused.push(widening);
    }
  }
  return { met, refused };
}

/**
 * The loaded resources without the connectors the ceiling's `tools` does not allow, decided by
 * `meetPolicyCeiling` over their names (C14: no copy of the rule). An MCP entry the loader named no
 * connector for is judged as the empty name, which no ceiling lists, so a `tools` ceiling drops it.
 */
function resourcesWithinCeiling(
  resources: AgentRunResourceSelection,
  met: EffectivePolicyConfiguration,
  ceiling: ProjectPolicy | null,
): AgentRunResourceSelection {
  if (ceiling === null) return resources;
  const names = resources.connectorNames ?? {};
  const nameOf = (key: string): string => names[key] ?? '';
  const pending = resources.toolConnectors ?? [];
  const kept = new Set(
    meetPolicyCeiling(
      {
        ...met,
        tools: [...Object.keys(resources.mcpServers).map(nameOf), ...pending.map((c) => c.name)],
      },
      ceiling,
    ).tools,
  );
  return {
    ...resources,
    mcpServers: Object.fromEntries(
      Object.entries(resources.mcpServers).filter(([key]) => kept.has(nameOf(key))),
    ),
    toolConnectors: pending.filter((connector) => kept.has(connector.name)),
  };
}

/** Where a run's resources come from: the loader, the deployment's ceiling and the session's project. */
export interface RunResourceSources {
  readonly resourceLoader?: AgentRunResourceLoader | undefined;
  readonly ceiling: ProjectPolicy | null;
  readonly projectId: string | null;
}

export async function loadResourcesWithinCeiling(
  workspaceId: string,
  runAgent: RunAgent,
  narrowed: {
    readonly permissions: AgentPermissions;
    readonly met: EffectivePolicyConfiguration;
  },
  { resourceLoader, ceiling, projectId }: RunResourceSources,
): Promise<AgentRunResourceSelection> {
  const { permissions, met } = narrowed;
  return resourcesWithinCeiling(
    resourceLoader === undefined
      ? { files: [], skills: [], mcpServers: {} }
      : await resourceLoader.load(
          workspaceId,
          runAgent.assignments,
          projectId,
          met.permissions,
          ceilingCapsFor(permissions, runAgent.agent.policy, met.permissions),
          // ADR-0163: the memory folder is read only for a run whose met permissions keep it.
          agentMemoryEnabled(met.permissions) ? runAgent.agent.id : null,
        ),
    met,
    ceiling,
  );
}

/** The run met with the ceiling ({@link meetRunCeiling}), or the `policy_cannot_widen` refusal. */
export function assertWithinCeiling(
  runAgent: RunAgent,
  permissions: AgentPermissions,
  model: string | null,
  ceiling: ProjectPolicy | null,
): EffectivePolicyConfiguration {
  const { met, refused } = meetRunCeiling(
    {
      agent: runAgent.agent,
      permissions,
      model,
      subagentModels: runAgent.subagents.map((sub) => sub.model),
    },
    ceiling,
  );
  if (refused.length > 0) {
    // Built here rather than through `runStartRefusalError`, which would import this module back.
    throw new DomainError({
      category: 'validation',
      code: 'policy_cannot_widen',
      publicMessage: `policy_cannot_widen: ${ceilingRefusalMessage(refused)}`,
    });
  }
  return met;
}
