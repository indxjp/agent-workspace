/**
 * The port `POST /api/agents/:id/runs` uses to check a Viewer's explicit `agent_grants` row
 * (spec §21, issue #117). Mirrors `store.ts`'s shape exactly; the database-backed implementation,
 * `createRepositoryAgentGrantStoreProvider`, is in `./store.ts`.
 */
/** Grant lookups for exactly one workspace. No method takes a workspace id (§25). */
export interface WorkspaceAgentGrantStore {
  /** Whether an `agent_grants` row names this exact (agent, user) pair in this workspace. */
  hasGrant(agentId: string, userId: string): Promise<boolean>;
  listPrincipalIds(agentId: string): Promise<readonly string[] | null>;
  replacePrincipalIds(
    agentId: string,
    principalIds: readonly string[],
  ): Promise<
    | { readonly kind: 'updated'; readonly principalIds: readonly string[] }
    | { readonly kind: 'agent-not-found' }
    | { readonly kind: 'principal-not-found'; readonly principalId: string }
  >;
}

/** Hands out a {@link WorkspaceAgentGrantStore} bound to one workspace. */
export interface AgentGrantStoreProvider {
  forWorkspace(workspaceId: string): WorkspaceAgentGrantStore;
}
