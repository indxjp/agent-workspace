import type {
  ResourceCatalogRepository,
  ResourceCatalogRepositoryProvider,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';

export interface ResourceCatalogStoreProvider {
  forWorkspace(workspaceId: string): Promise<ResourceCatalogRepository>;
}

export function createResourceCatalogStoreProvider(dependencies: {
  readonly repositories: ResourceCatalogRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
}): ResourceCatalogStoreProvider {
  return {
    async forWorkspace(workspaceId) {
      const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
      return dependencies.repositories.forScope(scope);
    },
  };
}
