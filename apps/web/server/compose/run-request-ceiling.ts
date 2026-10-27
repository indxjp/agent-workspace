import type { AgentPermissions } from '@agent-workspace/run-protocol';

import {
  meetPolicyCeiling,
  type EffectivePolicyConfiguration,
  type PolicyWidening,
  type ProjectPolicy,
} from '@indx-workspace/contracts/policy-ceiling';

import {
  AGENT_PERMISSION_KEYS,
  type AgentPermissionKey,
  policyNarrowedPermissions,
} from '../../contracts/agents';
import type { AgentRecord } from '../agents/contract';
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

export async function loadResourcesWithinCeiling(
  workspaceId: string,
  runAgent: RunAgent,
  permissions: AgentPermissions,
  met: EffectivePolicyConfiguration,
  resourceLoader: AgentRunResourceLoader | undefined,
  ceiling: ProjectPolicy | null,
  projectId: string | null,
): Promise<AgentRunResourceSelection> {
  return resourcesWithinCeiling(
    resourceLoader === undefined
      ? { files: [], skills: [], mcpServers: {} }
      : await resourceLoader.load(
          workspaceId,
          runAgent.assignments,
          projectId,
          met.permissions,
          ceilingCapsFor(permissions, runAgent.agent.policy, met.permissions),
        ),
    met,
    ceiling,
  );
}
