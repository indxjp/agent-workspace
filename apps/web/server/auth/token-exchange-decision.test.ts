import { describe, expect, it } from 'vitest';

import {
  claimsRefusal,
  decideExchange,
  ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
  type ExchangeClient,
  type IdTokenClaims,
} from './token-exchange-decision';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;

const client: ExchangeClient = {
  kind: 'app-backend',
  oidcAudience: 'portal-web',
  hasClientSecret: true,
  revoked: false,
};
const claims: IdTokenClaims = {
  sub: 'person-1',
  aud: 'portal-web',
  iat: NOW_S - 10,
  exp: NOW_S + 600,
  email_verified: true,
};
const member = { userId: 'user-1', principalId: 'principal-1' };

describe('decideExchange (ADR-0161 D5, D7)', () => {
  it('accepts a verified member of the client workspace for 300 seconds', () => {
    expect(decideExchange({ client, claims, member, now: NOW })).toEqual({
      kind: 'accept',
      membershipPrincipalId: 'principal-1',
      userId: 'user-1',
      expiresAt: new Date(NOW.getTime() + 300_000),
    });
  });

  it.each([
    ['a wrong client kind', { ...client, kind: 'mcp-project' as const }],
    ['a revoked client', { ...client, revoked: true }],
    ['a public client', { ...client, hasClientSecret: false }],
    ['a client with no audience', { ...client, oidcAudience: null }],
  ])('refuses %s as invalid_client', (_, refused) => {
    expect(decideExchange({ client: refused, claims, member, now: NOW })).toEqual({
      kind: 'refuse',
      code: 'invalid_client',
    });
  });

  it('refuses no client as invalid_client', () => {
    expect(decideExchange({ client: null, claims, member, now: NOW })).toEqual({
      kind: 'refuse',
      code: 'invalid_client',
    });
  });

  it.each([
    ['email_verified false', { ...claims, email_verified: false }],
    ['email_verified as a string', { ...claims, email_verified: 'true' }],
    ['no email_verified', { ...claims, email_verified: undefined }],
    ['an empty sub', { ...claims, sub: '' }],
    ['no sub', { ...claims, sub: undefined }],
    ['no exp', { ...claims, exp: undefined }],
    ['no iat', { ...claims, iat: undefined }],
    ['an exp past the tolerance', { ...claims, exp: NOW_S - ID_TOKEN_CLOCK_TOLERANCE_SECONDS }],
    ['an iat in the future', { ...claims, iat: NOW_S + ID_TOKEN_CLOCK_TOLERANCE_SECONDS }],
  ])('refuses %s as subject_token_invalid', (_, refused) => {
    expect(decideExchange({ client, claims: refused, member, now: NOW })).toEqual({
      kind: 'refuse',
      code: 'subject_token_invalid',
    });
  });

  it('accepts an exp and an iat inside the tolerance', () => {
    const skewed = { ...claims, exp: NOW_S - 29, iat: NOW_S + 29 };
    expect(decideExchange({ client, claims: skewed, member, now: NOW }).kind).toBe('accept');
  });

  it('requires azp to be the client audience when aud has more than one value', () => {
    const many = { ...claims, aud: ['portal-web', 'other-app'] };
    expect(decideExchange({ client, claims: many, member, now: NOW })).toEqual({
      kind: 'refuse',
      code: 'subject_token_wrong_audience',
    });
    expect(
      decideExchange({ client, claims: { ...many, azp: 'portal-web' }, member, now: NOW }).kind,
    ).toBe('accept');
    expect(
      decideExchange({ client, claims: { ...claims, aud: ['portal-web'] }, member, now: NOW }).kind,
    ).toBe('accept');
  });

  it('answers an unknown person and a member of another workspace only alike', () => {
    // Both reach the decision as "no membership of the client's workspace".
    expect(decideExchange({ client, claims, member: null, now: NOW })).toEqual({
      kind: 'refuse',
      code: 'subject_not_member',
    });
  });

  it('checks the claims before the person, so a bad token never reaches the lookup', () => {
    expect(claimsRefusal({ ...claims, email_verified: false }, 'portal-web', NOW)).toEqual({
      kind: 'refuse',
      code: 'subject_token_invalid',
    });
    expect(claimsRefusal(claims, 'portal-web', NOW)).toBeNull();
  });
});
