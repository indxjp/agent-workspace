import { createHash, createHmac, randomBytes } from 'node:crypto';

import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signInHref, signInRoutes, type SignInRoutesOptions } from './sign-in.js';

// Every credential is made at run time: nothing secret- or JWT-shaped is written in the source.
const ISSUER = 'https://id.example.com';
const APP = 'https://portal.example.com';
const AW = 'https://aw.example.com';
const CLIENT_SECRET = randomBytes(32).toString('base64url');
const APP_CLIENT_SECRET = randomBytes(32).toString('base64url');
const ACCESS_TOKEN = `awo_live_${randomBytes(16).toString('base64url')}_${randomBytes(32).toString('base64url')}`;
const CODE = randomBytes(24).toString('base64url');

const ENVIRONMENT = {
  AW_URL: AW,
  AW_OIDC_ISSUER_URL: ISSUER,
  AW_OIDC_CLIENT_ID: 'portal',
  AW_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  AW_APP_CLIENT_ID: 'epc_portal',
  AW_APP_CLIENT_SECRET: APP_CLIENT_SECRET,
  NODE_ENV: 'production',
} as const;

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An unsigned ID token: the app checks only its nonce, and the platform its signature. */
function idTokenWith(nonce: string | undefined): string {
  const claims = nonce === undefined ? { sub: 'local:x' } : { sub: 'local:x', nonce };
  return `${segment({ alg: 'EdDSA', typ: 'JWT' })}.${segment(claims)}.${randomBytes(64).toString('base64url')}`;
}

interface Platform {
  readonly calls: RecordedRequest[];
  /** The nonce `/authorize` was last sent. */
  nonce: string | undefined;
  /** The nonce the issuer puts in the ID token instead of {@link nonce}, when set. */
  nonceOverride: string | undefined;
  idToken: string;
  token: () => Response;
  exchange: () => Response;
}

function platform(issuer = ISSUER): Platform & { readonly fetch: typeof fetch } {
  const state: Platform = {
    calls: [],
    nonce: undefined,
    nonceOverride: undefined,
    idToken: '',
    token: () =>
      jsonResponse(200, { access_token: 'opaque', token_type: 'Bearer', id_token: state.idToken }),
    exchange: () =>
      jsonResponse(200, {
        access_token: ACCESS_TOKEN,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 300,
      }),
  };
  const double = fetchDouble((request) => {
    if (request.url.href === `${issuer}/.well-known/openid-configuration`) {
      return jsonResponse(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (request.url.href === `${issuer}/token`) {
      state.idToken = idTokenWith(state.nonceOverride ?? state.nonce);
      return state.token();
    }
    if (request.url.href === `${AW}/api/auth/token-exchange`) return state.exchange();
    return jsonResponse(404, { error: { code: 'not_found', message: 'no' } });
  });
  return Object.assign(state, { calls: double.calls, fetch: double.fetch });
}

function routes(fake: { fetch: typeof fetch }, options: SignInRoutesOptions = {}) {
  return signInRoutes({ environment: ENVIRONMENT, fetch: fake.fetch, ...options });
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieNamed(response: Response, name: string): string | undefined {
  return setCookies(response).find((value) => value.startsWith(`${name}=`));
}

/** The pair `name=value` of a `Set-Cookie`, as a browser sends it back. */
function pairOf(setCookie: string | undefined): string {
  return (setCookie ?? '').split(';')[0] ?? '';
}

function transactionOf(setCookie: string | undefined): Record<string, unknown> {
  const sealed = pairOf(setCookie).slice('aw_sign_in='.length);
  return JSON.parse(
    Buffer.from(sealed.split('.')[0] ?? '', 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

/** Seals `payload` as the routes do, to plant a transaction `start` would never write. */
function sealed(payload: Record<string, unknown>): string {
  const key = createHmac('sha256', CLIENT_SECRET)
    .update('indx-workspace-app/sign-in-transaction/v1')
    .digest();
  const body = segment(payload);
  return `aw_sign_in=${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

async function started(
  fake: Platform & { fetch: typeof fetch },
  next = '/runs',
  options: SignInRoutesOptions = {},
) {
  const response = await routes(fake, options).start(
    new Request(`${APP}/api/sign-in?next=${encodeURIComponent(next)}`),
  );
  const location = new URL(response.headers.get('location') ?? '');
  const transaction = cookieNamed(response, 'aw_sign_in');
  fake.nonce = location.searchParams.get('nonce') ?? undefined;
  return { response, location, transaction };
}

function callbackRequest(query: string, cookie: string | undefined, accept?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  if (accept !== undefined) headers['accept'] = accept;
  return new Request(`${APP}/api/sign-in/callback?${query}`, { headers });
}

async function signedIn(fake: Platform & { fetch: typeof fetch }, accept?: string) {
  const { location, transaction } = await started(fake);
  const state = location.searchParams.get('state') ?? '';
  return routes(fake).callback(
    callbackRequest(`code=${CODE}&state=${state}`, pairOf(transaction), accept),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signInRoutes().start', () => {
  it('redirects to the issuer with S256 PKCE, a state and a nonce, and keeps them in a cookie', async () => {
    const fake = platform();
    const { response, location, transaction } = await started(fake);

    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/authorize`);
    const query = Object.fromEntries(location.searchParams);
    expect(query).toMatchObject({
      response_type: 'code',
      client_id: 'portal',
      redirect_uri: `${APP}/api/sign-in/callback`,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(transaction).toMatch(
      /; Path=\/api\/sign-in; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/u,
    );
    const kept = transactionOf(transaction);
    expect(kept).toMatchObject({ state: query['state'], nonce: query['nonce'], next: '/runs' });
    expect(query['code_challenge']).toBe(
      createHash('sha256').update(String(kept['verifier'])).digest('base64url'),
    );
    expect(String(query['state'])).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('makes a new state, nonce and verifier on every start', async () => {
    const fake = platform();
    const first = transactionOf((await started(fake)).transaction);
    const second = transactionOf((await started(fake)).transaction);
    for (const key of ['state', 'nonce', 'verifier']) expect(first[key]).not.toBe(second[key]);
  });

  it.each(['//evil.example', 'https://evil.example/', '/\\evil.example', '/a\nb', 'runs'])(
    'refuses the unsafe next %j',
    async (next) => {
      const fake = platform();
      const response = await routes(fake).start(
        new Request(`${APP}/api/sign-in?next=${encodeURIComponent(next)}`),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_next' } });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it('sends a browser to the sign-in page with the code instead of the envelope', async () => {
    const fake = platform();
    const response = await routes(fake).start(
      new Request(`${APP}/api/sign-in?next=//evil.example`, { headers: { accept: 'text/html' } }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP}/sign-in?error=invalid_next`);
  });

  it('answers 503 sign_in_not_configured naming the missing or invalid variables, never a value', async () => {
    const fake = platform();
    const response = await signInRoutes({
      environment: {
        ...ENVIRONMENT,
        AW_APP_CLIENT_SECRET: undefined,
        AW_OIDC_ISSUER_URL: 'ftp://x',
      },
      fetch: fake.fetch,
    }).start(new Request(`${APP}/api/sign-in`));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; details: string[] } };
    expect(body.error.code).toBe('sign_in_not_configured');
    expect(body.error.details.toSorted()).toEqual(['AW_APP_CLIENT_SECRET', 'AW_OIDC_ISSUER_URL']);
    expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ['a non-loopback http issuer', 'http://id.example.com', 'development'],
    ['a non-loopback http issuer in production', 'http://id.example.com', 'production'],
    ['a loopback http issuer in production', 'http://127.0.0.1:3200', 'production'],
  ])('refuses %s before any discovery', async (_name, issuer, nodeEnv) => {
    const fake = platform(issuer);
    const response = await signInRoutes({
      environment: { ...ENVIRONMENT, AW_OIDC_ISSUER_URL: issuer, NODE_ENV: nodeEnv },
      fetch: fake.fetch,
    }).start(new Request(`${APP}/api/sign-in`));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'sign_in_not_configured', details: ['AW_OIDC_ISSUER_URL'] },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("admits aw dev's loopback http issuer outside production", async () => {
    const issuer = 'http://127.0.0.1:3200';
    const fake = platform(issuer);
    const response = await signInRoutes({
      environment: { ...ENVIRONMENT, AW_OIDC_ISSUER_URL: issuer, NODE_ENV: 'development' },
      fetch: fake.fetch,
    }).start(new Request('http://127.0.0.1:3100/api/sign-in'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(/^http:\/\/127\.0\.0\.1:3200\/authorize\?/u);
    // Plain http: the cookie is not Secure, or the browser would drop it.
    expect(cookieNamed(response, 'aw_sign_in')).not.toContain('Secure');
  });

  it("derives the redirect URI from the browser's Host, not the host Next.js rewrote", async () => {
    const issuer = 'http://127.0.0.1:3200';
    const fake = platform(issuer);
    const response = await signInRoutes({
      environment: { ...ENVIRONMENT, AW_OIDC_ISSUER_URL: issuer, NODE_ENV: 'development' },
      fetch: fake.fetch,
    }).start(
      new Request('http://localhost:3100/api/sign-in', { headers: { host: '127.0.0.1:3100' } }),
    );
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:3100/api/sign-in/callback',
    );

    const proxied = await routes(platform()).start(
      new Request('http://portal.example.com/api/sign-in', {
        headers: { host: 'portal.example.com', 'x-forwarded-proto': 'https' },
      }),
    );
    expect(proxied.status).toBe(303);
    expect(cookieNamed(proxied, 'aw_sign_in')).toMatch(
      /; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/u,
    );
  });

  it('refuses a discovery document that names another issuer', async () => {
    const fake = fetchDouble(() =>
      jsonResponse(200, {
        issuer: 'https://other.example.com',
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
      }),
    );
    const response = await routes(fake).start(new Request(`${APP}/api/sign-in`));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'issuer_unavailable' } });
  });
});

describe('signInRoutes().callback', () => {
  it('redeems the code with client_secret_basic, exchanges the ID token, and sets the person cookie', async () => {
    const fake = platform();
    const { location, transaction } = await started(fake);
    const state = location.searchParams.get('state') ?? '';
    const response = await routes(fake).callback(
      callbackRequest(`code=${CODE}&state=${state}`, pairOf(transaction)),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP}/runs`);
    const token = fake.calls.find((call) => call.url.href === `${ISSUER}/token`);
    expect(token?.method).toBe('POST');
    expect(token?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`portal:${CLIENT_SECRET}`).toString('base64')}`,
    );
    const form = token?.init.body;
    expect(form).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(form as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: `${APP}/api/sign-in/callback`,
      code_verifier: transactionOf(transaction)['verifier'],
    });
    const exchange = fake.calls.find((call) => call.url.href === `${AW}/api/auth/token-exchange`);
    expect(exchange?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`epc_portal:${APP_CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(exchange?.json).toMatchObject({ subject_token: fake.idToken });
    expect(cookieNamed(response, 'aw_user_token')).toBe(
      `aw_user_token=${ACCESS_TOKEN}; Path=/; Max-Age=300; HttpOnly; SameSite=Lax; Secure`,
    );
    expect(cookieNamed(response, 'aw_sign_in')).toMatch(
      /^aw_sign_in=; Path=\/api\/sign-in; Max-Age=0;/u,
    );
  });

  it('refuses a missing or mismatched state', async () => {
    const fake = platform();
    const { transaction } = await started(fake);
    for (const query of [`code=${CODE}`, `code=${CODE}&state=other`, 'state=x']) {
      const response = await routes(fake).callback(callbackRequest(query, pairOf(transaction)));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'sign_in_state_mismatch' } });
    }
    expect(fake.calls.some((call) => call.url.pathname === '/token')).toBe(false);
  });

  it('refuses a missing, tampered or expired transaction', async () => {
    let clock = 1_000_000;
    const fake = platform();
    const { location, transaction } = await started(fake, '/runs', { now: () => clock });
    const query = `code=${CODE}&state=${location.searchParams.get('state') ?? ''}`;
    const pair = pairOf(transaction);
    const tampered = `${pair.slice(0, -2)}${pair.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const cookie of [undefined, 'aw_sign_in=', tampered, 'aw_sign_in=a.b.c']) {
      const response = await routes(fake).callback(callbackRequest(query, cookie));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'sign_in_expired' } });
    }
    clock += 600_000;
    const late = await routes(fake, { now: () => clock }).callback(callbackRequest(query, pair));
    expect(await late.json()).toMatchObject({ error: { code: 'sign_in_expired' } });
  });

  it('refuses an unsafe next even in a sealed transaction', async () => {
    const fake = platform();
    const cookie = sealed({
      state: 'state',
      nonce: 'nonce',
      verifier: randomBytes(32).toString('base64url'),
      next: '//evil.example',
      expiresAt: Date.now() + 60_000,
    });
    const response = await routes(fake).callback(
      callbackRequest(`code=${CODE}&state=state`, cookie),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_next' } });
  });

  it('refuses an ID token whose nonce is not the one sent', async () => {
    const fake = platform();
    fake.nonceOverride = 'another';
    const response = await signedIn(fake);
    expect(await response.json()).toMatchObject({ error: { code: 'sign_in_state_mismatch' } });
    expect(fake.calls.some((call) => call.url.pathname === '/api/auth/token-exchange')).toBe(false);
  });

  it("passes the issuer's refusal on as issuer_refused, with its RFC 6749 error", async () => {
    const fake = platform();
    const { transaction } = await started(fake);
    const response = await routes(fake).callback(
      callbackRequest('error=access_denied&state=x', pairOf(transaction)),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'issuer_refused', details: ['access_denied'] },
    });

    fake.token = () => jsonResponse(400, { error: 'invalid_grant' });
    const redeemed = await signedIn(fake);
    expect(await redeemed.json()).toMatchObject({
      error: { code: 'issuer_refused', details: ['invalid_grant'] },
    });
  });

  it.each([
    ['subject_not_member', 403],
    ['subject_token_invalid', 401],
    ['subject_token_wrong_audience', 401],
    ['invalid_client', 401],
    ['token_exchange_not_configured', 503],
    ['rate_limited', 429],
  ])("passes the platform's %s on by its code and status", async (code, status) => {
    const fake = platform();
    fake.exchange = () => jsonResponse(status, { error: { code, message: 'the platform words' } });
    const response = await signedIn(fake);
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(code);
    expect(body.error.message).not.toContain('the platform words');
    expect(cookieNamed(response, 'aw_user_token')).toBeUndefined();
  });

  it('sends a browser to the sign-in page with a refusal code', async () => {
    const fake = platform();
    fake.exchange = () =>
      jsonResponse(403, { error: { code: 'subject_not_member', message: 'x' } });
    const response = await signedIn(fake, 'text/html,application/xhtml+xml');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP}/sign-in?error=subject_not_member`);
  });

  it('answers upstream_failure for any other platform answer', async () => {
    const fake = platform();
    fake.exchange = () => jsonResponse(500, { error: { code: 'internal_error', message: 'x' } });
    const response = await signedIn(fake);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'upstream_failure' } });
  });

  it('never logs or answers a secret, a code, a verifier or a token', async () => {
    const logged: unknown[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => logged.push(...args));
    }
    const seen: string[] = [];
    const remember = async (response: Response) => {
      seen.push(response.headers.get('location') ?? '', await response.text());
      return response;
    };
    const fake = platform();
    await remember(await signedIn(fake));
    const idToken = fake.idToken;
    fake.exchange = () => {
      throw new Error(`boom ${APP_CLIENT_SECRET}`);
    };
    await remember(await signedIn(fake));
    fake.exchange = () =>
      jsonResponse(403, { error: { code: 'subject_not_member', message: 'x' } });
    await remember(await signedIn(fake));
    const verifier = String(transactionOf((await started(fake)).transaction)['verifier']);

    const text = [...seen, ...logged.map(String)].join('\n');
    for (const secret of [
      CLIENT_SECRET,
      APP_CLIENT_SECRET,
      ACCESS_TOKEN,
      CODE,
      idToken,
      verifier,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('signInRoutes().signOut', () => {
  it('clears the person cookie and goes to the sign-in page', async () => {
    const response = await signInRoutes({ environment: {} }).signOut(
      new Request(`${APP}/api/sign-out`, { method: 'POST' }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP}/sign-in`);
    expect(cookieNamed(response, 'aw_user_token')).toBe(
      'aw_user_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    );
  });
});

describe('signInHref', () => {
  it('links to the sign-in page with a safe next only', () => {
    expect(signInHref()).toBe('/sign-in');
    expect(signInHref('/')).toBe('/sign-in');
    expect(signInHref('/runs/1?x=y')).toBe('/sign-in?next=%2Fruns%2F1%3Fx%3Dy');
    expect(signInHref('//evil.example')).toBe('/sign-in');
    expect(signInHref('https://evil.example')).toBe('/sign-in');
  });
});
