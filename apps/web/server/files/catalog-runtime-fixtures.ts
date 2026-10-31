/**
 * A files runtime over the catalog service, on in-memory stores, for the tests that drive the
 * `/api/files` routes: every route answers `503 files_runtime_not_configured` without a `storage`.
 *
 * `legacy` is the per-area files store the runtime's `store` hands out; the catalog service never
 * reads it.
 */
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import type { ObjectStore } from '../storage/objects';
import { createStorageService, type StorageService } from '../storage/service';
import { createInMemoryObjectStore, createInMemoryObjectStoreProvider } from '../storage/testing';
import type { FilesRuntime } from './runtime';
import { createRepositoryObjectStoreProvider } from './store';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

export interface CatalogFilesWorld {
  readonly runtime: FilesRuntime;
  readonly storage: StorageService;
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly objects: ObjectStore;
  readonly legacy: ReturnType<typeof createInMemoryObjectStoreProvider>;
}

/**
 * The test passes the in-memory `catalogs` (`createInMemoryCatalogStore()`) and `scopes`
 * (`createInMemoryWorkspaceScopeResolver(...)`): a web domain file names neither module, only a test may.
 */
export function createCatalogFilesWorld(options: {
  readonly scopes: Parameters<typeof createRepositoryObjectStoreProvider>[0]['scopes'];
  readonly resolveWorkspace: FilesRuntime['resolveWorkspace'];
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly objects?: ObjectStore;
  /** `false` leaves the catalog service out, as a deployment without `AW_STORAGE_URL` does. */
  readonly withStorage?: boolean;
  /** What the service logs to; silent unless a test reads the log. */
  readonly log?: Parameters<typeof createStorageService>[0]['log'];
}): CatalogFilesWorld {
  const { catalogs, scopes } = options;
  const objects = options.objects ?? createInMemoryObjectStore();
  const legacy = createInMemoryObjectStoreProvider();
  const storage = createStorageService({
    catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
    objects,
    log: options.log ?? noLog,
  });
  const runtime: FilesRuntime = {
    store: createRepositoryObjectStoreProvider({ store: legacy, scopes }),
    catalog: catalogs,
    resolveWorkspace: options.resolveWorkspace,
    ...(options.withStorage === false ? {} : { storage }),
  };
  return { runtime, storage, catalogs, objects, legacy };
}
