import type { Bucket, Storage } from '@google-cloud/storage';
import { randomUUID } from 'node:crypto';

import {
  GcsBucketUnavailableError,
  listObjects,
  metaOf,
  readObject,
  safeGcsError,
  type GcsClient,
  type GcsTarget,
} from './gcs-safe-client.js';
import { createNativeGcsClient } from './gcs-native-client.js';
import { prefixedObjectKey, storeKeyPrefix } from './key-safety.js';
import {
  scopedObjectStoreProvider,
  validatedWriteKey,
  type EmulatorObjectStore,
  type ObjectMeta,
  type ObjectStore,
  type ObjectStoreProvider,
  type SignedUrl,
  type SignedUrlRequest,
} from './object-store.js';
import { abortableBody } from './streams.js';

export { createNativeGcsClient } from './gcs-native-client.js';

export interface GcsObjectStoreOptions {
  readonly client: GcsClient;
  readonly keyPrefix?: string;
}

export interface GcsObjectStoreConfig {
  readonly bucket: string;
  readonly keyPrefix?: string;
  readonly projectId?: string;
  /** A connection's service-account key; absent means the deployment's application default credentials. */
  readonly credentials?: GcsServiceAccountCredentials;
  /**
   * A connection's short-lived OAuth access token, used instead of `credentials`. It needs a
   * `projectId`, so the client never looks one up in gcloud or the metadata server.
   */
  readonly accessToken?: string;
  /** Total retry deadline for each native client operation, in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * `false` skips the one-object listing an open otherwise makes. A connection store sets it, so
   * the bucket's refusal shows, with its status, at the connection's first listing of an allowed
   * folder, as it does on S3.
   */
  readonly checkBucketOnOpen?: boolean;
  /**
   * The JSON API origin the client dials, such as `http://127.0.0.1:4443`; absent means Google's.
   * Tests point a store at a local server with it. Requests keep the config's credentials.
   */
  readonly apiEndpoint?: string;
  /**
   * `true` refuses the open with {@link GcsEndpointForbiddenError} when the client the SDK builds
   * would dial anything but `apiEndpoint`, or Google's own API host without one. The SDK reads
   * `STORAGE_EMULATOR_HOST` by itself, so a connection store sets it: a customer connection must
   * never reach an unchecked host.
   */
  readonly requireApiEndpoint?: boolean;
}

/** Google's JSON API host in the default universe, which a GCS config dials without `apiEndpoint`. */
const GOOGLE_API_ENDPOINT = 'https://storage.googleapis.com';

interface GcsServiceAccountCredentials {
  readonly client_email: string;
  readonly private_key: string;
}

/**
 * The `Storage` constructor options for `config`; with neither `credentials` nor `accessToken` they
 * are the ADC-only options.
 */
export async function gcsStorageOptions(config: GcsObjectStoreConfig) {
  const projectId = config.projectId?.trim();
  return {
    ...(projectId === undefined || projectId === '' ? {} : { projectId }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
    // A custom endpoint drops auth unless asked to keep it.
    ...(config.apiEndpoint === undefined
      ? {}
      : { apiEndpoint: config.apiEndpoint, useAuthWithCustomEndpoint: true }),
    ...(config.accessToken === undefined
      ? {}
      : { authClient: await accessTokenClient(config.accessToken) }),
    ...(config.timeoutMs === undefined
      ? {}
      : { retryOptions: { totalTimeout: Math.max(1, config.timeoutMs / 1_000) } }),
  };
}

// `setCredentials`, not the constructor's `credentials`, so the SDK never tries to refresh the token.
// Imported on the token path only, as `@google-cloud/storage` is, so the barrel loads neither.
async function accessTokenClient(accessToken: string) {
  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client();
  client.setCredentials({ access_token: accessToken });
  return client;
}

/** Raw native GCS backend. Tenant scoping is added by {@link createGcsObjectStoreProvider}. */
export function createGcsObjectStore(options: GcsObjectStoreOptions): ObjectStore {
  const { client } = options;
  const prefix = storeKeyPrefix(options.keyPrefix);
  const target: GcsTarget = { client, prefix };
  const sign = client.signUrl?.bind(client);
  return {
    capabilities: {
      sign: sign !== undefined,
      boundLengthSign: sign !== undefined,
      range: true,
      conditionalPut: true,
      fileAndFolderShareKey: true,
    },
    ...(sign === undefined
      ? {}
      : {
          createSignedUrl: (key: string, request: SignedUrlRequest): Promise<SignedUrl> =>
            sign(prefixedObjectKey(prefix, key), request),
        }),

    async head(key): Promise<ObjectMeta | null> {
      const object = await client.head(prefixedObjectKey(prefix, key));
      return object === null ? null : metaOf(object);
    },

    read: (key, readOptions) => readObject(target, key, readOptions),

    async write(key, body, writeOptions): Promise<ObjectMeta> {
      const name = await validatedWriteKey(body, writeOptions, () =>
        prefixedObjectKey(prefix, key),
      );
      return metaOf(
        await client.writeStream(name, abortableBody(body, writeOptions.signal), writeOptions),
      );
    },

    listPage: (listPrefix, listOptions) => listObjects(target, listPrefix, listOptions),

    delete: (key) => client.delete(prefixedObjectKey(prefix, key)),

    copy: (sourceKey, destinationKey) =>
      client.copy(prefixedObjectKey(prefix, sourceKey), prefixedObjectKey(prefix, destinationKey)),
  };
}

export function createGcsObjectStoreProvider(options: GcsObjectStoreOptions): ObjectStoreProvider {
  return scopedObjectStoreProvider(createGcsObjectStore(options));
}

/** The client the SDK built would dial a host other than Google's; no request was made. */
export class GcsEndpointForbiddenError extends Error {
  public constructor() {
    super('The Google Cloud Storage client is not pointed at its configured API endpoint.');
    this.name = 'GcsEndpointForbiddenError';
  }
}

/**
 * Tests only, through `@agent-workspace/core/storage/backends` (the storage design, §07 "Load
 * test"): a new, empty bucket on the fake-gcs-server at `apiEndpoint`, such as
 * `http://127.0.0.1:4443`, so a caller outside this package needs no Google Cloud dependency of
 * its own.
 */
export async function createFakeGcsObjectStore(apiEndpoint: string): Promise<EmulatorObjectStore> {
  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage({ apiEndpoint, projectId: 'aw-emulator' });
  const [bucket] = await storage.createBucket(`aw-${randomUUID()}`);
  return {
    provider: createGcsObjectStoreProvider({ client: createNativeGcsClient(bucket) }),
    teardown: async () => {
      await bucket.deleteFiles({ force: true });
      await bucket.delete();
    },
    plantRaw: async (name, bytes) => {
      await bucket.file(name).save(Buffer.from(bytes), { resumable: false });
    },
  };
}

/** Construct a scoped native GCS provider and fail readiness when the bucket is unavailable. */
export async function createGcsObjectStoreProviderFromConfig(
  config: GcsObjectStoreConfig,
): Promise<ObjectStoreProvider> {
  return scopedObjectStoreProvider(await createGcsObjectStoreFromConfig(config));
}

function assertGcsAuthConfig(config: GcsObjectStoreConfig): void {
  if (config.accessToken !== undefined && (config.projectId?.trim() ?? '') === '') {
    throw new Error('A GCS access token requires a project id.');
  }
  if (config.accessToken !== undefined && config.credentials !== undefined) {
    throw new Error('A GCS object store takes either credentials or an access token, not both.');
  }
}

function assertDialsEndpoint(storage: Storage, config: GcsObjectStoreConfig): void {
  if (config.requireApiEndpoint !== true) return;
  const endpoint = config.apiEndpoint ?? GOOGLE_API_ENDPOINT;
  if (storage.apiEndpoint !== endpoint || storage.baseUrl !== `${endpoint}/storage/v1`) {
    throw new GcsEndpointForbiddenError();
  }
}

async function checkBucket(
  bucket: Bucket,
  bucketName: string,
  keyPrefix: string | undefined,
): Promise<void> {
  try {
    // List one object instead of `bucket.exists()`: that call is `storage.buckets.get`, which the
    // roles a customer grants (Object Viewer, Object User) and the platform's objectAdmin lack.
    // `storage.objects.list` is in all of them.
    const prefix = storeKeyPrefix(keyPrefix);
    await bucket.getFiles({
      maxResults: 1,
      autoPaginate: false,
      ...(prefix === '' ? {} : { prefix }),
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === 404) {
      throw new GcsBucketUnavailableError(bucketName, 'missing');
    }
    // The SDK error keeps its request and bearer token; only its HTTP status is kept as the cause.
    throw new GcsBucketUnavailableError(
      bucketName,
      'unreachable',
      safeGcsError('bucket check', error),
    );
  }
}

/** The same store, unscoped: workspace-agnostic names under `config.keyPrefix`. */
export async function createGcsObjectStoreFromConfig(
  config: GcsObjectStoreConfig,
): Promise<ObjectStore> {
  const bucketName = config.bucket.trim();
  if (bucketName === '') throw new Error('A GCS object store requires a non-empty bucket name.');
  assertGcsAuthConfig(config);
  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage(await gcsStorageOptions(config));
  assertDialsEndpoint(storage, config);
  const bucket = storage.bucket(bucketName);
  if (config.checkBucketOnOpen !== false) await checkBucket(bucket, bucketName, config.keyPrefix);
  const client = createNativeGcsClient(bucket);
  // A token is no key to sign with: the SDK would ask the metadata server for the deployment's own
  // service account and have iamcredentials sign as it, with the customer's token.
  if (config.accessToken !== undefined) delete client.signUrl;
  return createGcsObjectStore({
    client,
    ...(config.keyPrefix === undefined ? {} : { keyPrefix: config.keyPrefix }),
  });
}
