/**
 * The object-storage names a web server domain may use, owned by the storage module (the storage
 * design, §07 rule 3: only the catalog service reaches object storage). A domain imports them from
 * here, never from `packages/core/src/storage`; `only-the-catalog-service-reaches-object-storage`
 * enforces it. Each name is the core one, re-exported unchanged.
 *
 * The pure helpers (`@agent-workspace/core/storage/keys`, `/content-type`, `/object-name`) do no
 * I/O and are imported directly; they are not repeated here.
 */
export {
  ObjectConflictError,
  SignedUrlUnsupportedError,
  type ObjectPage,
  type ObjectStore,
  type ObjectStoreCapabilities,
  type ObjectStoreProvider,
  type ObjectStream,
  type SignedUrl,
  type SignedUrlRequest,
} from '@agent-workspace/core/storage';

export {
  bytesToStream,
  listAll,
  listPageFrom,
  readBytes,
  readWhole,
  streamToBytes,
} from '@agent-workspace/core/storage/streams';

/**
 * A workspace's own bucket (a storage connection, the storage design §05): opening one owns the
 * egress guard, the pinned lookup and the read-only wrapper, and the refusal classes keep a
 * provider's words out of a response.
 */
export {
  ConnectionStoreError,
  folderFailure,
  openConnectionStore,
  resolveFileRoot,
  storageProviderStatus,
  storageRefusalClass,
} from '@agent-workspace/core/storage';
