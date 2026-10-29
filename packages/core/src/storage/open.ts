/**
 * `openObjectStore` — the one way a deployment reaches a cloud backend (the storage design, §02:
 * each cloud's library is loaded only when that cloud is used). Every backend module is imported
 * dynamically here, so a local-disk install never loads the AWS, Azure or Google Cloud libraries.
 */
import type { StorageLocation } from '@indx-workspace/contracts/storage-url';

import {
  scopedObjectStoreProvider,
  type ObjectStore,
  type ObjectStoreProvider,
} from './object-store.js';
import type { StorageArea } from './object-name.js';

export interface OpenObjectStoreOptions {
  /** Total retry deadline for each native client operation (GCS), in milliseconds. */
  readonly timeoutMs?: number;
  /** S3 only: provision the bucket when it is missing (development endpoints). */
  readonly createBucketIfMissing?: boolean;
  /** S3 only: an explicit key pair (and STS token), which the deployment reads from its environment. */
  readonly credentials?: {
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
    readonly sessionToken?: string;
  };
  /** Azure only: the client id of a user-assigned managed identity. */
  readonly managedIdentityClientId?: string;
}

function prefixOf(location: StorageLocation): string {
  return location.kind === 'file' ? '' : location.prefix;
}

function keyPrefixOf(prefix: string, area: StorageArea): string {
  return prefix === '' ? area : `${prefix}/${area}`;
}

/**
 * Open the store `location` names for one `area`, loading only that backend's module. A `file`
 * root is already one area's directory, so `area` is not appended to it, unlike the bucket backends.
 */
export async function openObjectStore(
  location: StorageLocation,
  area: StorageArea,
  options: OpenObjectStoreOptions = {},
): Promise<ObjectStoreProvider> {
  return scopedObjectStoreProvider(
    await openBackend(location, keyPrefixOf(prefixOf(location), area), options),
  );
}

/**
 * Open the store at the location itself, with no area and no workspace scope: the catalog
 * service's root, where every object name already carries its `workspaces/<id>/<area>/` path.
 */
export function openRootObjectStore(
  location: StorageLocation,
  options: OpenObjectStoreOptions = {},
): Promise<ObjectStore> {
  return openBackend(location, prefixOf(location), options);
}

async function openBackend(
  location: StorageLocation,
  keyPrefix: string,
  options: OpenObjectStoreOptions,
): Promise<ObjectStore> {
  switch (location.kind) {
    case 'file': {
      const { createLocalFilesystemObjectStore } = await import('./local-fs-store.js');
      // A `file` root is the directory itself (callers pass a per-area root for an area store).
      return createLocalFilesystemObjectStore(location.root);
    }
    case 's3': {
      const { createS3ObjectStoreFromConfig } = await import('./s3-store.js');
      const { accessKeyId, secretAccessKey, sessionToken } = options.credentials ?? {};
      return createS3ObjectStoreFromConfig({
        bucket: location.bucket,
        region: location.region ?? 'us-east-1',
        ...(location.endpoint === undefined ? {} : { endpoint: location.endpoint }),
        ...(location.publicEndpoint === undefined
          ? {}
          : { publicEndpoint: location.publicEndpoint }),
        ...(accessKeyId === undefined ? {} : { accessKeyId }),
        ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
        ...(sessionToken === undefined ? {} : { sessionToken }),
        forcePathStyle: location.forcePathStyle,
        ...(options.createBucketIfMissing === undefined
          ? {}
          : { createBucketIfMissing: options.createBucketIfMissing }),
        keyPrefix,
      });
    }
    case 'gcs': {
      const { createGcsObjectStoreFromConfig } = await import('./gcs-store.js');
      return createGcsObjectStoreFromConfig({
        bucket: location.bucket,
        keyPrefix,
        ...(location.projectId === undefined ? {} : { projectId: location.projectId }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }
    case 'azblob': {
      const { createAzureBlobObjectStoreFromConfig } = await import('./azure-blob-store.js');
      return createAzureBlobObjectStoreFromConfig({
        serviceUrl: location.serviceUrl,
        container: location.container,
        keyPrefix,
        ...(options.managedIdentityClientId === undefined
          ? {}
          : { managedIdentityClientId: options.managedIdentityClientId }),
      });
    }
    default: {
      const unreachable: never = location;
      throw new Error(`Unsupported storage location: ${JSON.stringify(unreachable)}`);
    }
  }
}
