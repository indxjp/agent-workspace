import { UnknownWorkspaceError, type WorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import { describe, expect, it } from 'vitest';

import { createRepositoryObjectStoreProvider } from './store';

const WORKSPACE = '88888888-8888-4888-8888-888888888888';

/** A resolver that finds no workspace at all. */
const NO_SCOPES: WorkspaceScopeResolver = {
  forWorkspaceId: () => Promise.resolve(null),
  forWorkspaceSlug: () => Promise.resolve(null),
};

describe('createRepositoryObjectStoreProvider', () => {
  const provider = createRepositoryObjectStoreProvider({
    store: createInMemoryObjectStoreProvider(),
    scopes: NO_SCOPES,
  });

  it('rejects every streaming member for an unknown workspace before reaching the store', async () => {
    const store = provider.forWorkspace(WORKSPACE);
    await expect(store.head('a.txt')).rejects.toBeInstanceOf(UnknownWorkspaceError);
    await expect(store.read('a.txt')).rejects.toBeInstanceOf(UnknownWorkspaceError);
    await expect(store.write('a.txt', new Uint8Array([1]), {})).rejects.toBeInstanceOf(
      UnknownWorkspaceError,
    );
    await expect(store.listPage('')).rejects.toBeInstanceOf(UnknownWorkspaceError);
  });

  it("reports the backend's own capabilities for a valid workspace", () => {
    const backend = createInMemoryObjectStoreProvider();
    expect(provider.forWorkspace(WORKSPACE).capabilities).toEqual(
      backend.forWorkspace(WORKSPACE).capabilities,
    );
    expect(provider.forWorkspace(WORKSPACE).capabilities.range).toBe(true);
  });

  it('reports no capabilities for an id the backend refuses', () => {
    expect(provider.forWorkspace('').capabilities).toEqual({
      sign: false,
      boundLengthSign: false,
      range: false,
      conditionalPut: false,
      fileAndFolderShareKey: false,
    });
  });
});
