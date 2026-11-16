/**
 * Issue #2075, ADR-0161's 2026-11-01 amendment (DI1 to DI7): the development issuer over its real
 * `node:http` listener, driven by `fetch` as an OIDC client drives it. Its ID tokens are verified
 * here with `node:crypto` against its own JWKS.
 */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEV_ISSUER_PORT_OFFSET,
  DEV_ISSUER_PORT_SEARCH_LIMIT,
  DEV_ISSUER_SESSION_COOKIE,
  devIssuerSubject,
  formLocale,
  startDevIssuer,
  type DevIssuer,
} from './issuer.js';

const PASSWORD = randomBytes(18).toString('base64url');
const OWNER = 'owner@localhost.test';
const REDIRECT = 'http://127.0.0.1:3399/api/sign-in/callback';

const started: DevIssuer[] = [];

afterEach(async () => {
  for (const issuer of started.splice(0)) await issuer.close();
});

/** A web port whose issuer range is free on this machine: the issuer's own search finds one. */
async function issuer(
  readPassword: () => Promise<string | undefined> = () => Promise.resolve(PASSWORD),
): Promise<DevIssuer> {
  const running = await startDevIssuer({
    webPort: 20_000 + Math.floor(Math.random() * 20_000),
    defaultEmail: OWNER,
    readPassword,
  });
  started.push(running);
  return running;
}

function pkce(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeParameters(
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid email profile',
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  };
}

function form(parameters: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters).toString(),
    redirect: 'manual',
  };
}

/** Sign in through the form and return the redirect's code and the session cookie. */
async function signIn(
  running: DevIssuer,
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {},
): Promise<{ readonly code: string; readonly cookie: string; readonly location: URL }> {
  const response = await fetch(
    `${running.url}/authorize`,
    form({ ...authorizeParameters(clientId, challenge, extra), email: OWNER, password: PASSWORD }),
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { code: location.searchParams.get('code') ?? '', cookie, location };
}

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
}

async function token(
  running: DevIssuer,
  authorization: string | undefined,
  parameters: Record<string, string>,
): Promise<Response> {
  const init = form(parameters);
  return fetch(`${running.url}/token`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      ...(authorization === undefined ? {} : { authorization }),
    },
  });
}

/** `GET /jwks` on 127.0.0.1 with `host` as the `Host` header, which `fetch` would not send. */
function hostRequest(
  port: number,
  host: string,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/jwks', headers: { host } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function closeAll(servers: readonly Server[]): Promise<unknown> {
  return Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
}

/** Bind all 50 ports one web port's issuer would try, retrying elsewhere when one is taken. */
async function holdIssuerRange(): Promise<{
  readonly webPort: number;
  readonly holders: readonly Server[];
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const webPort = 20_000 + Math.floor(Math.random() * 20_000);
    const holders: Server[] = [];
    try {
      for (let step = 0; step < DEV_ISSUER_PORT_SEARCH_LIMIT; step += 1) {
        const holder = createServer();
        await new Promise<void>((resolve, reject) => {
          holder.once('error', reject);
          holder.listen(webPort + DEV_ISSUER_PORT_OFFSET + step, '127.0.0.1', resolve);
        });
        holders.push(holder);
      }
      return { webPort, holders };
    } catch {
      await closeAll(holders);
    }
  }
  throw new Error('no free range of 50 ports to hold');
}

function decodePart(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('the development issuer (ADR-0161 amendment DI1 to DI7)', () => {
  it('serves discovery with the fields DI4 lists, on 127.0.0.1 from the web port + 200', async () => {
    const running = await issuer();
    expect(running.url).toBe(`http://127.0.0.1:${String(running.port)}`);
    const discovery = (await (
      await fetch(`${running.url}/.well-known/openid-configuration`)
    ).json()) as Record<string, unknown>;
    expect(discovery).toEqual({
      issuer: running.url,
      authorization_endpoint: `${running.url}/authorize`,
      token_endpoint: `${running.url}/token`,
      jwks_uri: `${running.url}/jwks`,
      response_types_supported: ['code'],
      response_modes_supported: ['query', 'form_post'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['EdDSA'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'profile', 'email'],
    });
    expect((await fetch(`${running.url}/userinfo`)).status).toBe(404);
  });

  it('holds one Ed25519 key in its JWKS', async () => {
    const running = await issuer();
    const jwks = (await (await fetch(`${running.url}/jwks`)).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('refuses any Host header but 127.0.0.1:<port> with 421, localhost included', async () => {
    const running = await issuer();
    for (const host of ['evil.example', `localhost:${String(running.port)}`, '127.0.0.1']) {
      const other = await hostRequest(running.port, host);
      expect(other.status, host).toBe(421);
      expect(JSON.parse(other.body)).toEqual({ error: 'dev_issuer_wrong_host' });
    }
    expect((await hostRequest(running.port, `127.0.0.1:${String(running.port)}`)).status).toBe(200);
  });

  it('runs the code flow, and its ID token verifies against the JWKS with the DI7 claims', async () => {
    const running = await issuer();
    const secret = running.registerClient('desk', REDIRECT);
    const { verifier, challenge } = pkce();
    const { code, location } = await signIn(running, 'desk', challenge);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('state-1');
    const response = await token(running, basic('desk', secret), {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 600 });
    const [header, payload, signature] = String(body['id_token']).split('.');
    const jwks = (await (await fetch(`${running.url}/jwks`)).json()) as {
      keys: Record<string, string>[];
    };
    const key = createPublicKey({ key: jwks.keys[0] ?? {}, format: 'jwk' });
    expect(
      verify(
        null,
        Buffer.from(`${header ?? ''}.${payload ?? ''}`),
        key,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
    expect(decodePart(header)).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: jwks.keys[0]?.['kid'] });
    const claims = decodePart(payload);
    expect(claims).toMatchObject({
      iss: running.url,
      sub: devIssuerSubject(OWNER),
      aud: 'desk',
      azp: 'desk',
      email: OWNER,
      email_verified: true,
      nonce: 'nonce-1',
    });
    expect(Number(claims['exp']) - Number(claims['iat'])).toBe(600);
    expect(devIssuerSubject(` ${OWNER.toUpperCase()} `)).toBe(devIssuerSubject(OWNER));
    expect(devIssuerSubject(OWNER)).toMatch(/^local:[A-Za-z0-9_-]{43}$/u);
  });

  it('answers form_post with a form the browser posts to the client, and a script allowed by hash', async () => {
    const running = await issuer();
    running.registerClient('desk', REDIRECT);
    const response = await fetch(
      `${running.url}/authorize`,
      form({
        ...authorizeParameters('desk', pkce().challenge, { response_mode: 'form_post' }),
        email: OWNER,
        password: PASSWORD,
      }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="${REDIRECT}"`);
    expect(html).toContain('name="code"');
    expect(response.headers.get('content-security-policy')).toMatch(
      /script-src 'sha256-[^']+'; form-action 'self' http:\/\/127\.0\.0\.1:3399/u,
    );
  });

  it('a code works once, for its own client, redirect URI and verifier', async () => {
    const running = await issuer();
    const secret = running.registerClient('desk', REDIRECT);
    const otherSecret = running.registerClient('other', 'http://127.0.0.1:3399/other');
    const { verifier, challenge } = pkce();
    const grant = (code: string, overrides: Record<string, string> = {}) => ({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      ...overrides,
    });
    const first = await signIn(running, 'desk', challenge);
    expect((await token(running, basic('desk', secret), grant(first.code))).status).toBe(200);
    const again = await token(running, basic('desk', secret), grant(first.code));
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'invalid_grant' });
    for (const [authorization, overrides] of [
      [basic('other', otherSecret), {}],
      [basic('desk', secret), { redirect_uri: 'http://127.0.0.1:3399/elsewhere' }],
      [basic('desk', secret), { code_verifier: pkce().verifier }],
    ] as const) {
      const { code } = await signIn(running, 'desk', challenge);
      const refused = await token(running, authorization, grant(code, overrides));
      expect(await refused.json()).toEqual({ error: 'invalid_grant' });
    }
  });

  it('needs client_secret_basic at /token, and refuses another grant', async () => {
    const running = await issuer();
    const secret = running.registerClient('desk', REDIRECT);
    const { verifier, challenge } = pkce();
    const { code } = await signIn(running, 'desk', challenge);
    const grant = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    };
    for (const authorization of [undefined, basic('desk', 'wrong'), basic('nobody', secret)]) {
      const refused = await token(running, authorization, grant);
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toMatch(/^Basic/u);
      expect(await refused.json()).toEqual({ error: 'invalid_client' });
    }
    // client_secret_post is not served.
    const posted = await token(running, undefined, {
      ...grant,
      client_id: 'desk',
      client_secret: secret,
    });
    expect(posted.status).toBe(401);
    const other = await token(running, basic('desk', secret), { grant_type: 'refresh_token' });
    expect(await other.json()).toEqual({ error: 'unsupported_grant_type' });
    const json = await fetch(`${running.url}/token`, {
      method: 'POST',
      headers: { authorization: basic('desk', secret), 'content-type': 'application/json' },
      body: JSON.stringify(grant),
    });
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ error: 'invalid_request' });
  });

  it('refuses an unknown client and an unregistered redirect URI without redirecting', async () => {
    const running = await issuer();
    running.registerClient('desk', REDIRECT);
    const { challenge } = pkce();
    const unknown = new URLSearchParams(authorizeParameters('nobody', challenge));
    const refusedClient = await fetch(`${running.url}/authorize?${unknown.toString()}`, {
      redirect: 'manual',
    });
    expect(refusedClient.status).toBe(400);
    expect(await refusedClient.text()).toContain('invalid_client');
    const wrong = new URLSearchParams({
      ...authorizeParameters('desk', challenge),
      redirect_uri: 'http://127.0.0.1:3399/evil',
    });
    const refusedRedirect = await fetch(`${running.url}/authorize?${wrong.toString()}`, {
      redirect: 'manual',
    });
    expect(refusedRedirect.status).toBe(400);
    expect(refusedRedirect.headers.get('location')).toBeNull();
    expect(await refusedRedirect.text()).toContain('invalid_redirect_uri');
  });

  it('redirects invalid_request for a missing or plain PKCE challenge, and the other DI4 errors', async () => {
    const running = await issuer();
    running.registerClient('desk', REDIRECT);
    const { challenge } = pkce();
    const errorOf = async (parameters: Record<string, string>): Promise<string | null> => {
      const query = new URLSearchParams(parameters).toString();
      const response = await fetch(`${running.url}/authorize?${query}`, { redirect: 'manual' });
      expect(response.status).toBe(302);
      return new URL(response.headers.get('location') ?? '').searchParams.get('error');
    };
    const base = authorizeParameters('desk', challenge);
    const without = (name: string) =>
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== name));
    const withoutChallenge = without('code_challenge');
    expect(await errorOf(withoutChallenge)).toBe('invalid_request');
    expect(await errorOf({ ...base, code_challenge_method: 'plain' })).toBe('invalid_request');
    const withoutState = without('state');
    expect(await errorOf(withoutState)).toBe('invalid_request');
    expect(await errorOf({ ...base, response_type: 'token' })).toBe('unsupported_response_type');
    expect(await errorOf({ ...base, scope: 'email' })).toBe('invalid_scope');
    expect(await errorOf({ ...base, prompt: 'none' })).toBe('login_required');
  });

  it('refuses a wrong password with one message, and limits failed posts to 10 a minute', async () => {
    const running = await issuer();
    running.registerClient('desk', REDIRECT);
    const { challenge } = pkce();
    const post = (password: string) =>
      fetch(
        `${running.url}/authorize`,
        form({ ...authorizeParameters('desk', challenge), email: OWNER, password }),
      );
    const refused = await post('not-the-password');
    expect(refused.status).toBe(401);
    const html = await refused.text();
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('That email or password was not accepted.');
    expect(html).not.toContain('not-the-password');
    for (let attempt = 1; attempt < 10; attempt += 1) await post('wrong');
    const limited = await post(PASSWORD);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('refuses every password while none is set', async () => {
    const running = await issuer(() => Promise.resolve(undefined));
    running.registerClient('desk', REDIRECT);
    const response = await fetch(
      `${running.url}/authorize`,
      form({ ...authorizeParameters('desk', pkce().challenge), email: OWNER, password: 'x' }),
    );
    expect(response.status).toBe(401);
  });

  it('remembers the person in its session cookie, unless prompt=login', async () => {
    const running = await issuer();
    running.registerClient('desk', REDIRECT);
    const { challenge } = pkce();
    const { cookie } = await signIn(running, 'desk', challenge);
    expect(cookie.startsWith(`${DEV_ISSUER_SESSION_COOKIE}=`)).toBe(true);
    const query = new URLSearchParams(authorizeParameters('desk', challenge)).toString();
    const silent = await fetch(`${running.url}/authorize?${query}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(silent.status).toBe(302);
    expect(new URL(silent.headers.get('location') ?? '').searchParams.get('code')).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
    const forced = new URLSearchParams(
      authorizeParameters('desk', challenge, { prompt: 'login' }),
    ).toString();
    const again = await fetch(`${running.url}/authorize?${forced}`, { headers: { cookie } });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('<form method="post" action="/authorize">');
  });

  it('shows an accessible form in English and Japanese, with the DI6 headers', async () => {
    const running = await issuer();
    running.registerClient('desk', REDIRECT);
    const query = new URLSearchParams(authorizeParameters('desk', pkce().challenge)).toString();
    const english = await fetch(`${running.url}/authorize?${query}`);
    expect(english.status).toBe(200);
    expect(english.headers.get('cache-control')).toBe('no-store');
    expect(english.headers.get('x-frame-options')).toBe('DENY');
    expect(english.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:3399; frame-ancestors 'none'",
    );
    const html = await english.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<label for="email">Email</label>');
    expect(html).toContain('<label for="password">Local console password</label>');
    expect(html).toContain(`value="${OWNER}"`);
    const japanese = await fetch(`${running.url}/authorize?${query}`, {
      headers: { 'accept-language': 'ja-JP,ja;q=0.9,en;q=0.5' },
    });
    const ja = await japanese.text();
    expect(ja).toContain('<html lang="ja">');
    expect(ja).toContain('<label for="email">メールアドレス</label>');
    expect(formLocale('en-GB,ja;q=0.8')).toBe('en');
    expect(formLocale('ja;q=0, en')).toBe('en');
    expect(formLocale(undefined)).toBe('en');
  });

  it('refuses with dev_issuer_port_unavailable when every port it tries is taken', async () => {
    const { webPort, holders } = await holdIssuerRange();
    try {
      await expect(
        startDevIssuer({
          webPort,
          defaultEmail: OWNER,
          readPassword: () => Promise.resolve(PASSWORD),
        }),
      ).rejects.toThrow(/^dev_issuer_port_unavailable/u);
    } finally {
      await closeAll(holders);
    }
  });
});
