/**
 * The port for an agent's resource assignments (files, skills, connectors, storage grants). Its
 * types are the published wire shapes (`@indx-workspace/contracts/agents`), not database records;
 * the database-backed implementation is `createRepositoryAgentResourceStoreProvider` in
 * `./store.ts`, the one file of this domain that names `@agent-workspace/core/db`.
 */
import type {
  AgentResourceAssignments,
  AgentResourceAssignmentsInput,
} from '@indx-workspace/contracts/agents';

/** What replacing an agent's assignments can produce. */
export type ReplaceAgentResourcesOutcome =
  | { readonly kind: 'updated'; readonly assignments: AgentResourceAssignments }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unknown-file'; readonly id: string }
  | { readonly kind: 'unknown-skill'; readonly id: string }
  /** A delete of the skill is under way: it cannot be assigned any more (the mark is never undone). */
  | { readonly kind: 'skill-deleting'; readonly id: string }
  | { readonly kind: 'unknown-skill-revision'; readonly id: string; readonly revision: number }
  | { readonly kind: 'unknown-connector'; readonly id: string };

export interface WorkspaceAgentResourceStore {
  get(agentId: string): Promise<AgentResourceAssignments | null>;
  replace(
    agentId: string,
    assignments: AgentResourceAssignmentsInput,
  ): Promise<ReplaceAgentResourcesOutcome>;
}

export interface AgentResourceStoreProvider {
  forWorkspace(workspaceId: string): WorkspaceAgentResourceStore;
}
