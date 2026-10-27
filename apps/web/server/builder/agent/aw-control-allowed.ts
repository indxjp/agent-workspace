import { builderAllows, type ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import type { AgentRecord } from '../../agents/contract';
import { isBuilderAgent } from './is-builder-agent';

/**
 * Whether a run of `agent` gets the `aw-control` door (#1846, #1851): the Builder, or an agent the
 * deployment's `builder.allow` names (an exact match, as {@link builderAllows}) that a person made.
 * `deploymentCeiling` is `AW_DEPLOYMENT_POLICY` and nothing else, so a project file never grants it.
 * The composition and the door both ask this, so a run holding a token without the server is refused.
 */
export function awControlAllowed(
  agent: Pick<AgentRecord, 'builtin' | 'name' | 'createdByAgent'>,
  deploymentCeiling: ProjectPolicy | null,
): boolean {
  return (
    isBuilderAgent(agent) ||
    (agent.createdByAgent == null && builderAllows(deploymentCeiling, agent.name))
  );
}
