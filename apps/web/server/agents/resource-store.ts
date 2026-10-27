import type {
  AgentResourceAssignments,
  AgentResourceAssignmentsInput,
  AgentResourceRepository,
  AgentResourceRepositoryProvider,
  ReplaceAgentResourcesOutcome,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';

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

export function createRepositoryAgentResourceStoreProvider(dependencies: {
  readonly repositories: AgentResourceRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
}): AgentResourceStoreProvider {
  return {
    forWorkspace(workspaceId) {
      let pending: Promise<AgentResourceRepository> | null = null;
      const repository = async () => {
        pending ??= dependencies.scopes.forWorkspaceId(workspaceId).then((scope) => {
          if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
          return dependencies.repositories.forScope(scope);
        });
        return pending;
      };
      return {
        async get(agentId) {
          return (await repository()).get(agentId);
        },
        async replace(agentId, assignments) {
          return (await repository()).replace(agentId, assignments);
        },
      };
    },
  };
}
