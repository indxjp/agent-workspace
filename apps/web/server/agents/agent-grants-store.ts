/**
 * The port `POST /api/agents/:id/runs` uses to check a Viewer's explicit `agent_grants` row
 * (spec §21, issue #117). Mirrors `store.ts`'s shape exactly — see that file's header for why
 * every reference to `@agent-workspace/core/db` here is `import type` only.
 */
import type {
  AgentGrantRepositoryProvider as CoreAgentGrantRepositoryProvider,
  WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
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

/**
 * Thrown when a store is asked for a workspace no `workspaces` row names. Transcribed rather than
 * imported — see `store.ts`'s own copy of this class for the edge-safety reason.
 */
export class UnknownWorkspaceError extends Error {
  public readonly workspaceId: string;

  public constructor(workspaceId: string) {
    super(
      `no workspace has id ${workspaceId}; an agent grant store cannot be scoped to a ` +
        'workspace that does not exist',
    );
    this.name = 'UnknownWorkspaceError';
    this.workspaceId = workspaceId;
  }
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
