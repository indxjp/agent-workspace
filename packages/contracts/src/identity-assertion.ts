import { z } from 'zod';

import { SecretReferenceSchema } from './secret-reference.js';

/**
 * ADR-0142 D1, issue #1278: how a run tells an opted-in connector who is asking.
 *
 * The platform signs and the connector's server verifies with the same two pure functions,
 * {@link signIdentity} and {@link verifyIdentity} (WebCrypto HMAC-SHA256, no dependency), so a
 * verifier in any server stack that runs this package checks exactly what the platform signed.
 *
 * Never log a header, a signature or a key. Nothing here echoes one: a refusal is a code.
 */

/** The request header that carries the assertion to a connector that opted in. */
export const IDENTITY_ASSERTION_HEADER = 'x-aw-identity';

/** How long an assertion lives after it is signed, in seconds. */
export const IDENTITY_ASSERTION_TTL_SECONDS = 300;

/** The clock skew a verifier allows past `exp`, in seconds. No more. */
export const IDENTITY_ASSERTION_SKEW_SECONDS = 30;

/**
 * Who a `sub` is. `visitor` belongs to the assertion's vocabulary only: `PRINCIPAL_KINDS` in
 * `team.ts` stays `membership` and `api-key`.
 */
export const IDENTITY_PRINCIPAL_KINDS = ['membership', 'api-key', 'visitor'] as const;
export type IdentityPrincipalKind = (typeof IDENTITY_PRINCIPAL_KINDS)[number];

/** The longest `sub` (and `StartRunRequest.subject`), in characters. */
export const IDENTITY_SUBJECT_MAX_LENGTH = 256;

/**
 * An opt-in `identity: { secret: NAME }` on a connector (project file and connector resource): a
 * reference to the signing secret by name, never the key itself.
 */
export const ConnectorIdentitySchema = SecretReferenceSchema;
export type ConnectorIdentity = z.infer<typeof ConnectorIdentitySchema>;

/** The signed payload: exactly these six keys; any other is refused. `exp` is epoch seconds. */
export const IdentityAssertionPayloadSchema = z
  .strictObject({
    sub: z.string().min(1).max(IDENTITY_SUBJECT_MAX_LENGTH),
    principalKind: z.enum(IDENTITY_PRINCIPAL_KINDS),
    workspace: z.string().min(1),
    runId: z.string().min(1),
    /** The id of the connector the assertion is signed for. */
    aud: z.string().min(1),
    exp: z.number().int().positive(),
  })
  .readonly();
export type IdentityAssertionPayload = z.infer<typeof IdentityAssertionPayloadSchema>;

/** Why a verifier refused an assertion. Each is a `401` that never echoes the token. */
export const IDENTITY_ASSERTION_PROBLEM_CODES = {
  identity_assertion_invalid: 401,
  identity_assertion_expired: 401,
  identity_audience_mismatch: 401,
  identity_workspace_mismatch: 401,
} as const;
export type IdentityAssertionProblemCode = keyof typeof IDENTITY_ASSERTION_PROBLEM_CODES;

export type IdentityVerification =
  | { readonly ok: true; readonly payload: IdentityAssertionPayload }
  | { readonly ok: false; readonly code: IdentityAssertionProblemCode };

/** What the verifier serves: the connector it is and the workspace it belongs to. */
export interface IdentityExpectation {
  readonly audience: string;
  readonly workspace: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** `null` for anything that is not the canonical unpadded base64url of some bytes. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/gu, '+').replace(/_/gu, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return toBase64Url(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

function hmacKey(key: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/**
 * Signs `payload` into the header value `base64url(JSON payload).base64url(HMAC-SHA256)`. The MAC
 * covers the encoded payload text. Throws on a payload the schema refuses or an empty key: both are
 * a programming error on the platform side, not input.
 */
export async function signIdentity(
  payload: IdentityAssertionPayload,
  key: string,
): Promise<string> {
  if (key === '') throw new Error('identity key must not be empty');
  const encoded = toBase64Url(
    encoder.encode(JSON.stringify(IdentityAssertionPayloadSchema.parse(payload))),
  );
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), encoder.encode(encoded));
  return `${encoded}.${toBase64Url(new Uint8Array(mac))}`;
}

async function signatureMatches(
  encoded: string,
  signature: Uint8Array<ArrayBuffer>,
  keys: readonly string[],
): Promise<boolean> {
  for (const key of keys) {
    if (key === '') continue;
    // `verify` compares in constant time.
    if (
      await crypto.subtle.verify(
        'HMAC',
        await hmacKey(key, 'verify'),
        signature,
        encoder.encode(encoded),
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks an `x-aw-identity` header value against the connector's secret(s) (a list while the secret
 * rotates). In order: the header's shape, the signature, the payload's exact six keys, `exp` (with
 * {@link IDENTITY_ASSERTION_SKEW_SECONDS} of skew), then `aud` and `workspace` against `expected`.
 * It never throws on bad input, and a refusal carries a code only.
 */
export async function verifyIdentity(
  header: string,
  key: string | readonly string[],
  now: Date,
  expected: IdentityExpectation,
): Promise<IdentityVerification> {
  const invalid = { ok: false, code: 'identity_assertion_invalid' } as const;
  const parts = header.split('.');
  if (parts.length !== 2) return invalid;
  const [encoded = '', encodedSignature = ''] = parts;
  const signature = fromBase64Url(encodedSignature);
  const payloadBytes = fromBase64Url(encoded);
  if (signature === null || payloadBytes === null) return invalid;
  try {
    if (!(await signatureMatches(encoded, signature, typeof key === 'string' ? [key] : key))) {
      return invalid;
    }
    const payload = IdentityAssertionPayloadSchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)),
    );
    if (!payload.success) return invalid;
    if (Math.floor(now.getTime() / 1000) > payload.data.exp + IDENTITY_ASSERTION_SKEW_SECONDS) {
      return { ok: false, code: 'identity_assertion_expired' };
    }
    if (payload.data.aud !== expected.audience) {
      return { ok: false, code: 'identity_audience_mismatch' };
    }
    if (payload.data.workspace !== expected.workspace) {
      return { ok: false, code: 'identity_workspace_mismatch' };
    }
    return { ok: true, payload: payload.data };
  } catch {
    return invalid;
  }
}
