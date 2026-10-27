/**
 * The port `POST /api/agents/:id/runs` uses to check a Viewer's explicit `agent_grants` row
 * (spec §21, issue #117). Mirrors `store.ts`'s shape exactly.
 */
import {
  UnknownWorkspaceError,
  type AgentGrantRepositoryProvider as CoreAgentGrantRepositoryProvider,
  type WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

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

/** What {@link createRepositoryAgentGrantStoreProvider} needs, and the whole of it. */
export interface RepositoryAgentGrantStoreDependencies {
  readonly repositories: CoreAgentGrantRepositoryProvider;
  readonly scopes: CoreWorkspaceScopeResolver;
}

/** The database-backed {@link AgentGrantStoreProvider}. Copies `store.ts`'s memoised-scope shape. */
export function createRepositoryAgentGrantStoreProvider(
  dependencies: RepositoryAgentGrantStoreDependencies,
): AgentGrantStoreProvider {
  return {
    forWorkspace(workspaceId: string): WorkspaceAgentGrantStore {
      let pending: Promise<ReturnType<CoreAgentGrantRepositoryProvider['forScope']>> | null = null;
      const repository = (): Promise<ReturnType<CoreAgentGrantRepositoryProvider['forScope']>> => {
        pending ??= (async () => {
          const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
          if (scope === null) throw new UnknownWorkspaceError(workspaceId);
          return dependencies.repositories.forScope(scope);
        })();
        return pending;
      };

      return {
        async hasGrant(agentId: string, userId: string): Promise<boolean> {
          return (await repository()).hasGrant(agentId, userId);
        },
        async listPrincipalIds(agentId: string): Promise<readonly string[] | null> {
          return (await repository()).listPrincipalIds(agentId);
        },
        async replacePrincipalIds(agentId: string, principalIds: readonly string[]) {
          return (await repository()).replacePrincipalIds(agentId, principalIds);
        },
      };
    },
  };
}
