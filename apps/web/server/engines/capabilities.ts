/**
 * The save-time capability check (ADR-0065 D3, ENG-02b): an agent is never *saved* with connectors
 * or skills its engine cannot honour.
 *
 * D3 is "refuse, never ignore". An engine that cannot speak MCP handed an agent with a connector
 * has two honest outcomes — refuse the agent, or run it without its connector — and only the first
 * is one the caller can act on. The second is the failure mode this module exists to make
 * impossible: a connector silently dropped is a capability the operator believes is configured.
 *
 * The check is deliberately **about the assignments, not about the policy arm**. What an engine has
 * to materialise is the MCP servers and `SKILL.md` files the platform hands it, and those come from
 * the agent's resource assignments (`agent_mcp_servers`, `agent_skills`) narrowed by the saved
 * policy's skill allowlist. A run narrows further, dropping disabled skills and connectors
 * (`apps/web/server/compose/resource-loader.ts`); this check does not, because enablement changes
 * without a save of the agent and a re-enabled resource would otherwise reach an engine that cannot
 * honour it (`apps/web/server/agents/policy.ts`'s `demandsSkills`). So the demand below is a fact
 * about what the agent is *assigned*, and the capabilities are a fact about the engine; neither is a
 * fact about the request that happens to be in flight.
 *
 * This module is pure and knows nothing about HTTP. `apps/web/server/agents/policy.ts` turns its
 * answer into the `422 engine_capability_unsupported` the two save routes return.
 */
import type { EngineCapabilities, EngineCapabilityKey } from '@indx-workspace/contracts/engines';

/**
 * What one agent would make its engine honour, as booleans rather than counts.
 *
 * Counts are what the caller has; presence is what the decision reads. Naming the booleans keeps
 * the decision from acquiring a threshold it does not have — "more than three connectors" is not a
 * capability question — and makes the theorem about it finite
 * (`formal/AgentWorkspace/Behaviour/Engines.lean`'s `AssignmentDemand`).
 */
export interface EngineCapabilityDemand {
  /** The agent is assigned at least one MCP connector. */
  readonly connectors: boolean;
  /** At least one assigned skill is let through by the agent's saved skill policy. */
  readonly skills: boolean;
  /**
   * The agent's version body names at least one subagent. Absent for the callers that have no
   * version body (the agent and policy routes).
   */
  readonly subagents?: boolean;
}

/**
 * The capability this engine would need and does not have, or `null` when it can honour the agent.
 *
 * Connectors are consulted before skills, and skills before subagents, so a refusal names one
 * capability rather than a set. That is a deliberate narrowing of ADR-0065 D3's "refusing naming at
 * least one concept that is not supported": the caller fixes one thing at a time, and a second save
 * answers the second capability.
 */
export function unsupportedEngineCapability(
  capabilities: EngineCapabilities,
  demand: EngineCapabilityDemand,
): EngineCapabilityKey | null {
  if (demand.connectors && !capabilities.mcp) return 'mcp';
  if (demand.skills && !capabilities.skills) return 'skills';
  if (demand.subagents === true && !capabilities.subagents) return 'subagents';
  return null;
}

/** The sentence a refusal explains itself with. Names the engine, the capability and the fix. */
export function engineCapabilityRefusalMessage(
  engineId: string,
  capability: EngineCapabilityKey,
): string {
  const assigned = capability === 'mcp' ? 'connectors' : capability;
  return (
    `The engine '${engineId}' does not support ${capability}, and this agent is assigned ` +
    `${assigned}. Remove the ${assigned} or choose an engine that supports ${capability}; they ` +
    'are never silently dropped from a run.'
  );
}
