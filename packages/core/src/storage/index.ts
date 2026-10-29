/**
 * `packages/core/src/storage` — spec §16's `ObjectStore`, over local filesystem today and over
 * S3-compatible stores once `docs/adr/W2-CP-03-object-key-safety.md`'s declared dependency gap is closed at
 * the integration level.
 *
 * This barrel is deliberately small, in the spirit `packages/core/src/db/index.ts` already
 * established for the repository layer: it re-exports the types and factories a consumer needs
 * (cloud backends only through `openObjectStore`) and none of this module's internals
 * (`toFsPath`, the content-type sidecar helpers, and so on).
 *
 * **It is also a *runtime* surface, and nothing behind it may import a test framework.** Every
 * module reachable from here is evaluated by `apps/web`'s files routes in a running server, where
 * `vitest` is neither installed nor resolvable. `contract.ts` is the one module in this directory
 * that imports it, and the comment above that export's absence, below, is the whole story.
 */
export { inferContentType } from './content-type.js';

export {
  clampListLimit,
  createScopedObjectStore,
  InvalidWorkspaceIdError,
  ObjectConflictError,
  RangeNotSatisfiableError,
  scopedObjectStoreProvider,
  type ByteRange,
  type ListPageOptions,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectMeta,
  type ObjectPage,
  type ObjectStoreCapabilities,
  type ObjectStream,
  type ObjectStore,
  type ObjectStoreProvider,
  type SignedUrl,
  type SignedUrlRequest,
  SignedUrlUnsupportedError,
  type WriteOptions,
} from './object-store.js';

export {
  evaluateRelativePath,
  OBJECT_METADATA_MARKER,
  OBJECT_METADATA_SUFFIX,
  toObjectKey,
  toObjectPrefix,
  UnsafeObjectKeyError,
  type ObjectKeyRejectionRule,
  type SafeRelativePath,
} from './key-safety.js';

export { withKeyLock } from './key-lock.js';

export {
  bytesToStream,
  listPageFrom,
  readBytes,
  resolveRange,
  streamToBytes,
  toNodeReadable,
  toWebStream,
} from './streams.js';

export {
  createLocalFilesystemObjectStore,
  createLocalFilesystemObjectStoreProvider,
} from './local-fs-store.js';

// Cloud backends are reached only through `openObjectStore`, which imports the one backend file a
// deployment uses; re-exporting their values here would load every cloud library with this barrel
// (the storage design, §02). Their types cost nothing at run time.
export { openObjectStore, openRootObjectStore, type OpenObjectStoreOptions } from './open.js';
export {
  ConnectionStoreError,
  openConnectionStore,
  resolveFileRoot,
  ReadOnlyStoreError,
  storageProviderStatus,
  storageRefusalClass,
  type ConnectionCredential,
  type StorageRefusalClass,
  type ConnectionStoreOptions,
} from './connection-store.js';
export {
  newObjectId,
  parseStorageObjectName,
  storageAreas,
  storageObjectName,
  workspaceFolder,
  type StorageArea,
  type StorageObjectName,
} from './object-name.js';
export type { S3ObjectStoreConfig, S3ObjectStoreOptions } from './s3-store.js';
export type {
  AzureBlobContainer,
  AzureBlobEntry,
  AzureBlobFileEntry,
  AzureBlobFolderEntry,
  AzureBlobObjectStoreConfig,
} from './azure-blob-store.js';
export type {
  GcsClient,
  GcsObjectStoreConfig,
  GcsObjectStoreOptions,
  GcsStoredObject,
} from './gcs-store.js';

// The in-memory backend is a reference implementation and a test double, not a deployment
// backend — `memory-store.ts`'s header says which claim it does and does not discharge. It is
// exported because `contract.ts`'s "Adding a backend" recipe is only checkable if a second
// implementation is reachable from outside this directory, and because a suite above this package
// that needs an ObjectStore should not have to make a temporary directory to get one.
export { createInMemoryObjectStore, createInMemoryObjectStoreProvider } from './memory-store.js';

// `contract.ts` is deliberately NOT re-exported here, and must not be added back.
//
// It imports `vitest` at module scope — `describe`/`it` cannot be called any other way — so a
// barrel that re-exports it drags `vitest` into the module graph of everything that imports this
// file, including `apps/web`'s files routes. W2-INT-01 found the consequence on the integration
// branch: a real `next dev` against a real PostgreSQL answered **500 on all five `/api/files*`
// routes**, because the route module throws while being evaluated outside a Vitest process.
// Nothing in this repository's gates could have caught it — `routes.test.ts` *is* Vitest, so the
// import resolves there, and `pnpm build`, `pnpm typecheck` and `pnpm lint` never evaluate the
// module. The failure is equally reproducible in any deployment tree without devDependencies:
//
//   $ cp -r packages/core/dist /tmp/prodsim/dist && cd /tmp/prodsim
//   $ node --input-type=module -e "await import('./dist/storage/index.js')"
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest' imported from
//     /tmp/prodsim/dist/storage/contract.js
//
// The suite is a test-time helper, so it is reached the way test-time helpers are reached: by
// path, from a test file beside it — `import { defineObjectStoreContract } from './contract.js'`,
// which is exactly what `local-fs-store.test.ts` and `memory-store.test.ts` already do and what
// `contract.ts`'s own "Adding a backend" recipe prints. A backend outside this package needs a
// `./storage/contract` entry in `packages/core/package.json`'s `exports`, which is a separate entry
// point from this one on purpose — production code and a Vitest-dependent suite do not belong
// behind the same specifier.
