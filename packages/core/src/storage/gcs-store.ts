import type { Bucket, File, FileMetadata } from '@google-cloud/storage';

import { toObjectKey, toObjectPrefix, UnsafeObjectKeyError } from './key-safety.js';
import {
  scopedObjectStoreProvider,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectStore,
  type ObjectStoreProvider,
  type PutObjectInput,
  compareEntryKeys,
} from './object-store.js';

const CONTENT_TYPE_KNOWN_METADATA_KEY = 'aw-content-type-known';

export interface GcsStoredObject {
  readonly name: string;
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly contentTypeKnown: boolean;
  readonly lastModified: Date;
}

export interface GcsObjectContent extends GcsStoredObject {
  readonly body: Uint8Array;
}

/** The narrow Google Storage protocol used by the backend; tests provide an offline fake. */
export interface GcsClient {
  write(name: string, input: PutObjectInput): Promise<void>;
  read(name: string): Promise<GcsObjectContent | null>;
  delete(name: string): Promise<void>;
  list(prefix: string): Promise<readonly GcsStoredObject[]>;
  copy(sourceName: string, destinationName: string): Promise<void>;
}

export interface GcsObjectStoreOptions {
  readonly client: GcsClient;
  readonly keyPrefix?: string;
}

export interface GcsObjectStoreConfig {
  readonly bucket: string;
  readonly keyPrefix?: string;
  readonly projectId?: string;
  /** Total retry deadline for each native client operation, in milliseconds. */
  readonly timeoutMs?: number;
}

function prefixFor(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return '';
  return `${toObjectPrefix(value.replace(/\/+$/u, ''))}/`;
}

function objectName(prefix: string, key: string): string {
  return `${prefix}${toObjectKey(key)}`;
}

function listingPrefix(prefix: string, key: string): string {
  const safe = toObjectPrefix(key);
  return safe === '' ? prefix : `${prefix}${safe}/`;
}

/** Validate an SDK list prefix while preserving the delimiter the store adds internally. */
function nativeListingPrefix(prefix: string): string {
  if (prefix === '') return '';
  if (!prefix.endsWith('/')) return toObjectPrefix(prefix);
  return `${toObjectPrefix(prefix.slice(0, -1))}/`;
}

function toContent(object: GcsObjectContent): ObjectContent {
  return {
    body: object.body,
    contentType: object.contentTypeKnown ? object.contentType : null,
    sizeBytes: object.sizeBytes,
    lastModified: object.lastModified,
  };
}

function toFileEntry(object: GcsStoredObject, prefixLength: number): ObjectListEntry {
  return {
    kind: 'file',
    key: object.name.slice(prefixLength),
    sizeBytes: object.sizeBytes,
    contentType: object.contentTypeKnown ? object.contentType : null,
    lastModified: object.lastModified,
  };
}

/** GCS may contain objects created by tools that do not follow Agent Workspace's key grammar. */
function addressableObjectName(name: string): string | null {
  try {
    return toObjectKey(name);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) return null;
    throw error;
  }
}

/** Raw native GCS backend. Tenant scoping is added by {@link createGcsObjectStoreProvider}. */
export function createGcsObjectStore(options: GcsObjectStoreOptions): ObjectStore {
  const prefix = prefixFor(options.keyPrefix);
  return {
    put(key, input): Promise<void> {
      return options.client.write(objectName(prefix, key), input);
    },

    async get(key): Promise<ObjectContent | null> {
      const object = await options.client.read(objectName(prefix, key));
      return object === null ? null : toContent(object);
    },

    delete(key): Promise<void> {
      return options.client.delete(objectName(prefix, key));
    },

    async list(key): Promise<readonly ObjectListEntry[]> {
      const requestedPrefix = listingPrefix(prefix, key);
      const folders = new Set<string>();
      const files: ObjectListEntry[] = [];
      for (const object of await options.client.list(requestedPrefix)) {
        const safeName = addressableObjectName(object.name);
        if (safeName === null) continue;
        if (!safeName.startsWith(requestedPrefix) || safeName === requestedPrefix) continue;
        const remainder = safeName.slice(requestedPrefix.length);
        const slash = remainder.indexOf('/');
        if (slash >= 0) {
          folders.add(`${requestedPrefix}${remainder.slice(0, slash)}`.slice(prefix.length));
          continue;
        }
        files.push(toFileEntry({ ...object, name: safeName }, prefix.length));
      }
      return [
        ...[...folders].map((folder) => ({ kind: 'folder' as const, key: folder })),
        ...files,
      ].sort(compareEntryKeys);
    },

    async listPrefix(key): Promise<readonly ObjectListEntry[]> {
      const safe = toObjectPrefix(key);
      const requestedPrefix = safe === '' ? prefix : `${prefix}${safe}`;
      const entries: ObjectListEntry[] = [];
      for (const object of await options.client.list(requestedPrefix)) {
        const safeName = addressableObjectName(object.name);
        if (safeName === null) continue;
        const relative = safeName.slice(prefix.length);
        if (safe !== '' && relative !== safe && !relative.startsWith(`${safe}/`)) continue;
        entries.push(toFileEntry({ ...object, name: safeName }, prefix.length));
      }
      return entries.sort(compareEntryKeys);
    },

    copyObject(sourceKey, destinationKey): Promise<void> {
      return options.client.copy(objectName(prefix, sourceKey), objectName(prefix, destinationKey));
    },
  };
}

export function createGcsObjectStoreProvider(options: GcsObjectStoreOptions): ObjectStoreProvider {
  return scopedObjectStoreProvider(createGcsObjectStore(options));
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return code === 404 || code === '404';
}

function sizeOf(metadata: FileMetadata): number {
  const size = typeof metadata.size === 'number' ? metadata.size : Number(metadata.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('Google Cloud Storage returned an invalid object size.');
  }
  return size;
}

function modifiedAt(metadata: FileMetadata): Date {
  const value = metadata.updated ?? metadata.timeCreated;
  const date = new Date(value ?? Number.NaN);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Google Cloud Storage returned an invalid object timestamp.');
  }
  return date;
}

function metadataFor(file: File, metadata: FileMetadata): GcsStoredObject {
  return {
    name: toObjectKey(file.name),
    sizeBytes: sizeOf(metadata),
    contentType: metadata.contentType ?? null,
    contentTypeKnown: metadata.metadata?.[CONTENT_TYPE_KNOWN_METADATA_KEY] === 'true',
    lastModified: modifiedAt(metadata),
  };
}

/** Adapt the official client to the small protocol above; authentication stays ADC-owned. */
function createNativeGcsClient(bucket: Bucket): GcsClient {
  return {
    async write(name, input): Promise<void> {
      await bucket.file(toObjectKey(name)).save(input.body, {
        resumable: false,
        validation: 'crc32c',
        metadata:
          input.contentType === undefined || input.contentType === null
            ? {}
            : {
                contentType: input.contentType,
                metadata: { [CONTENT_TYPE_KNOWN_METADATA_KEY]: 'true' },
              },
      });
    },

    async read(name): Promise<GcsObjectContent | null> {
      const file = bucket.file(toObjectKey(name));
      try {
        // File#download does not populate File.metadata in @google-cloud/storage 8.x. Fetch the
        // bytes and metadata concurrently so a successful read never fabricates missing headers.
        const [[body], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
        return { ...metadataFor(file, metadata), body };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(name): Promise<void> {
      try {
        await bucket.file(toObjectKey(name)).delete({ ignoreNotFound: true });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    async list(prefix): Promise<readonly GcsStoredObject[]> {
      const [files] = await bucket.getFiles({ prefix: nativeListingPrefix(prefix) });
      const objects: GcsStoredObject[] = [];
      for (const file of files) {
        if (addressableObjectName(file.name) === null) continue;
        objects.push(metadataFor(file, file.metadata));
      }
      return objects;
    },

    async copy(sourceName, destinationName): Promise<void> {
      try {
        await bucket.file(toObjectKey(sourceName)).copy(bucket.file(toObjectKey(destinationName)));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

export class GcsBucketUnavailableError extends Error {
  public readonly reason: 'missing' | 'unreachable';

  public constructor(bucket: string, reason: 'missing' | 'unreachable', cause?: unknown) {
    super(
      `Google Cloud Storage bucket "${bucket}" is missing or not reachable by the deployment identity.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'GcsBucketUnavailableError';
    this.reason = reason;
  }
}

/** Construct a scoped native GCS provider and fail readiness when the bucket is unavailable. */
export async function createGcsObjectStoreProviderFromConfig(
  config: GcsObjectStoreConfig,
): Promise<ObjectStoreProvider> {
  const bucketName = config.bucket.trim();
  if (bucketName === '') throw new Error('A GCS object store requires a non-empty bucket name.');
  const { Storage } = await import('@google-cloud/storage');
  const projectId = config.projectId?.trim();
  const storage = new Storage({
    ...(projectId === undefined || projectId === '' ? {} : { projectId }),
    ...(config.timeoutMs === undefined
      ? {}
      : { retryOptions: { totalTimeout: Math.max(1, config.timeoutMs / 1_000) } }),
  });
  const bucket = storage.bucket(bucketName);
  try {
    const [exists] = await bucket.exists();
    if (!exists) throw new GcsBucketUnavailableError(bucketName, 'missing');
  } catch (error) {
    if (error instanceof GcsBucketUnavailableError) throw error;
    throw new GcsBucketUnavailableError(bucketName, 'unreachable', error);
  }
  return createGcsObjectStoreProvider({
    client: createNativeGcsClient(bucket),
    ...(config.keyPrefix === undefined ? {} : { keyPrefix: config.keyPrefix }),
  });
}
