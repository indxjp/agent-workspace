// The shared in-memory catalog as a web catalog provider (the storage design, §07 rule 4).
import { createInMemoryCatalog } from '@agent-workspace/core/db';

import type { ResourceCatalogStoreProvider } from './catalog-store';

/** The memory workspace catalog, which carries test hooks such as `assignSkill`. */
type MemoryWorkspaceCatalog = ReturnType<ReturnType<typeof createInMemoryCatalog>['forWorkspace']>;

export function createInMemoryCatalogStore(): ResourceCatalogStoreProvider & {
  /** The same object on every call for one workspace, so a test can spy on it before a request. */
  forWorkspaceSync(workspaceId: string): MemoryWorkspaceCatalog;
} {
  const catalog = createInMemoryCatalog();
  const workspaces = new Map<string, MemoryWorkspaceCatalog>();
  const forWorkspaceSync = (workspaceId: string): MemoryWorkspaceCatalog => {
    const existing = workspaces.get(workspaceId);
    if (existing !== undefined) return existing;
    const created = catalog.forWorkspace(workspaceId);
    workspaces.set(workspaceId, created);
    return created;
  };
  return {
    forWorkspace: (workspaceId) => Promise.resolve(forWorkspaceSync(workspaceId)),
    forWorkspaceSync,
  };
}
