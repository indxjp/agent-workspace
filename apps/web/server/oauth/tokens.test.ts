import { describe, expect, it } from 'vitest';

import {
  clientSecretDigest,
  isPkceChallenge,
  mintClientSecret,
  mintOAuthToken,
  oauthTokenHash,
  parseOAuthToken,
  pkceS256Challenge,
  readBearerOAuthAccessAttempt,
  verifyPkceS256,
} from './tokens';

// RFC 7636 Appendix B.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('OAuth token wire format', () => {
  it('round-trips each kind and stores only a digest of the secret', async () => {
    for (const kind of ['code', 'access', 'refresh'] as const) {
      const minted = await mintOAuthToken(kind);
      const parsed = parseOAuthToken(kind, minted.presented);
      expect(parsed).not.toBeNull();
      expect(minted.presented).not.toContain(minted.tokenHash);
      expect(await oauthTokenHash(kind, minted.presented)).toBe(minted.tokenHash);
    }
  });

  it('does not accept a token of one kind as another (audience of the credential)', async () => {
    const access = await mintOAuthToken('access');
    const refresh = await mintOAuthToken('refresh');
    expect(parseOAuthToken('refresh', access.presented)).toBeNull();
    expect(parseOAuthToken('access', refresh.presented)).toBeNull();
    expect(parseOAuthToken('code', access.presented)).toBeNull();
  });

  it('refuses a malformed secret or a non-string', async () => {
    const { presented } = await mintOAuthToken('access');
    expect(parseOAuthToken('access', `${presented}x`)).toBeNull();
    expect(parseOAuthToken('access', presented.slice(0, -1))).toBeNull();
    expect(parseOAuthToken('access', presented.replace(/.$/u, '!'))).toBeNull();
    expect(parseOAuthToken('access', 42)).toBeNull();
    expect(await oauthTokenHash('access', undefined)).toBeNull();
  });

  it('mints distinct tokens', async () => {
    const a = await mintOAuthToken('access');
    const b = await mintOAuthToken('access');
    expect(a.presented).not.toBe(b.presented);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe('OAuth client secret', () => {
  it('digests to the stored hash and refuses a malformed value', async () => {
    const { presented, secretHash } = await mintClientSecret();
    expect(presented.startsWith('awcs_live_')).toBe(true);
    expect(presented).not.toContain(secretHash);
    expect(await clientSecretDigest(presented)).toBe(secretHash);
    expect(await clientSecretDigest('awcs_live_short')).toBeNull();
    expect(await clientSecretDigest((await mintOAuthToken('access')).presented)).toBeNull();
  });
});

describe('Authorization header classification', () => {
  it('separates absent, other credential kinds, malformed OAuth tokens and presented ones', async () => {
    const { presented } = await mintOAuthToken('access');
    expect(readBearerOAuthAccessAttempt(null)).toEqual({ kind: 'absent' });
    expect(readBearerOAuthAccessAttempt('Bearer awk_live_whatever')).toEqual({ kind: 'other' });
    expect(readBearerOAuthAccessAttempt('Basic abc')).toEqual({ kind: 'other' });
    expect(readBearerOAuthAccessAttempt('Bearer awo_live_short')).toEqual({ kind: 'invalid' });
    expect(readBearerOAuthAccessAttempt(`Bearer ${presented}`).kind).toBe('presented');
  });
});

describe('PKCE S256 (RFC 7636)', () => {
  it('computes the Appendix B challenge', async () => {
    expect(await pkceS256Challenge(VERIFIER)).toBe(CHALLENGE);
    expect(isPkceChallenge(CHALLENGE)).toBe(true);
  });

  it('verifies the matching verifier only', async () => {
    expect(await verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true);
    expect(await verifyPkceS256(`${VERIFIER.slice(0, -1)}A`, CHALLENGE)).toBe(false);
  });

  it('never treats the challenge as a plain verifier', async () => {
    expect(await verifyPkceS256(CHALLENGE, CHALLENGE)).toBe(false);
  });

  it('refuses a verifier outside 43-128 unreserved characters', async () => {
    const short = 'a'.repeat(42);
    const long = 'a'.repeat(129);
    expect(await verifyPkceS256(short, await pkceS256Challenge(short))).toBe(false);
    expect(await verifyPkceS256(long, await pkceS256Challenge(long))).toBe(false);
    const bad = `${'a'.repeat(42)}!`;
    expect(await verifyPkceS256(bad, await pkceS256Challenge(bad))).toBe(false);
  });

  it('rejects a malformed challenge', () => {
    expect(isPkceChallenge('short')).toBe(false);
    expect(isPkceChallenge(`${CHALLENGE}=`)).toBe(false);
  });
});
