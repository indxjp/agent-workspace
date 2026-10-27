import { createHash, createHmac } from 'node:crypto';

/**
 * SigV4 query-string signing for one S3 object URL (`UNSIGNED-PAYLOAD`).
 *
 * Why this is not `@aws-sdk/s3-request-presigner`: the repository pins every third-party
 * dependency exactly (`tests/dependency-policy.test.ts`) and that package is not installed. The
 * algorithm is fixed and small, and `signed-url.test.ts` pins it to the worked example in AWS's
 * "Authenticating Requests: Using Query Parameters" documentation and to a real S3-compatible
 * server. Swap this module for the SDK presigner if the dependency is ever admitted.
 */

interface S3PresignCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
}

export interface S3PresignInput {
  readonly method: 'GET' | 'PUT';
  readonly scheme: 'http' | 'https';
  /** The `Host` header value: host name plus the port when it is not the scheme's default. */
  readonly host: string;
  /** The unencoded object path, starting with `/`; each segment is percent-encoded here. */
  readonly path: string;
  readonly region: string;
  readonly credentials: S3PresignCredentials;
  readonly expiresInSeconds: number;
  /** Lower-case header name to value. `host` is added here. These are signed, so they are required. */
  readonly signedHeaders?: Readonly<Record<string, string>>;
  /** Extra query parameters that are part of the signature (e.g. `response-content-type`). */
  readonly query?: Readonly<Record<string, string>>;
  readonly now: Date;
}

/** RFC 3986 unreserved set, as SigV4 requires. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** The presigned URL: the object URL with the SigV4 query appended. */
export function presignS3Url(input: S3PresignInput): string {
  const stamp = input.now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
  const date = stamp.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;

  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.signedHeaders ?? {})) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/gu, ' ');
  }
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(';');

  const query: Record<string, string> = {
    ...input.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(input.credentials.sessionToken === undefined || input.credentials.sessionToken === ''
      ? {}
      : { 'X-Amz-Security-Token': input.credentials.sessionToken }),
  };
  const canonicalQuery = Object.entries(query)
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalPath = input.path.split('/').map(encode).join('/');
  const canonicalRequest = [
    input.method,
    canonicalPath,
    canonicalQuery,
    headerNames.map((name) => `${name}:${headers[name]}\n`).join(''),
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, date), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return `${input.scheme}://${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
