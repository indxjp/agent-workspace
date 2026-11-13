import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { admitA2aCardFetch, A2A_RATE_LIMITS, resetA2aLimits } from './a2a/limits';
import {
  admitSignInAttempt,
  resetSignInAttempts,
  SIGN_IN_ATTEMPTS_PER_MINUTE,
} from './auth/sign-in-limit';
import {
  admitCliAuthRequest,
  CLI_AUTH_LIMITS,
  resetCliAuthRateLimits,
} from './cli-auth/rate-limit';
import { clearClientIdentity, installClientIdentity } from './client-identity';
import type { Admission } from './http/rate-limit';
import { admitOAuthAddress, OAUTH_RATE_LIMITS, resetOAuthLimits } from './oauth/limits';
import { resolvePublicVisitorIdentity } from './shares/runnable/visitor-identity';

const SECRET = 'a-secure-test-secret-with-at-least-32-characters';
const from = (address: string) => new Headers({ 'x-forwarded-for': address });

/** Each reader that takes the installed client identity by default, with its per-client limit. */
const READERS: readonly (readonly [string, number, (headers: Headers) => Admission])[] = [
  [
    'a2a card fetch',
    A2A_RATE_LIMITS.cardFetchesPerAddressPerMinute,
    (h) => admitA2aCardFetch(h, 0),
  ],
  ['sign-in', SIGN_IN_ATTEMPTS_PER_MINUTE, (h) => admitSignInAttempt(h, 0)],
  ['aw login start', CLI_AUTH_LIMITS.start, (h) => admitCliAuthRequest('start', h, 0)],
  ['OAuth address', OAUTH_RATE_LIMITS.perAddressPerMinute, (h) => admitOAuthAddress(h, 0)],
];

describe('the client-identity readers take the installed settings (part 03, step 2)', () => {
  beforeEach(() => {
    resetA2aLimits();
    resetSignInAttempts();
    resetCliAuthRateLimits();
    resetOAuthLimits();
  });
  afterEach(() => {
    clearClientIdentity();
  });

  it.each(READERS)('%s: counts each proxied client on its own', (_name, limit, admit) => {
    installClientIdentity({ trustedProxyHops: 1, sessionSecret: SECRET });
    for (let i = 0; i < limit; i += 1) expect(admit(from('203.0.113.7')).admitted).toBe(true);
    expect(admit(from('203.0.113.7')).admitted).toBe(false);
    expect(admit(from('203.0.113.8')).admitted).toBe(true);
  });

  it.each(READERS)(
    '%s: without installed settings every caller shares one bucket',
    (_name, limit, admit) => {
      for (let i = 0; i < limit * 10; i += 1) {
        expect(admit(from(`198.51.100.${String(i % 200)}`)).admitted).toBe(true);
      }
      expect(admit(from('203.0.113.99')).admitted).toBe(false);
    },
  );

  it('identifies a runnable public link visitor only with installed settings', () => {
    expect(resolvePublicVisitorIdentity(from('203.0.113.7'))).toMatchObject({
      ok: false,
      code: 'visitor_identity_not_configured',
    });
    installClientIdentity({ trustedProxyHops: 1, sessionSecret: null });
    expect(resolvePublicVisitorIdentity(from('203.0.113.7'))).toMatchObject({
      ok: false,
      code: 'visitor_identity_not_configured',
    });
    installClientIdentity({ trustedProxyHops: 1, sessionSecret: SECRET });
    expect(resolvePublicVisitorIdentity(from('203.0.113.7')).ok).toBe(true);
  });
});
