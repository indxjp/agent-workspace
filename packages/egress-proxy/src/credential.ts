import { createHmac, timingSafeEqual } from 'node:crypto';

import { AllowlistError, parseAllowlist, type Allowlist } from './allowlist.js';

export type CredentialRefusal = 'credential_required' | 'credential_invalid' | 'credential_expired';

export type CredentialVerdict =
  | { readonly ok: true; readonly sid: string; readonly allowlist: Allowlist }
  | { readonly ok: false; readonly reason: CredentialRefusal };

const BASIC_USERNAME = 'aw';
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const refuse = (reason: CredentialRefusal): CredentialVerdict => ({ ok: false, reason });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The token of a `Proxy-Authorization: Basic base64('aw:<token>')` header, or null. */
function tokenFrom(header: string): string | null {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(header);
  if (match === null) return null;
  const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  const prefix = `${BASIC_USERNAME}:`;
  return decoded.startsWith(prefix) ? decoded.slice(prefix.length) : null;
}

/**
 * Verifies the stateless per-session credential the runner manager signs for the shared egress
 * proxy. The token is `<p>.<s>`: p is base64url(JSON {sid, exp, hosts}) and s is
 * base64url(HMAC-SHA256(key, p)). The signature is checked before the payload is parsed.
 */
export function verifyCredential(
  header: string | undefined,
  key: Buffer,
  nowSeconds: number,
): CredentialVerdict {
  if (header === undefined || header === '') return refuse('credential_required');
  const token = tokenFrom(header);
  if (token === null) return refuse('credential_invalid');
  const parts = token.split('.');
  const [payload, signature] = parts;
  if (
    parts.length !== 2 ||
    payload === undefined ||
    signature === undefined ||
    !BASE64URL.test(payload) ||
    !BASE64URL.test(signature)
  ) {
    return refuse('credential_invalid');
  }
  const expected = createHmac('sha256', key).update(payload, 'ascii').digest();
  const actual = Buffer.from(signature, 'base64url');
  // Reject non-canonical encodings: the unused low bits of the last character are ignored by decode.
  if (
    actual.length !== expected.length ||
    actual.toString('base64url') !== signature ||
    !timingSafeEqual(actual, expected)
  ) {
    return refuse('credential_invalid');
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return refuse('credential_invalid');
  }
  if (!isRecord(claims)) return refuse('credential_invalid');
  const { sid, exp, hosts } = claims;
  if (typeof sid !== 'string' || sid === '' || typeof exp !== 'number' || !Number.isInteger(exp)) {
    return refuse('credential_invalid');
  }
  if (
    !Array.isArray(hosts) ||
    hosts.length === 0 ||
    !hosts.every((entry): entry is string => typeof entry === 'string') ||
    (hosts.includes('*') && hosts.length > 1)
  ) {
    return refuse('credential_invalid');
  }
  if (exp < nowSeconds) return refuse('credential_expired');
  try {
    return { ok: true, sid, allowlist: parseAllowlist(hosts) };
  } catch (error) {
    if (error instanceof AllowlistError) return refuse('credential_invalid');
    throw error;
  }
}
