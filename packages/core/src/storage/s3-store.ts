import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { toObjectKey, toObjectPrefix } from './key-safety.js';
import {
  scopedObjectStoreProvider,
  type ObjectContent,
  type ObjectListEntry,
  type ObjectStore,
  type ObjectStoreProvider,
  compareEntryKeys,
} from './object-store.js';

export interface S3ObjectStoreOptions {
  readonly client: S3Client;
  readonly bucket: string;
  readonly keyPrefix?: string;
}

export interface S3ObjectStoreConfig {
  readonly endpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly forcePathStyle?: boolean;
  readonly keyPrefix?: string;
  /** Development endpoints may provision their bucket; native cloud deployments must not. */
  readonly createBucketIfMissing?: boolean;
}

function prefixFor(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return '';
  return `${toObjectPrefix(value.replace(/\/+$/u, ''))}/`;
}

function objectKey(prefix: string, key: string): string {
  return `${prefix}${toObjectKey(key)}`;
}

function listPrefix(prefix: string, key: string): string {
  const safe = toObjectPrefix(key);
  return safe === '' ? prefix : `${prefix}${safe}/`;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === 'NoSuchKey' || value.$metadata?.httpStatusCode === 404;
}

/** Raw S3-compatible backend. Tenant scoping is added by {@link createS3ObjectStoreProvider}. */
export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  const bucket = options.bucket.trim();
  if (bucket === '') throw new Error('An S3 object store requires a non-empty bucket name.');
  const prefix = prefixFor(options.keyPrefix);

  return {
    async put(key, input): Promise<void> {
      await options.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey(prefix, key),
          Body: input.body,
          ...(input.contentType === undefined || input.contentType === null
            ? {}
            : { ContentType: input.contentType, Metadata: { 'aw-content-type-known': 'true' } }),
        }),
      );
    },

    async get(key): Promise<ObjectContent | null> {
      try {
        const response = await options.client.send(
          new GetObjectCommand({ Bucket: bucket, Key: objectKey(prefix, key) }),
        );
        if (response.Body === undefined) return null;
        const body = await response.Body.transformToByteArray();
        return {
          body,
          contentType:
            response.Metadata?.['aw-content-type-known'] === 'true'
              ? (response.ContentType ?? null)
              : null,
          sizeBytes: response.ContentLength ?? body.byteLength,
          lastModified: response.LastModified ?? new Date(0),
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(key): Promise<void> {
      await options.client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(prefix, key) }),
      );
    },

    async list(key): Promise<readonly ObjectListEntry[]> {
      const requestedPrefix = listPrefix(prefix, key);
      const entries: ObjectListEntry[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await options.client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: requestedPrefix,
            Delimiter: '/',
            ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
          }),
        );
        for (const folder of response.CommonPrefixes ?? []) {
          if (folder.Prefix === undefined) continue;
          entries.push({
            kind: 'folder',
            key: folder.Prefix.slice(prefix.length).replace(/\/$/u, ''),
          });
        }
        for (const object of response.Contents ?? []) {
          if (object.Key === undefined || object.Key === requestedPrefix) continue;
          const metadata = await options.client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: object.Key }),
          );
          entries.push({
            kind: 'file',
            key: object.Key.slice(prefix.length),
            sizeBytes: object.Size ?? 0,
            contentType:
              metadata.Metadata?.['aw-content-type-known'] === 'true'
                ? (metadata.ContentType ?? null)
                : null,
            lastModified: object.LastModified ?? new Date(0),
          });
        }
        continuationToken =
          response.IsTruncated === true ? response.NextContinuationToken : undefined;
        if (response.IsTruncated === true && continuationToken === undefined) {
          throw new Error('S3 returned a truncated listing without a continuation token.');
        }
      } while (continuationToken !== undefined);
      return entries.sort(compareEntryKeys);
    },

    async listPrefix(key): Promise<readonly ObjectListEntry[]> {
      // No `Delimiter`: every object whose S3 key is `key` itself or nested under it, however
      // deep — the recursive counterpart to `list`'s one-level `CommonPrefixes` walk.
      const safe = toObjectPrefix(key);
      const requestedPrefix = safe === '' ? prefix : `${prefix}${safe}`;
      const entries: ObjectListEntry[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await options.client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: requestedPrefix,
            ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
          }),
        );
        for (const object of response.Contents ?? []) {
          if (object.Key === undefined) continue;
          // `requestedPrefix` with no trailing `/` also matches a *sibling* key that merely
          // starts with the same characters (`docs` matching `docs2/x`); the same boundary
          // `packages/core/src/db/repositories/resource-catalogs.ts`'s prefix rewrite guards
          // against. Only `requestedPrefix` itself or `${requestedPrefix}/…` is a real match.
          const relative = object.Key.slice(prefix.length);
          if (safe !== '' && relative !== safe && !relative.startsWith(`${safe}/`)) continue;
          const metadata = await options.client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: object.Key }),
          );
          entries.push({
            kind: 'file',
            key: relative,
            sizeBytes: object.Size ?? 0,
            contentType:
              metadata.Metadata?.['aw-content-type-known'] === 'true'
                ? (metadata.ContentType ?? null)
                : null,
            lastModified: object.LastModified ?? new Date(0),
          });
        }
        continuationToken =
          response.IsTruncated === true ? response.NextContinuationToken : undefined;
        if (response.IsTruncated === true && continuationToken === undefined) {
          throw new Error('S3 returned a truncated listing without a continuation token.');
        }
      } while (continuationToken !== undefined);
      return entries.sort(compareEntryKeys);
    },

    async copyObject(sourceKey, destinationKey): Promise<void> {
      const sourceFullKey = objectKey(prefix, sourceKey);
      const destinationFullKey = objectKey(prefix, destinationKey);
      try {
        await options.client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            // The source bucket and key, percent-encoded, per the `CopySource` shape the S3 API
            // itself requires — it is not an ordinary key parameter.
            CopySource: `${bucket}/${sourceFullKey.split('/').map(encodeURIComponent).join('/')}`,
            Key: destinationFullKey,
            MetadataDirective: 'COPY',
          }),
        );
      } catch (error) {
        // A missing source is a no-op — see `object-store.ts`'s header for why this is what makes
        // a retried subtree move idempotent rather than an error the second time.
        if (isNotFound(error)) return;
        throw error;
      }
    },
  };
}

export function createS3ObjectStoreProvider(options: S3ObjectStoreOptions): ObjectStoreProvider {
  return scopedObjectStoreProvider(createS3ObjectStore(options));
}

/** Construct and provision a scoped S3-compatible provider from deployment configuration. */
export async function createS3ObjectStoreProviderFromConfig(
  config: S3ObjectStoreConfig,
  clientOverride?: S3Client,
): Promise<ObjectStoreProvider> {
  const hasAccessKey = config.accessKeyId !== undefined && config.accessKeyId.trim() !== '';
  const hasSecret = config.secretAccessKey !== undefined && config.secretAccessKey.trim() !== '';
  if (hasAccessKey !== hasSecret) {
    throw new Error('S3 access key id and secret access key must be configured together.');
  }
  const client =
    clientOverride ??
    new S3Client({
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      ...(hasAccessKey && hasSecret
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
  if (config.createBucketIfMissing === false) {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } else {
    await ensureS3Bucket(client, config.bucket);
  }
  return createS3ObjectStoreProvider({
    client,
    bucket: config.bucket,
    ...(config.keyPrefix === undefined ? {} : { keyPrefix: config.keyPrefix }),
  });
}

/** Idempotently make the configured bucket usable by a fresh Compose/CLI deployment. */
export async function ensureS3Bucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  }
}
