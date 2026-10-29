/**
 * `openConnectionStore` — opens a customer's bucket or a server folder from a connection URL and a
 * credential (the storage design, §04 "One setting" and §05 Security). Read-only unless `writable`;
 * an S3 or Azure endpoint is checked against the egress policy and the client then connects only to the
 * addresses that were checked; a `file` connection stays under the operator's listed roots.
 *
 * Every refusal to open is a {@link ConnectionStoreError} whose message is its stable code: it
 * carries no `cause`, so neither the URL nor a credential can reach a log through it. Opening an S3
 * or GCS connection sends no request, so the bucket's own refusal (a key it denies, a bucket that
 * is gone) appears at the store's first operation, as the provider's error; read only its status,
 * through {@link storageProviderStatus} or {@link storageRefusalClass}.
 *
 * A `file` connection reads the folder as it is on disk (`folder-store.ts`), not the platform's own
 * `objects/` tree.
 */
import { realpath } from 'node:fs/promises';
import type { LookupFunction } from 'node:net';

import {
  StorageConnectionCredentialSchema,
  type StorageConnectionCredential,
  type StorageConnectionProblemCode,
} from '@indx-workspace/contracts/storage-connections';
import { parseStorageUrl, type StorageLocation } from '@indx-workspace/contracts/storage-url';

import {
  checkEgress,
  type EgressPolicyConfig,
  type EgressResolvedAddress,
  type EgressResolver,
} from '../net/egress-policy.js';
import { createFolderObjectStore, isInside, type FolderSkipCounts } from './folder-store.js';
import type { GcsObjectStoreConfig } from './gcs-store.js';
import type { ObjectStore } from './object-store.js';

// @story US-STO-12
export type ConnectionCredential = StorageConnectionCredential;

/** A read-only connection was asked to write, or to sign an upload. */
export class ReadOnlyStoreError extends Error {
  public readonly code =
    'storage_connection_write_not_allowed' satisfies StorageConnectionProblemCode;

  public constructor() {
    super('storage_connection_write_not_allowed');
    this.name = 'ReadOnlyStoreError';
  }
}

/** A connection that could not be opened. The message is the code; there is never a `cause`. */
export class ConnectionStoreError extends Error {
  public constructor(public readonly code: StorageConnectionProblemCode) {
    super(code);
    this.name = 'ConnectionStoreError';
  }
}

export interface ConnectionStoreOptions {
  readonly writable: boolean;
  /** `AW_STORAGE_CONNECTION_FILE_ROOTS`, split. Empty means no `file` connection is allowed. */
  readonly fileRoots: readonly string[];
  /** The deployment's egress policy; the caller reads it from the environment. */
  readonly egress: EgressPolicyConfig;
  /**
   * The process's `STORAGE_EMULATOR_HOST`, which `@google-cloud/storage` reads by itself and then
   * dials instead of Google. A GCS connection is refused while it is set.
   */
  readonly gcsEmulatorHost?: string;
  /**
   * Test seam: the JSON API origin a GCS connection dials instead of Google's. The client the SDK
   * builds must still dial exactly it, so `STORAGE_EMULATOR_HOST` is refused with it too.
   */
  readonly gcsApiEndpoint?: string;
  /** Test seam: the DNS resolver the endpoint check uses. */
  readonly resolve?: EgressResolver;
  /** Abandons the open once aborted. The DNS check and the SDK client construction take no signal. */
  readonly signal?: AbortSignal;
  /** A `file` connection's listing left entries out. Counts only, never a name or a path. */
  readonly onSkipped?: (counts: FolderSkipCounts) => void;
}

/**
 * How each `ObjectStore` member is treated by a read-only connection. A member added to the
 * interface fails `tsc` here until it is classified, and the tests walk this table.
 */
export const MEMBER_ACCESS = {
  capabilities: 'read',
  head: 'read',
  read: 'read',
  listPage: 'read',
  delete: 'write',
  copy: 'write',
  write: 'write',
  createSignedUrl: 'sign',
} as const satisfies Record<keyof ObjectStore, 'read' | 'write' | 'sign'>;

/**
 * The HTTP status a storage provider's error carries: S3 `$metadata.httpStatusCode`, Azure and the
 * GCS store's safe error `statusCode`, or a numeric `code`. Only the number is read, never the
 * message or `cause`, which may echo the provider's reply.
 */
export function storageProviderStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const metadata: unknown = Reflect.get(error, '$metadata');
  const candidates: unknown[] = [
    typeof metadata === 'object' && metadata !== null
      ? Reflect.get(metadata, 'httpStatusCode')
      : undefined,
    Reflect.get(error, 'statusCode'),
    Reflect.get(error, 'code'),
  ];
  return candidates.find((value): value is number => typeof value === 'number') ?? null;
}

/** How a connection's operation failed, from the provider's status alone. */
export type StorageRefusalClass = 'forbidden' | 'not_found' | 'unreachable';

export function storageRefusalClass(error: unknown): StorageRefusalClass {
  const status = storageProviderStatus(error);
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'unreachable';
}

const refuseWrite = (): Promise<never> => Promise.reject(new ReadOnlyStoreError());

/** The refusal of a write, after cancelling a streamed body nobody will read. */
async function refuseStreamedWrite(body: ReadableStream<Uint8Array> | Uint8Array): Promise<never> {
  const refusal = new ReadOnlyStoreError();
  if (body instanceof ReadableStream) {
    try {
      await body.cancel(refusal);
    } catch (cancelFailure) {
      throw new AggregateError([refusal, cancelFailure], refusal.message, { cause: cancelFailure });
    }
  }
  throw refusal;
}

/** `store` with every write path refused, including a signed PUT URL. */
export function readOnlyStore(store: ObjectStore): ObjectStore {
  const sign = store.createSignedUrl?.bind(store);
  return {
    capabilities: store.capabilities,
    head: (key) => store.head(key),
    read: (key, options) => store.read(key, options),
    listPage: (prefix, options) => store.listPage(prefix, options),
    delete: refuseWrite,
    copy: refuseWrite,
    write: (_key, body) => refuseStreamedWrite(body),
    ...(sign === undefined
      ? {}
      : {
          createSignedUrl: (key, request) =>
            request.method === 'GET' ? sign(key, request) : refuseWrite(),
        }),
  };
}

async function realpathOrNull(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch {
    return null;
  }
}

/** The real path of `target`, if it exists and lies under the real path of one of `fileRoots`. */
export async function resolveFileRoot(
  target: string,
  fileRoots: readonly string[],
): Promise<string> {
  const real = await realpathOrNull(target);
  if (real !== null) {
    for (const root of fileRoots) {
      const realRoot = await realpathOrNull(root);
      if (realRoot !== null && isInside(realRoot, real)) return real;
    }
  }
  throw new ConnectionStoreError('storage_connection_endpoint_forbidden');
}

/**
 * A `lookup` that answers every hostname with the addresses that were checked, never a new query.
 * A request for one address family (Happy Eyeballs asks for 4 and 6 separately) is answered only
 * from that family, and with `ENOTFOUND` when none was checked.
 */
export function pinnedLookup(addresses: readonly EgressResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = familyOf(options.family);
    const answers =
      family === undefined ? addresses : addresses.filter((address) => address.family === family);
    const [first] = answers;
    if (first === undefined) {
      callback(Object.assign(new Error('no checked address'), { code: 'ENOTFOUND' }), '', 0);
    } else if (options.all === true) {
      callback(null, [...answers], undefined);
    } else {
      callback(null, first.address, first.family);
    }
  };
}

/** The address family a lookup asks for; 0 and an absent family mean either. */
function familyOf(family: number | 'IPv4' | 'IPv6' | undefined): 4 | 6 | undefined {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return undefined;
}

async function openS3(
  location: Extract<StorageLocation, { kind: 's3' }>,
  credential: Extract<ConnectionCredential, { provider: 's3' }>,
  options: ConnectionStoreOptions,
): Promise<ObjectStore> {
  let lookup: LookupFunction | undefined;
  if (location.endpoint !== undefined) {
    const decision = await checkEgress(location.endpoint, options.egress, options.resolve);
    if (!decision.ok) throw new ConnectionStoreError('storage_connection_endpoint_forbidden');
    lookup = pinnedLookup(decision.addresses);
  }
  // Nothing here dials the public endpoint, but a signed link names it and whatever fetches the
  // link (a browser, a runner) would, so it may not point at a private address either. A link
  // still carries the access key id, as every SigV4 query signature does; never the secret.
  if (location.publicEndpoint !== undefined) {
    const decision = await checkEgress(location.publicEndpoint, options.egress, options.resolve);
    if (!decision.ok) throw new ConnectionStoreError('storage_connection_endpoint_forbidden');
  }
  try {
    const { createS3ObjectStoreFromConfig } = await import('./s3-store.js');
    return await createS3ObjectStoreFromConfig({
      bucket: location.bucket,
      region: location.region ?? 'us-east-1',
      ...(location.endpoint === undefined ? {} : { endpoint: location.endpoint }),
      ...(location.publicEndpoint === undefined ? {} : { publicEndpoint: location.publicEndpoint }),
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      ...(credential.sessionToken === undefined ? {} : { sessionToken: credential.sessionToken }),
      forcePathStyle: location.forcePathStyle,
      createBucketIfMissing: false,
      // The guide's key lists only under its folder, so it cannot pass a `HeadBucket`.
      checkBucketOnOpen: false,
      keyPrefix: location.prefix,
      ...(lookup === undefined ? {} : { lookup }),
    });
  } catch {
    // The SDK's error can echo request details, so it is dropped rather than chained.
    throw new ConnectionStoreError('storage_connection_unreachable');
  }
}

interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly project_id?: string;
}

/**
 * The key in `json`, or null. Exported for its test: `openConnectionStore` checks the credential
 * against the contracts schema first, which refuses the same `type`s, so the opener never shows
 * this check on its own.
 */
export function parseServiceAccount(json: string): ServiceAccount | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const email: unknown = Reflect.get(value, 'client_email');
  const key: unknown = Reflect.get(value, 'private_key');
  const project: unknown = Reflect.get(value, 'project_id');
  if (typeof email !== 'string' || email === '' || typeof key !== 'string' || key === '') {
    return null;
  }
  // An `external_account` or `authorized_user` file is not a key: its sources are never followed.
  // A key must say what it is, so one with no `type` is refused too.
  if (Reflect.get(value, 'type') !== 'service_account') return null;
  return {
    client_email: email,
    private_key: key,
    ...(typeof project === 'string' && project !== '' ? { project_id: project } : {}),
  };
}

// The gcs URL grammar has no endpoint parameter, so a GCS connection always dials Google's own
// API host and there is no address to check or pin.
async function openGcs(
  location: Extract<StorageLocation, { kind: 'gcs' }>,
  credential: Extract<ConnectionCredential, { provider: 'gcs' }>,
  options: ConnectionStoreOptions,
): Promise<ObjectStore> {
  // The SDK sends every request to that host, so a customer connection would bypass the egress
  // check. A GCS URL names no endpoint to check instead.
  if (options.gcsEmulatorHost !== undefined) {
    throw new ConnectionStoreError('storage_connection_endpoint_forbidden');
  }
  let auth: Pick<GcsObjectStoreConfig, 'accessToken' | 'credentials'>;
  let projectId = location.projectId;
  if ('accessToken' in credential) {
    // A token names no project; without one the client would look in gcloud or the metadata server.
    if (projectId === undefined) throw new ConnectionStoreError('storage_connection_url_invalid');
    auth = { accessToken: credential.accessToken };
  } else {
    const account = parseServiceAccount(credential.serviceAccountJson);
    // Neither the JSON nor a parser's message is chained: either could echo the private key.
    if (account === null) throw new ConnectionStoreError('storage_connection_url_invalid');
    projectId ??= account.project_id;
    auth = {
      credentials: { client_email: account.client_email, private_key: account.private_key },
    };
  }
  const { createGcsObjectStoreFromConfig, GcsEndpointForbiddenError } =
    await import('./gcs-store.js');
  try {
    return await createGcsObjectStoreFromConfig({
      bucket: location.bucket,
      keyPrefix: location.prefix,
      ...(projectId === undefined ? {} : { projectId }),
      ...auth,
      // The guide's object roles cannot read the bucket's metadata.
      checkBucketOnOpen: false,
      ...(options.gcsApiEndpoint === undefined ? {} : { apiEndpoint: options.gcsApiEndpoint }),
      // The variable may be set without the caller passing it; the built client is checked too.
      requireApiEndpoint: true,
    });
  } catch (error) {
    if (error instanceof GcsEndpointForbiddenError) {
      throw new ConnectionStoreError('storage_connection_endpoint_forbidden');
    }
    throw new ConnectionStoreError('storage_connection_unreachable');
  }
}

async function openAzblob(
  location: Extract<StorageLocation, { kind: 'azblob' }>,
  credential: Extract<ConnectionCredential, { provider: 'azblob' }>,
  options: ConnectionStoreOptions,
): Promise<ObjectStore> {
  // The default account host is checked and pinned too, not only an `endpoint=` one: the name is
  // fixed, but what the operator's resolver answers for it is not.
  const decision = await checkEgress(location.serviceUrl, options.egress, options.resolve);
  if (!decision.ok) throw new ConnectionStoreError('storage_connection_endpoint_forbidden');
  const lookup = pinnedLookup(decision.addresses);
  try {
    const {
      AzureAccountKeyConnection,
      AzureSasTokenConnection,
      createAzureBlobObjectStoreFromConfig,
    } = await import('./azure-blob-store.js');
    return await createAzureBlobObjectStoreFromConfig({
      serviceUrl: location.serviceUrl,
      container: location.container,
      keyPrefix: location.prefix,
      connection:
        'accountKey' in credential
          ? new AzureAccountKeyConnection(location.account, credential.accountKey)
          : new AzureSasTokenConnection(location.account, credential.sasToken),
      ...(lookup === undefined ? {} : { lookup }),
    });
  } catch {
    throw new ConnectionStoreError('storage_connection_unreachable');
  }
}

async function openLocation(
  location: StorageLocation,
  credential: ConnectionCredential,
  options: ConnectionStoreOptions,
): Promise<ObjectStore> {
  if (credential.provider !== location.kind) {
    throw new ConnectionStoreError('storage_connection_url_invalid');
  }
  if (location.kind === 'file') {
    const root = await resolveFileRoot(location.root, options.fileRoots);
    return createFolderObjectStore(root, {
      ...(options.onSkipped === undefined ? {} : { onSkipped: options.onSkipped }),
    });
  }
  if (location.kind === 's3' && credential.provider === 's3') {
    return openS3(location, credential, options);
  }
  if (location.kind === 'gcs' && credential.provider === 'gcs') {
    return openGcs(location, credential, options);
  }
  if (location.kind === 'azblob' && credential.provider === 'azblob') {
    return openAzblob(location, credential, options);
  }
  throw new ConnectionStoreError('storage_connection_url_invalid');
}

/**
 * Open the store `url` names with `credential`. Read-only unless `options.writable`. S3 and Azure
 * sockets are pinned to the addresses the endpoint check saw.
 */
// @story US-STO-12
export async function openConnectionStore(
  url: string,
  credential: ConnectionCredential,
  options: ConnectionStoreOptions,
): Promise<ObjectStore> {
  const parsed = parseStorageUrl(url);
  if (!parsed.ok) {
    throw new ConnectionStoreError(
      parsed.secret === true
        ? 'storage_connection_url_has_secret'
        : 'storage_connection_url_invalid',
    );
  }
  if (!StorageConnectionCredentialSchema.safeParse(credential).success) {
    throw new ConnectionStoreError('storage_connection_url_invalid');
  }
  options.signal?.throwIfAborted();
  const store = await openLocation(parsed.location, credential, options);
  options.signal?.throwIfAborted();
  return options.writable ? store : readOnlyStore(store);
}
