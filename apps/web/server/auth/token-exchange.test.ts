/**
 * `POST /api/auth/token-exchange` (ADR-0161) over its real handler, with an in-memory OAuth runtime,
 * a local `jose` key pair and a stub key source standing in for the configured issuer: no test here
 * reaches the network, and one proves that a URL in the token's header is never fetched. The
 * PostgreSQL half — the token row, the audit row, admission and the run — is
 * `token-exchange.integration.test.ts`.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ID_TOKEN_TYPE,
  OAUTH_ACCESS_TOKEN_PATTERN,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeResponseSchema,
} from '@indx-workspace/contracts/token-exchange';

import { POST as TOKEN_EXCHANGE } from '../../app/api/auth/token-exchange/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import type { ExchangedToken, ExchangeMember, OAuthClient } from '../oauth/runtime';
import { resetOAuthLimits } from '../oauth/limits';
import { mintClientSecret } from '../oauth/tokens';
import { toResponse } from '../rbac/http';
import { decide } from '../rbac/decide';
import { Principal } from '../rbac/principal';
import {
  appBackendResource,
  exchangeToken,
  resetTokenExchangeLimits,
  TOKEN_EXCHANGE_RATE_LIMITS,
  type IdTokenKeySource,
} from './token-exchange';

const ISSUER = 'https://idp.example';
const AUDIENCE = 'portal-web';
const WORKSPACE = 'ws-client';
const OTHER_WORKSPACE = 'ws-other';
const BOUND_AGENT = '11111111-1111-4111-8111-111111111111';
const UNBOUND_AGENT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-31T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

const ENV = {
  OIDC_ISSUER_URL: ISSUER,
  OIDC_CLIENT_ID: 'platform-browser',
  OIDC_CLIENT_SECRET: 'browser-secret',
  OIDC_REDIRECT_URI: 'https://aw.example/api/auth/callback',
};

let signingKey: CryptoKey;
let jwks: { keys: JWK[] };
let otherKey: CryptoKey;
let secret: string;
let client: OAuthClient;
let members: Map<string, ExchangeMember & { workspaceId: string }>;
let issued: { client: OAuthClient; member: ExchangeMember; token: ExchangedToken }[];
let logged: string[];

const keySource = (): IdTokenKeySource => ({
  issuer: ISSUER,
  algorithms: ['RS256', 'HS256'],
  keys: createLocalJWKSet(jwks),
});

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

beforeEach(async () => {
  resetTokenExchangeLimits();
  resetOAuthLimits();
  const minted = await mintClientSecret();
  secret = minted.presented;
  client = {
    id: '33333333-3333-4333-8333-333333333333',
    workspaceId: WORKSPACE,
    name: 'portal',
    kind: 'app-backend',
    actsForPrincipalId: 'creator',
    clientSecretHash: minted.secretHash,
    redirectUris: [],
    oidcAudience: AUDIENCE,
    agentIds: [BOUND_AGENT],
    resourcePath: null,
  };
  members = new Map([
    ['person-sub', { workspaceId: WORKSPACE, userId: 'user-1', principalId: 'pr-1', label: 'Ada' }],
    [
      'elsewhere-sub',
      { workspaceId: OTHER_WORKSPACE, userId: 'user-2', principalId: 'pr-2', label: 'Bo' },
    ],
  ]);
  issued = [];
  logged = [];
  installTestDomains({
    oauth: {
      findClient: (id) => Promise.resolve(id === client.id ? client : null),
      canRunAll: () => Promise.resolve(false),
      agentNames: () => Promise.resolve(null),
      tokens: () => Promise.reject(new Error('the exchange writes through issueExchanged')),
      audit: () => Promise.reject(new Error('the exchange writes through issueExchanged')),
      findMember: (workspaceId, issuer, subject) => {
        const found = members.get(subject);
        return Promise.resolve(
          issuer === ISSUER && found !== undefined && found.workspaceId === workspaceId
            ? { userId: found.userId, principalId: found.principalId, label: found.label }
            : null,
        );
      },
      issueExchanged: (exchangeClient, member, token) => {
        issued.push({ client: exchangeClient, member, token });
        return Promise.resolve();
      },
    },
  });
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    logged.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearApplicationContext();
});

interface IdTokenOptions {
  readonly claims?: Record<string, unknown>;
  readonly key?: CryptoKey;
  readonly header?: Record<string, unknown>;
}

async function idToken(options: IdTokenOptions = {}): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    sub: 'person-sub',
    aud: AUDIENCE,
    iat: NOW_S - 10,
    exp: NOW_S + 600,
    email: 'ada@example.com',
    email_verified: true,
    ...options.claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1', ...options.header })
    .sign(options.key ?? signingKey);
}

function exchangeRequest(
  token: string,
  auth: string | null = `Basic ${btoa(`${client.id}:${secret}`)}`,
  extra: Record<string, unknown> = {},
): Request {
  return new Request('https://aw.example/api/auth/token-exchange', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
      ...(auth === null ? {} : { authorization: auth }),
    },
    body: JSON.stringify({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: token,
      subject_token_type: ID_TOKEN_TYPE,
      ...extra,
    }),
  });
}

async function exchange(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = ENV,
): Promise<{ status: number; code: string | null; response: Response; body: unknown }> {
  const response = toResponse(
    await exchangeToken(request, {
      env,
      now: () => NOW,
      loadKeySource: () => Promise.resolve(keySource()),
    }),
  );
  const body: unknown = await response.json();
  const code =
    typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: { code: string } }).error.code)
      : null;
  return { status: response.status, code, response, body };
}

describe('a successful exchange (ADR-0161 D1-D3)', () => {
  it('issues a 300 s awo_live_ token for the person, no-store, and writes one token and audit', async () => {
    const out = await exchange(exchangeRequest(await idToken()));
    expect(out.status).toBe(200);
    expect(out.response.headers.get('cache-control')).toBe('no-store');
    const body = TokenExchangeResponseSchema.parse(out.body);
    expect(body.access_token).toMatch(OAUTH_ACCESS_TOKEN_PATTERN);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 300 });
    expect(issued).toHaveLength(1);
    expect(issued[0]?.member).toEqual({ userId: 'user-1', principalId: 'pr-1', label: 'Ada' });
    expect(issued[0]?.token).toMatchObject({
      resource: appBackendResource(client.id),
      expiresAt: new Date(NOW.getTime() + 300_000),
    });
  });

  it('gives every exchange its own token family', async () => {
    await exchange(exchangeRequest(await idToken()));
    await exchange(exchangeRequest(await idToken()));
    expect(new Set(issued.map((row) => row.token.familyId)).size).toBe(2);
  });

  it('never logs or echoes the ID token, the client secret or the issued token', async () => {
    const token = await idToken();
    const ok = await exchange(exchangeRequest(token));
    const refused = await exchange(exchangeRequest(await idToken({ claims: { aud: 'other' } })));
    const issuedToken = (ok.body as { access_token: string }).access_token;
    const everything = [...logged, JSON.stringify(refused.body)].join('\n');
    for (const value of [token, secret, issuedToken]) expect(everything).not.toContain(value);
  });
});

describe('each refusal by its exact code (ADR-0161 D5, D7)', () => {
  const cases: readonly [string, () => Promise<Request>, number, string][] = [
    [
      'a wrong issuer',
      async () => exchangeRequest(await idToken({ claims: { iss: 'https://evil.example' } })),
      401,
      'subject_token_wrong_issuer',
    ],
    [
      'an expired ID token',
      async () => exchangeRequest(await idToken({ claims: { exp: NOW_S - 60, iat: NOW_S - 700 } })),
      401,
      'subject_token_invalid',
    ],
    [
      'a wrong audience',
      async () => exchangeRequest(await idToken({ claims: { aud: 'another-app' } })),
      401,
      'subject_token_wrong_audience',
    ],
    [
      'email_verified false',
      async () => exchangeRequest(await idToken({ claims: { email_verified: false } })),
      401,
      'subject_token_invalid',
    ],
    [
      'a signature from another key',
      async () => exchangeRequest(await idToken({ key: otherKey })),
      401,
      'subject_token_invalid',
    ],
    [
      'an unknown kid',
      async () => exchangeRequest(await idToken({ header: { kid: 'not-in-the-set' } })),
      401,
      'subject_token_invalid',
    ],
    [
      'an unsigned token',
      async () => {
        const [, payload] = (await idToken()).split('.');
        return exchangeRequest(`${btoa('{"alg":"none"}').replace(/=+$/u, '')}.${payload ?? ''}.`);
      },
      401,
      'subject_token_invalid',
    ],
    [
      'an unknown (iss, sub)',
      async () => exchangeRequest(await idToken({ claims: { sub: 'nobody' } })),
      403,
      'subject_not_member',
    ],
    [
      'a member of another workspace only',
      async () => exchangeRequest(await idToken({ claims: { sub: 'elsewhere-sub' } })),
      403,
      'subject_not_member',
    ],
    [
      'a wrong client secret',
      async () =>
        exchangeRequest(
          await idToken(),
          `Basic ${btoa(`${client.id}:${(await mintClientSecret()).presented}`)}`,
        ),
      401,
      'invalid_client',
    ],
    [
      'no client credentials',
      async () => exchangeRequest(await idToken(), null),
      401,
      'invalid_client',
    ],
    [
      'a client secret in the body',
      async () => exchangeRequest(await idToken(), null, { client_secret: secret }),
      401,
      'invalid_client',
    ],
  ];

  it.each(cases)('refuses %s', async (_, build, status, code) => {
    const out = await exchange(await build());
    expect({ status: out.status, code: out.code }).toEqual({ status, code });
    expect(out.response.headers.get('cache-control')).toBe('no-store');
    expect(issued).toEqual([]);
  });

  it('answers the two subject_not_member cases with the same body', async () => {
    const unknown = await exchange(exchangeRequest(await idToken({ claims: { sub: 'nobody' } })));
    const elsewhere = await exchange(
      exchangeRequest(await idToken({ claims: { sub: 'elsewhere-sub' } })),
    );
    expect(unknown.body).toEqual(elsewhere.body);
  });

  it('refuses a revoked client as invalid_client, with WWW-Authenticate', async () => {
    const id = client.id;
    client = { ...client, id: '44444444-4444-4444-8444-444444444444' };
    const out = await exchange(
      exchangeRequest(await idToken(), `Basic ${btoa(`${id}:${secret}`)}`),
    );
    expect({ status: out.status, code: out.code }).toEqual({ status: 401, code: 'invalid_client' });
    expect(out.response.headers.get('www-authenticate')).toMatch(/^Basic /u);
  });

  it.each([
    ['an mcp-project client', { kind: 'mcp-project' as const, oidcAudience: null }],
    ['a builder client', { kind: 'builder' as const, oidcAudience: null }],
    ['a public app-backend client', { clientSecretHash: null }],
  ])('refuses %s as invalid_client', async (_, over) => {
    client = { ...client, ...over };
    const out = await exchange(exchangeRequest(await idToken()));
    expect({ status: out.status, code: out.code }).toEqual({ status: 401, code: 'invalid_client' });
  });

  it('answers 503 token_exchange_not_configured with no OIDC, and with no database', async () => {
    const noOidc = await exchange(exchangeRequest(await idToken()), {});
    expect({ status: noOidc.status, code: noOidc.code }).toEqual({
      status: 503,
      code: 'token_exchange_not_configured',
    });
    clearApplicationContext();
    const noDatabase = await exchange(exchangeRequest(await idToken()));
    expect({ status: noDatabase.status, code: noDatabase.code }).toEqual({
      status: 503,
      code: 'token_exchange_not_configured',
    });
  });

  it('refuses a body with an extra field, a wrong grant or an oversized token as invalid_body', async () => {
    for (const request of [
      exchangeRequest(await idToken(), undefined, { audience: 'x' }),
      exchangeRequest(await idToken(), undefined, { grant_type: 'client_credentials' }),
      exchangeRequest('a'.repeat(16_385)),
    ]) {
      const out = await exchange(request);
      expect({ status: out.status, code: out.code }).toEqual({ status: 400, code: 'invalid_body' });
    }
  });
});

describe('the key set comes from configuration, never from the token (ADR-0161 D5 step 2)', () => {
  it('never fetches a jku, x5u or jwk named in the header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const attacker = await generateKeyPair('RS256', { extractable: true });
    const header = {
      kid: 'attacker',
      jku: 'https://evil.example/jwks.json',
      x5u: 'https://evil.example/cert.pem',
      jwk: await exportJWK(attacker.publicKey),
    };
    const out = await exchange(
      exchangeRequest(await idToken({ key: attacker.privateKey, header })),
    );
    expect({ status: out.status, code: out.code }).toEqual({
      status: 401,
      code: 'subject_token_invalid',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an HMAC token even when the issuer advertises HS256', async () => {
    const hmac = await new SignJWT({ iss: ISSUER, sub: 'person-sub', aud: AUDIENCE })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuedAt(NOW_S)
      .setExpirationTime(NOW_S + 60)
      .sign(new TextEncoder().encode(secret));
    const out = await exchange(exchangeRequest(hmac));
    expect(out.code).toBe('subject_token_invalid');
  });
});

describe('limits (ADR-0161 D12)', () => {
  it('pins the limits', () => {
    expect(TOKEN_EXCHANGE_RATE_LIMITS).toEqual({
      perClientPerMinute: 120,
      failedAuthPerAddressPerMinute: 10,
    });
  });

  it('locks out an address after ten failed authentications, before the secret is read', async () => {
    // A proxy-authenticated address, so the count is this address's and not the shared bucket's.
    const proxied = { ...ENV, AW_TRUSTED_PROXY_HOPS: '1', SESSION_SECRET: 'k'.repeat(48) };
    const wrong = `Basic ${btoa(`${client.id}:${(await mintClientSecret()).presented}`)}`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await exchange(exchangeRequest(await idToken(), wrong), proxied)).code).toBe(
        'invalid_client',
      );
    }
    const locked = await exchange(exchangeRequest(await idToken()), proxied);
    expect({ status: locked.status, code: locked.code }).toEqual({
      status: 429,
      code: 'rate_limited',
    });
    expect(locked.response.headers.get('retry-after')).toMatch(/^\d+$/u);
  });

  it('counts the client only after it authenticated, at 120 a minute', async () => {
    const token = await idToken();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      expect((await exchange(exchangeRequest(token))).status).toBe(200);
    }
    expect((await exchange(exchangeRequest(token))).code).toBe('rate_limited');
  });
});

describe('the route file', () => {
  it('maps the handler, answering 503 where this process has no OIDC', async () => {
    clearApplicationContext();
    const response = await TOKEN_EXCHANGE(exchangeRequest(await idToken()));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the issued token cannot exceed the client scope (ADR-0161 D8)', () => {
  const person = Principal.fromOAuthToken(
    Principal.fromDirectoryRecord({
      principalId: 'pr-1',
      kind: 'membership',
      workspaceId: WORKSPACE,
      role: 'owner',
      label: 'Ada',
      userId: 'user-1',
      apiKeyId: null,
      actsForPrincipalId: null,
    }),
    { kind: 'app-backend', id: '33333333-3333-4333-8333-333333333333', agentIds: [BOUND_AGENT] },
    { clientId: '33333333-3333-4333-8333-333333333333', audience: appBackendResource('c') },
  );
  const decideFor = (method: string, path: string) =>
    decide({ role: person.role, method, path, ownership: 'own', scope: person.scope });

  it('is a valid principal, even for an Owner never wider than the grammar', () => {
    expect(Principal.isPrincipal(person)).toBe(true);
    expect(decideFor('POST', `/api/agents/${BOUND_AGENT}/runs`).effect).toBe('allow');
    expect(decideFor('POST', `/api/agents/${BOUND_AGENT.toUpperCase()}/runs`).effect).toBe('allow');
    expect(decideFor('GET', '/api/me').effect).toBe('allow');
    expect(decideFor('POST', `/api/runs/${BOUND_AGENT}/interrupt`).effect).toBe('allow');
  });

  it.each([
    ['POST', `/api/agents/${UNBOUND_AGENT}/runs`],
    ['GET', '/api/workspaces'],
    ['POST', '/api/files'],
    ['GET', '/api/runs'],
    ['POST', `/api/runs/${BOUND_AGENT}/feedback`],
    ['POST', '/api/endpoint-clients'],
    ['POST', '/api/tokens'],
  ])('%s %s is 403 token_out_of_scope', (method, path) => {
    const decision = decideFor(method, path);
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.code).toBe('token_out_of_scope');
  });
});
