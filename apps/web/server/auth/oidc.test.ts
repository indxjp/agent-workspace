import { decodeJwt } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { beginOidcLogin, finishOidcLogin, readOidcConfiguration } from './oidc';

let idTokenClaims: Record<string, unknown> = {};

vi.mock('openid-client', () => ({
  discovery: () => Promise.resolve({}),
  randomPKCECodeVerifier: () => 'verifier',
  calculatePKCECodeChallenge: () => Promise.resolve('challenge'),
  randomState: () => 'state',
  buildAuthorizationUrl: () => new URL('https://identity.example/authorize'),
  authorizationCodeGrant: () => Promise.resolve({ claims: () => idTokenClaims }),
}));

describe('generic OIDC configuration', () => {
  it('retains bootstrap-only mode when all OIDC variables are absent', () => {
    expect(readOidcConfiguration({})).toBeNull();
  });

  it('fails closed on a partial configuration', () => {
    expect(() => readOidcConfiguration({ OIDC_ISSUER_URL: 'https://identity.example' })).toThrow(
      /requires/,
    );
  });

  it('accepts a provider-neutral authorization-code configuration', () => {
    expect(
      readOidcConfiguration({
        OIDC_ISSUER_URL: 'https://identity.example',
        OIDC_CLIENT_ID: 'client',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_REDIRECT_URI: 'https://app.example/p/oidc-transactions/messages',
      }),
    ).toMatchObject({
      clientId: 'client',
      redirectUri: 'https://app.example/p/oidc-transactions/messages',
      scopes: ['openid', 'profile', 'email'],
    });
  });
});

describe('the OIDC transaction carries the post-sign-in destination', () => {
  const configuration = {
    issuer: 'https://identity.example',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://app.example/api/auth/callback',
    scopes: ['openid'],
  };
  const secret = 'a-secure-test-secret-with-at-least-32-characters';
  const callback = new URL('https://app.example/api/auth/callback?code=c&state=state');
  beforeEach(() => {
    idTokenClaims = { sub: 'subject', email: 'A@Example.com', email_verified: true };
  });

  it.each([
    ['false', false],
    ['absent', undefined],
    ['the string "true"', 'true'],
  ])('refuses an identity whose email_verified is %s', async (_name, emailVerified) => {
    idTokenClaims = { sub: 'subject', email: 'a@example.com', email_verified: emailVerified };
    const { transaction } = await beginOidcLogin(configuration, secret);
    await expect(finishOidcLogin(configuration, secret, callback, transaction)).rejects.toThrow(
      /email_verified/,
    );
  });

  it('signs `next` into the transaction and hands it back after the callback', async () => {
    const next = '/oauth/authorize?client_id=c';
    const { transaction } = await beginOidcLogin(configuration, secret, Date.now(), next);
    expect(decodeJwt(transaction)['next']).toBe(next);
    expect(await finishOidcLogin(configuration, secret, callback, transaction)).toMatchObject({
      email: 'a@example.com',
      next,
    });
  });

  it('leaves `next` out when there is none, so an older cookie still verifies', async () => {
    const { transaction } = await beginOidcLogin(configuration, secret);
    expect(decodeJwt(transaction)).not.toHaveProperty('next');
    expect((await finishOidcLogin(configuration, secret, callback, transaction)).next).toBeNull();
  });
});
