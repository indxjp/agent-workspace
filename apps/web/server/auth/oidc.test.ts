import { decodeJwt } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as oidcClient from 'openid-client';

import {
  allowsInsecureDiscovery,
  beginOidcLogin,
  finishOidcLogin,
  oidcDiscoveryOptions,
  readOidcConfiguration,
} from './oidc';

let idTokenClaims: Record<string, unknown> = {};

const { discovery, buildAuthorizationUrl, metadata } = vi.hoisted(() => {
  const served: { current: Record<string, unknown> } = { current: {} };
  return {
    metadata: served,
    discovery: vi.fn<(...args: readonly unknown[]) => Promise<unknown>>(() =>
      Promise.resolve({ serverMetadata: () => served.current }),
    ),
    buildAuthorizationUrl: vi.fn<(...args: readonly unknown[]) => URL>(
      () => new URL('https://identity.example/authorize'),
    ),
  };
});

vi.mock('openid-client', () => ({
  discovery,
  allowInsecureRequests: () => undefined,
  ClientSecretBasic: (secret: string) => ({ basic: secret }),
  Configuration: class {
    readonly args: readonly unknown[];
    constructor(...args: readonly unknown[]) {
      this.args = args;
    }
  },
  randomPKCECodeVerifier: () => 'verifier',
  calculatePKCECodeChallenge: () => Promise.resolve('challenge'),
  randomState: () => 'state',
  buildAuthorizationUrl,
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

describe('plain http discovery (ADR-0161 amendment DI9, issue #2075)', () => {
  const local = { AW_DEPLOYMENT_POSTURE: 'local', HOST: '127.0.0.1' };
  const production = { AW_DEPLOYMENT_POSTURE: 'production' };

  it('is allowed only in the local posture, for an http issuer on a loopback host', () => {
    expect(allowsInsecureDiscovery('http://127.0.0.1:3200', local)).toBe(true);
    expect(allowsInsecureDiscovery('http://localhost:3200', local)).toBe(true);
    expect(allowsInsecureDiscovery('http://[::1]:3200', local)).toBe(true);
    // A derived local posture (NODE_ENV is not production) counts as local too.
    expect(allowsInsecureDiscovery('http://127.0.0.1:3200', {})).toBe(true);
  });

  it('is refused for a non-loopback host, an https issuer, or any other posture', () => {
    expect(allowsInsecureDiscovery('http://idp.example.test', local)).toBe(false);
    expect(allowsInsecureDiscovery('http://10.0.0.1:3200', local)).toBe(false);
    expect(allowsInsecureDiscovery('https://127.0.0.1:3200', local)).toBe(false);
    expect(allowsInsecureDiscovery('not a url', local)).toBe(false);
    expect(allowsInsecureDiscovery('http://127.0.0.1:3200', production)).toBe(false);
    expect(allowsInsecureDiscovery('http://127.0.0.1:3200', { NODE_ENV: 'production' })).toBe(
      false,
    );
  });

  it('passes allowInsecureRequests to discovery only then, and no option otherwise', async () => {
    const read = (issuer: string, env: Record<string, string>) => {
      const configuration = readOidcConfiguration({
        ...env,
        OIDC_ISSUER_URL: issuer,
        OIDC_CLIENT_ID: 'aw-local-console',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
      });
      if (configuration === null) throw new Error('no configuration');
      return configuration;
    };
    expect(oidcDiscoveryOptions(read('http://127.0.0.1:3200', local))).toEqual({
      execute: [oidcClient.allowInsecureRequests],
    });
    expect(oidcDiscoveryOptions(read('https://identity.example', local))).toBeUndefined();
    // Production refuses the http issuer outright, so it is never discovered.
    expect(() => read('http://127.0.0.1:3200', production)).toThrow(/must be an https: URL/u);
    expect(oidcDiscoveryOptions(read('https://identity.example', production))).toBeUndefined();
    // The browser flow passes the same options: https here, so none.
    discovery.mockClear();
    await beginOidcLogin(
      {
        issuer: 'https://identity.example',
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.example/api/auth/callback',
        scopes: ['openid'],
      },
      'a-secure-test-secret-with-at-least-32-characters',
    );
    expect(discovery.mock.calls[0]?.[4]).toBeUndefined();
  });
});

describe('the token endpoint method (ADR-0161 amendment DI4, issue #2075)', () => {
  const configuration = {
    issuer: 'https://identity.example',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://app.example/api/auth/callback',
    scopes: ['openid'],
  };
  const signing = 'a-secure-test-secret-with-at-least-32-characters';

  it('uses client_secret_basic for an issuer that serves only that, as the dev issuer does', async () => {
    metadata.current = { token_endpoint_auth_methods_supported: ['client_secret_basic'] };
    buildAuthorizationUrl.mockClear();
    await beginOidcLogin(configuration, signing);
    const client = buildAuthorizationUrl.mock.calls[0]?.[0] as { args?: readonly unknown[] };
    expect(client.args?.[3]).toEqual({ basic: 'secret' });
  });

  it('keeps the default method for an issuer that lists post, or lists nothing', async () => {
    for (const served of [
      { token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] },
      {},
    ]) {
      metadata.current = served;
      buildAuthorizationUrl.mockClear();
      await beginOidcLogin(configuration, signing);
      const client = buildAuthorizationUrl.mock.calls[0]?.[0] as { args?: unknown };
      expect(client.args).toBeUndefined();
    }
    metadata.current = {};
  });
});
