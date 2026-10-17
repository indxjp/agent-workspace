import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

import { readSessionSecret } from '../../auth/session';

const FORWARDED_FOR_HEADER = 'x-forwarded-for';
const MAX_FORWARDED_FOR_BYTES = 2_048;
const MAX_FORWARDED_ADDRESSES = 32;
const MAX_TRUSTED_PROXY_HOPS = 16;
const VISITOR_KEY_CONTEXT = 'agent-workspace/public-share-visitor/v1';

export type VisitorIdentityFailureCode =
  'visitor_identity_not_configured' | 'invalid_forwarded_for';

export type VisitorIdentityResult =
  | { readonly ok: true; readonly visitorKey: string }
  | {
      readonly ok: false;
      readonly code: VisitorIdentityFailureCode;
      readonly message: string;
    };

function trustedProxyHops(env: Readonly<Record<string, string | undefined>>): number | null {
  const raw = env['AW_TRUSTED_PROXY_HOPS'];
  if (raw === undefined || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const hops = Number(trimmed);
  return Number.isSafeInteger(hops) && hops >= 1 && hops <= MAX_TRUSTED_PROXY_HOPS ? hops : null;
}

function canonicalIp(raw: string): string | null {
  const candidate = raw.trim();
  const family = isIP(candidate);
  if (family === 4) return candidate.split('.').map(Number).join('.');
  if (family !== 6 || candidate.includes('%')) return null;
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Derive an opaque visitor key from a proxy-authenticated client address.
 *
 * A Fetch `Request` does not expose its socket peer. Consequently an unset trust depth is a
 * refusal: accepting an arbitrary forwarding header, or falling back to User-Agent, would let a
 * caller mint a new quota identity at will. The selected address is counted from the right so
 * attacker-supplied entries to the left of the trusted proxy chain never become authoritative.
 */
export function resolvePublicVisitorIdentity(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>> = process.env,
): VisitorIdentityResult {
  const hops = trustedProxyHops(env);
  const secret = readSessionSecret(env);
  if (hops === null || !secret.ok) {
    return {
      ok: false,
      code: 'visitor_identity_not_configured',
      message: 'Runnable public links require a configured trusted proxy chain.',
    };
  }

  const forwardedFor = headers.get(FORWARDED_FOR_HEADER);
  if (
    forwardedFor === null ||
    forwardedFor.length === 0 ||
    Buffer.byteLength(forwardedFor, 'utf8') > MAX_FORWARDED_FOR_BYTES
  ) {
    return {
      ok: false,
      code: 'invalid_forwarded_for',
      message: 'The trusted proxy did not provide a usable client address.',
    };
  }
  const addresses = forwardedFor.split(',');
  if (addresses.length > MAX_FORWARDED_ADDRESSES || addresses.length < hops) {
    return {
      ok: false,
      code: 'invalid_forwarded_for',
      message: 'The trusted proxy did not provide a usable client address.',
    };
  }
  const address = canonicalIp(addresses[addresses.length - hops] ?? '');
  if (address === null) {
    return {
      ok: false,
      code: 'invalid_forwarded_for',
      message: 'The trusted proxy did not provide a usable client address.',
    };
  }
  const digest = createHmac('sha256', secret.secret)
    .update(VISITOR_KEY_CONTEXT)
    .update('\0')
    .update(address)
    .digest('base64url');
  return { ok: true, visitorKey: `v1_${digest}` };
}
