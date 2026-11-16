import { createHmac, hkdfSync } from 'node:crypto';
import { isIP } from 'node:net';

import { keyDerivation } from '../../auth/core/key-ring.ts';
import { installedClientIdentity, type ClientIdentitySettings } from '../../client-identity';

const FORWARDED_FOR_HEADER = 'x-forwarded-for';
const MAX_FORWARDED_FOR_BYTES = 2_048;
const MAX_FORWARDED_ADDRESSES = 32;
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

const derivedKeys = new Map<string, Buffer>();

/**
 * The visitor key's own key, derived from the session secret (part 06 step 5,
 * `auth/core/key-ring.ts`). It replaced the raw secret, so the key's prefix moved from `v1_` to
 * `v2_`: a visitor keyed the old way never matches a new key. Runnable links are still off (D-06).
 */
function visitorHmacKey(secret: string): Buffer {
  const cached = derivedKeys.get(secret);
  if (cached !== undefined) return cached;
  const { salt, info, lengthBytes } = keyDerivation('share-visitor');
  const key = Buffer.from(hkdfSync('sha256', secret, salt, info, lengthBytes));
  derivedKeys.set(secret, key);
  return key;
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
  identity: ClientIdentitySettings = installedClientIdentity(),
): VisitorIdentityResult {
  const hops = identity.trustedProxyHops;
  const secret = identity.sessionSecret;
  if (hops === null || secret === null) {
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
  const digest = createHmac('sha256', visitorHmacKey(secret))
    .update(VISITOR_KEY_CONTEXT)
    .update('\0')
    .update(address)
    .digest('base64url');
  return { ok: true, visitorKey: `v2_${digest}` };
}
