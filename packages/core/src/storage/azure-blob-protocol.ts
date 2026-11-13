import type { ConnectionTransport } from './connection-transport.js';
import type {
  ByteRange,
  ObjectMeta,
  SignedUrl,
  SignedUrlRequest,
  WriteOptions,
} from './object-store.js';

/**
 * The Azure Blob backend's SDK-free half: the container port, the connection config, the
 * content-type metadata, error classification, write conditions and the URL and name checks.
 * `azure-blob-store.ts` builds on it; only it and `azure-blob-sdk-container.ts` may load
 * `@azure/storage-blob`.
 */

export const CONTENT_TYPE_KNOWN_METADATA = 'aw_content_type_known';

export interface AzureBlobFileEntry {
  readonly kind: 'file';
  readonly name: string;
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly lastModified: Date;
}

export interface AzureBlobFolderEntry {
  readonly kind: 'folder';
  readonly name: string;
}

export type AzureBlobEntry = AzureBlobFileEntry | AzureBlobFolderEntry;

/** What {@link AzureBlobContainer.readStream} found. */
export interface AzureBlobDownload {
  meta: ObjectMeta;
  range: { readonly start: number; readonly end: number } | null;
  body: ReadableStream<Uint8Array>;
}

/** Narrow external-service port so ordinary CI can exercise the backend without Azure. */
export interface AzureBlobContainer {
  assertReady(): Promise<void>;
  /** A server-side copy, bytes, content type and metadata; a missing source is a no-op. */
  copy(sourceName: string, destinationName: string): Promise<void>;
  delete(name: string): Promise<void>;
  head(name: string): Promise<ObjectMeta | null>;
  /**
   * The whole blob's meta, the bytes of `range` (all of them when omitted) and the range actually
   * served. Throws {@link RangeNotSatisfiableError} when the blob no longer holds `range`.
   * `signal` stops the download, the body included.
   */
  readStream(
    name: string,
    range: ByteRange | undefined,
    signal?: AbortSignal,
  ): Promise<AzureBlobDownload | null>;
  /**
   * `null` when a precondition failed; the caller turns that into {@link ObjectConflictError}.
   * `options.signal` stops the upload, its staged blocks and its commit included.
   */
  writeStream(
    name: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: WriteOptions,
  ): Promise<ObjectMeta | null>;
  listPage(
    prefix: string,
    options: AzureBlobListOptions,
  ): Promise<{ entries: readonly AzureBlobEntry[]; cursor: string | null }>;
  /** User-delegation SAS URL for one blob; absent when the container cannot sign. No blob I/O. */
  signUrl?(name: string, request: SignedUrlRequest): Promise<SignedUrl>;
}

export interface AzureBlobListOptions {
  delimiter: boolean;
  cursor?: string;
  limit: number;
  signal?: AbortSignal;
}

/**
 * The connection secret sits in a private field behind a getter, so `JSON.stringify`, `Object.keys`
 * or a spread of a config never carries it, while `'accountKey' in connection` still holds.
 */
export class AzureAccountKeyConnection {
  readonly account: string;
  readonly #accountKey: string;
  constructor(account: string, accountKey: string) {
    this.account = account;
    this.#accountKey = accountKey;
  }
  get accountKey(): string {
    return this.#accountKey;
  }
}

/** The SAS-token counterpart of {@link AzureAccountKeyConnection}. */
export class AzureSasTokenConnection {
  readonly account: string;
  readonly #sasToken: string;
  constructor(account: string, sasToken: string) {
    this.account = account;
    this.#sasToken = sasToken;
  }
  get sasToken(): string {
    return this.#sasToken;
  }
}

/** A customer's storage account credential: a shared key, or a SAS token placed on the service URL. */
type AzureBlobConnection = { readonly account: string } & (
  { readonly accountKey: string } | { readonly sasToken: string }
);

export interface AzureBlobObjectStoreConfig {
  readonly serviceUrl: string;
  readonly container: string;
  readonly managedIdentityClientId?: string;
  readonly keyPrefix?: string;
  /** Absent means the deployment's own identity (`DefaultAzureCredential`). */
  readonly connection?: AzureBlobConnection;
  /**
   * How a connection store's client reaches the service: pinned to the checked addresses, or
   * through the outbound proxy. Absent, the SDK's own agents (and its own proxy policy).
   */
  readonly transport?: ConnectionTransport;
}

export function contentType(
  metadata: Readonly<Record<string, string>> | undefined,
  value: string | undefined,
) {
  return metadata?.[CONTENT_TYPE_KNOWN_METADATA] === 'true' ? (value ?? null) : null;
}

export function azureStatusCode(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
}

/**
 * A 404 that means "this blob does not exist". A missing container also answers 404
 * (`ContainerNotFound`); that is a misconfiguration, never an absent object, so it must surface.
 */
export function isBlobMissing(error: unknown): boolean {
  return azureStatusCode(error) === 404 && azureErrorCode(error) !== 'ContainerNotFound';
}

function azureErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * A failed precondition: 412 (`ConditionNotMet`), or `BlobAlreadyExists` for `If-None-Match: *`.
 * `If-Match` on a missing blob may answer `BlobNotFound`; that is the same "not the version you
 * named" and also conflicts. Every other 404 or 409 (a lease, a missing container) is a real failure.
 */
export function isWriteConflict(error: unknown, ifMatch: boolean): boolean {
  const code = azureErrorCode(error);
  return (
    azureStatusCode(error) === 412 ||
    code === 'ConditionNotMet' ||
    code === 'BlobAlreadyExists' ||
    (ifMatch && code === 'BlobNotFound')
  );
}

export function writeConditions(options: WriteOptions) {
  if (options.ifNoneMatch === '*') return { ifNoneMatch: '*' };
  return options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch };
}

/** The headers a PUT to a signed URL must send: a block blob, and the content type it names. */
export function signedPutHeaders(request: SignedUrlRequest): Readonly<Record<string, string>> {
  if (request.method !== 'PUT') return {};
  const hasContentType = request.contentType !== undefined && request.contentType !== null;
  return {
    'x-ms-blob-type': 'BlockBlob',
    ...(hasContentType
      ? {
          'x-ms-blob-content-type': request.contentType ?? '',
          [`x-ms-meta-${CONTENT_TYPE_KNOWN_METADATA}`]: 'true',
        }
      : {}),
  };
}

/** Clock skew allowance for a user-delegation key that starts "now". */
export const DELEGATION_KEY_BACKDATE_MS = 5 * 60 * 1_000;
/** How long past this host's clock a delegation key stays valid at the least. */
const DELEGATION_KEY_MARGIN_MS = 5 * 60 * 1_000;
/** Azure refuses a user-delegation key that expires more than seven days from now. */
const DELEGATION_KEY_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * The window the user-delegation key is asked for. Azure refuses a key whose expiry has already
 * passed (400), so it is anchored on this host's clock and only widened to cover the SAS window,
 * which may start in the past (a caller's `now`). The SAS keeps its own start and expiry, so a link
 * that has expired is still refused.
 */
export function delegationKeyWindow(
  sasStartsOn: Date,
  sasExpiresOn: Date,
  realNow: number,
): { startsOn: Date; expiresOn: Date } {
  const expiresOn = Math.min(
    Math.max(sasExpiresOn.getTime(), realNow + DELEGATION_KEY_MARGIN_MS),
    realNow + DELEGATION_KEY_MAX_LIFETIME_MS,
  );
  return {
    startsOn: new Date(Math.min(sasStartsOn.getTime(), realNow - DELEGATION_KEY_BACKDATE_MS)),
    expiresOn: new Date(expiresOn),
  };
}

/**
 * The server's own store takes an HTTPS account URL and nothing else (ADR-0060). A connection has
 * already passed the egress check, which refuses `http:` except to loopback outside production, so
 * it may also name an emulator's path-style `http://host:port/<account>` URL.
 */
export function parseServiceUrl(raw: string, connectionAccount?: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Azure Blob storage requires a parseable HTTPS service URL.');
  }
  const path = url.pathname.replace(/\/$/u, '');
  if (
    (url.protocol !== 'https:' && !(connectionAccount !== undefined && url.protocol === 'http:')) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (path !== '' && path !== (connectionAccount === undefined ? '' : `/${connectionAccount}`))
  ) {
    throw new Error(
      'Azure Blob storage requires an HTTPS account service URL without credentials, a SAS query, a path or a fragment (ADR-0060).',
    );
  }
  return url.toString().replace(/\/$/u, '');
}

/** The configured container name, trimmed, or a refusal when Azure would not accept it. */
export function checkedContainerName(raw: string): string {
  const container = raw.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(container) || container.includes('--')) {
    throw new Error(
      'Azure Blob container names must be 3-63 lowercase letters, digits or hyphens.',
    );
  }
  return container;
}
