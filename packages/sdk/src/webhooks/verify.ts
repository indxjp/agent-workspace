import {
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADERS,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  WebhookEventSchema,
  WebhookSecretSchema,
  webhookSignedContent,
  type WebhookEvent,
} from '@indx-workspace/contracts/webhooks';

/**
 * Why a delivery was refused. `missing_header`: a `webhook-*` header is absent, repeated or
 * malformed. `invalid_secret`: the secret is not `whsec_` and 32 base64 bytes, as `create`
 * returned it. `timestamp_out_of_tolerance`: `webhook-timestamp` is further from the clock than the
 * tolerance, a replay or a skewed clock. `signature_mismatch`: no `v1` signature matches, a wrong
 * secret or a changed body. `invalid_payload`: the signature matches but the body is not a
 * `WebhookEvent` of this contracts version, or its `id` is not `webhook-id`.
 */
export type WebhookVerificationErrorCode =
  | 'missing_header'
  | 'invalid_secret'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch'
  | 'invalid_payload';

/**
 * A webhook delivery failed verification (ADR-SDK-18-N3-250 D2). A receiver answers it with a
 * `4xx`, and branches on `code`, never on the message. It is not an `AgentWorkspaceError`: no
 * request to the control plane was made.
 */
export class WebhookVerificationError extends Error {
  public readonly code: WebhookVerificationErrorCode;

  public constructor(code: WebhookVerificationErrorCode, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
  }
}

/**
 * The request headers as the receiver's framework gives them: a Fetch `Headers`, or a plain
 * record such as Node's `IncomingHttpHeaders`, looked up without regard to case.
 */
export type WebhookHeaders =
  Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyWebhookSignatureInput {
  /** The `whsec_…` secret `webhooks.create` returned. */
  readonly secret: string;
  readonly headers: WebhookHeaders;
  /** The request body exactly as received, never parsed and re-serialised. */
  readonly body: string;
  /** How far `webhook-timestamp` may be from `now`, in seconds; 300 by default. */
  readonly toleranceSeconds?: number;
  /** The receiver's clock; the current time by default. */
  readonly now?: Date;
}

function headerValues(headers: WebhookHeaders, name: string): readonly string[] {
  if (headers instanceof Headers) {
    const one = headers.get(name);
    return one === null ? [] : [one];
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) continue;
    found.push(...(typeof value === 'string' ? [value] : value));
  }
  return found;
}

function singleHeader(headers: WebhookHeaders, name: string): string {
  const found = headerValues(headers, name);
  const only = found[0];
  if (found.length !== 1 || only === undefined || only.trim() === '') {
    throw new WebhookVerificationError(
      'missing_header',
      `the ${name} header must be present exactly once`,
    );
  }
  return only.trim();
}

function base64Bytes(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function signingKey(secret: string): Promise<CryptoKey> {
  const keyBytes = WebhookSecretSchema.safeParse(secret).success
    ? base64Bytes(secret.slice(WEBHOOK_SECRET_PREFIX.length))
    : null;
  if (keyBytes === null) {
    throw new WebhookVerificationError(
      'invalid_secret',
      'the secret must be the whsec_ value webhooks.create returned',
    );
  }
  return globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

function timestampSeconds(raw: string): number {
  if (!/^\d{1,15}$/u.test(raw)) {
    throw new WebhookVerificationError(
      'missing_header',
      `the ${WEBHOOK_SIGNATURE_HEADERS.timestamp} header must be integer Unix seconds`,
    );
  }
  return Number(raw);
}

function assertWithinTolerance(timestamp: number, now: Date, toleranceSeconds: number): void {
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError('toleranceSeconds must be a non-negative number');
  }
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
  if (skew > toleranceSeconds) {
    throw new WebhookVerificationError(
      'timestamp_out_of_tolerance',
      `the ${WEBHOOK_SIGNATURE_HEADERS.timestamp} header is ${String(skew)} s from this clock, ` +
        `more than the ${String(toleranceSeconds)} s tolerance`,
    );
  }
}

/** The decoded `v1` entries of `webhook-signature`; other versions and malformed entries are skipped. */
function v1Signatures(header: string): readonly Uint8Array<ArrayBuffer>[] {
  const prefix = `${WEBHOOK_SIGNATURE_VERSION},`;
  return header
    .split(/\s+/u)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => base64Bytes(entry.slice(prefix.length)))
    .filter((bytes): bytes is Uint8Array<ArrayBuffer> => bytes !== null);
}

/**
 * Whether any `v1` entry of a `webhook-signature` header is the HMAC-SHA256 of the signed content
 * under `key`. `crypto.subtle.verify` compares in constant time.
 */
export async function webhookSignatureMatches(
  key: CryptoKey,
  signatureHeader: string,
  signedContent: string,
): Promise<boolean> {
  const content = new TextEncoder().encode(signedContent);
  for (const signature of v1Signatures(signatureHeader)) {
    if (await globalThis.crypto.subtle.verify('HMAC', key, signature, content)) return true;
  }
  return false;
}

function parsedEvent(body: string, id: string): WebhookEvent {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new WebhookVerificationError('invalid_payload', 'the body is not JSON');
  }
  const parsed = WebhookEventSchema.safeParse(json);
  if (!parsed.success) {
    throw new WebhookVerificationError(
      'invalid_payload',
      `the body is not a WebhookEvent: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  if (parsed.data.id !== id) {
    throw new WebhookVerificationError(
      'invalid_payload',
      `the event id is not the ${WEBHOOK_SIGNATURE_HEADERS.id} header`,
    );
  }
  return parsed.data;
}

/**
 * Verify one run-outcome webhook delivery (Standard Webhooks v1, ADR-SDK-18-N3-250 D2, spec
 * §5.17) and return its contract-checked event. The signature is HMAC-SHA256 over
 * `<webhook-id>.<webhook-timestamp>.<body>`; any of the space-separated `v1` entries may match, and
 * the timestamp must be within `toleranceSeconds` of `now` in either direction. It uses Web Crypto
 * only, so it runs in Node, a browser worker and at the edge. Throws
 * {@link WebhookVerificationError}; deduplicate accepted events on `event.id` (the delivery is
 * at-least-once).
 *
 * ```ts
 * const event = await verifyWebhookSignature({ secret, headers: request.headers, body: await request.text() });
 * if (event.type === 'run.completed') record(event.data.run);
 * ```
 */
export async function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): Promise<WebhookEvent> {
  const id = singleHeader(input.headers, WEBHOOK_SIGNATURE_HEADERS.id);
  const rawTimestamp = singleHeader(input.headers, WEBHOOK_SIGNATURE_HEADERS.timestamp);
  const signatureHeader = headerValues(input.headers, WEBHOOK_SIGNATURE_HEADERS.signature).join(
    ' ',
  );
  if (signatureHeader.trim() === '') {
    throw new WebhookVerificationError(
      'missing_header',
      `the ${WEBHOOK_SIGNATURE_HEADERS.signature} header is missing`,
    );
  }
  const key = await signingKey(input.secret);
  assertWithinTolerance(
    timestampSeconds(rawTimestamp),
    input.now ?? new Date(),
    input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  );
  const content = webhookSignedContent(id, rawTimestamp, input.body);
  if (!(await webhookSignatureMatches(key, signatureHeader, content))) {
    throw new WebhookVerificationError(
      'signature_mismatch',
      'no v1 signature matches: the secret is wrong or the body was changed',
    );
  }
  return parsedEvent(input.body, id);
}
