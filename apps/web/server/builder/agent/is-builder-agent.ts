import type { AgentRecord } from '../../agents/contract';

/** Whether `agent` is the built-in Builder, the one agent that may reach `aw-control`. */
export function isBuilderAgent(agent: Pick<AgentRecord, 'builtin'>): boolean {
  return agent.builtin === 'builder';
}
