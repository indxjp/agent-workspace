/**
 * `createResourceCatalogStoreProvider`: a workspace id is resolved to its scope once, and a workspace
 * that no longer exists is refused instead of opening a repository with no scope.
 */
import {
  createInMemoryCatalog,
  createInMemoryWorkspaceScopeResolver,
  type ResourceCatalogRepositoryProvider,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import { createResourceCatalogStoreProvider } from './store';

const WORKSPACE = 'aaaaaaaa-0000-4000-8000-00000000000b';

function provider() {
  const catalogs = createInMemoryCatalog();
  const known = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'catalog' }]);
  const asked: string[] = [];
  const opened: string[] = [];
  const scopes: WorkspaceScopeResolver = {
    ...known,
    forWorkspaceId: (workspaceId) => {
      asked.push(workspaceId);
      return known.forWorkspaceId(workspaceId);
    },
  };
  const repositories: ResourceCatalogRepositoryProvider = {
    forScope: (scope) => {
      opened.push(scope.workspaceId);
      return catalogs.forScope(scope);
    },
  };
  return {
    catalogs,
    provider: createResourceCatalogStoreProvider({ repositories, scopes }),
    asked,
    opened,
  };
}

describe('createResourceCatalogStoreProvider', () => {
  it('opens the catalog of the scope the workspace id resolves to', async () => {
    const h = provider();
    const catalog = await h.provider.forWorkspace(WORKSPACE);

    expect(h.asked).toEqual([WORKSPACE]);
    expect(h.opened).toEqual([WORKSPACE]);
    expect(catalog).toBeDefined();
  });

  it('refuses a workspace that no longer exists and opens nothing', async () => {
    const h = provider();

    await expect(h.provider.forWorkspace('gone')).rejects.toThrow(
      'workspace gone no longer exists',
    );
    expect(h.opened).toEqual([]);
  });
});
