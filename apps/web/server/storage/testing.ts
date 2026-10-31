/**
 * Test support: the object stores a test world builds a catalog service over (the storage design,
 * §07 rule 3). The fixtures outside `storage/` take them from here, never from
 * `packages/core/src/storage`. Production opens its stores in `composition/storage.ts`.
 */
export {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  openRootObjectStore,
} from '@agent-workspace/core/storage';
