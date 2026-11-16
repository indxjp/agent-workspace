import { describe, expect, it } from 'vitest';

import {
  parseSessionClaims,
  SESSION_TTL_SECONDS,
  sessionClaimsAt,
  sessionTimeRefusal,
} from './session-rules';

const valid = { sub: 'a@b.test', ws: 'default', role: 'owner', iat: 100, exp: 200 };

describe('session rules, on a clock the test controls', () => {
  it('issues claims from the whole second the session began', () => {
    expect(sessionClaimsAt('a@b.test', 'default', 1_999)).toEqual({
      sub: 'a@b.test',
      ws: 'default',
      role: 'owner',
      iat: 1,
      exp: 1 + SESSION_TTL_SECONDS,
    });
  });

  it.each([
    [{ ...valid, sub: '' }, 'sub is missing or not a non-empty string'],
    [{ ...valid, ws: '' }, 'ws is missing or not a non-empty string'],
    // `JSON.parse('1e999')` is `Infinity`, so a payload can carry a non-finite number.
    [{ ...valid, iat: Infinity }, 'iat is missing or not a finite number'],
    [{ ...valid, exp: Infinity }, 'exp is missing or not a finite number'],
    [{ ...valid, iat: Number.NaN }, 'iat is missing or not a finite number'],
  ])('refuses %j', (payload, reason) => {
    expect(parseSessionClaims(payload)).toEqual({ ok: false, code: 'malformed_session', reason });
  });

  it('accepts a well-formed payload as it is', () => {
    expect(parseSessionClaims(valid)).toEqual({ ok: true, claims: valid });
  });

  it('expires at its exp, to the millisecond', () => {
    const claims = sessionClaimsAt('a@b.test', 'default', 0);
    expect(sessionTimeRefusal(claims, claims.exp * 1000 - 1)).toBeNull();
    expect(sessionTimeRefusal(claims, claims.exp * 1000)).toEqual({
      code: 'expired_session',
      reason: 'session expired',
    });
  });
});
