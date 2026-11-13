import type { ConnectionTransport } from './connection-transport.js';

/**
 * How a one-level `listPage` orders a page, which must match how the server pages folders and
 * files so pages concatenate into one order. `bare-key` is SeaweedFS, the bundled server: folder
 * `a` before file `a.txt`. `native` is AWS: by native name, where folder `a` is `a/` and sorts
 * after `a.txt`.
 */
export type S3ListingOrder = 'bare-key' | 'native';

export interface S3ObjectStoreConfig {
  readonly endpoint?: string;
  /** The host signed links name; the server's own calls keep `endpoint`. */
  readonly publicEndpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  /** Temporary (STS) credentials only: sent with the key pair above, ignored without it. */
  readonly sessionToken?: string;
  readonly forcePathStyle?: boolean;
  readonly keyPrefix?: string;
  /** Development endpoints may provision their bucket; native cloud deployments must not. */
  readonly createBucketIfMissing?: boolean;
  /**
   * `false` skips the one-key listing an open otherwise sends when `createBucketIfMissing` is
   * false. A connection store sets it: its key may list only under an allowed folder, which the
   * store's own prefix need not be, so the connection's first listing of that folder is the check.
   */
  readonly checkBucketOnOpen?: boolean;
  /**
   * How a connection store's client reaches the endpoint: pinned to the checked addresses, or
   * through the outbound proxy. Absent, the SDK's own default agents.
   */
  readonly transport?: ConnectionTransport;
  /**
   * See {@link S3ListingOrder}. Left out, it follows `endpoint`: none, or an `amazonaws.com` host,
   * is AWS (`native`); any other endpoint is `bare-key`.
   */
  readonly listingOrder?: S3ListingOrder;
}

const AWS_HOST = /(?:^|\.)amazonaws\.com(?:\.cn)?$/u;

export function listingOrderFor(endpoint: string | undefined): S3ListingOrder {
  if (endpoint === undefined) return 'native';
  return AWS_HOST.test(new URL(endpoint).hostname) ? 'native' : 'bare-key';
}

/** The configured key pair, if any; half a pair is refused. */
export function s3Credentials(
  config: S3ObjectStoreConfig,
): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined {
  const hasAccessKey = config.accessKeyId !== undefined && config.accessKeyId.trim() !== '';
  const hasSecret = config.secretAccessKey !== undefined && config.secretAccessKey.trim() !== '';
  if (hasAccessKey !== hasSecret) {
    throw new Error('S3 access key id and secret access key must be configured together.');
  }
  if (!hasAccessKey || !hasSecret) return undefined;
  return {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken === undefined || config.sessionToken.trim() === ''
      ? {}
      : { sessionToken: config.sessionToken }),
  };
}
