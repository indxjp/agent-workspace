/**
 * The framework contract that decides the form of `apps/web/proxy.ts`'s one redirect — issue #201.
 *
 * The other three enumerated sites (`app/api/auth/callback/route.ts`) are App Router route
 * handlers: the `Response` they return is what the client receives, so they simply set a relative
 * `Location` and their own tests assert it. A proxy response is not that. It is post-processed by
 * `next/dist/server/web/adapter.js` before it is sent, and the two assertions below are the halves
 * of that post-processing this repository depends on:
 *
 *   1. a relative `Location` set by the proxy **throws** inside `NextURL`, so it is not an
 *      available shape at that site — the "smallest fix" prescribed for the other three would be a
 *      500 on every unauthenticated page visit; and
 *   2. an absolute same-origin `Location` set by the proxy is **rewritten by Next itself** to the
 *      relative form, which is why the wire header is already correct today.
 *
 * These are `next@16.3.4` internals, pinned deliberately: a version bump that changes either half
 * fails here rather than in a user's session. The behaviour they explain is asserted end to end,
 * over HTTP against a real `next dev`, in `tests/auth.test.ts` — this file says *why* the code in
 * `proxy.ts` looks the way it does, that one says what a browser actually receives.
 *
 * See `docs/adr/W9-R9b-relative-location-closes-the-class-and-the-proxy-site-is-owned-by-next.md`.
 *
 * The second suite below is about a different property of the same file: which paths the gate
 * admits on a bearer API key. It drives `proxy()` itself rather than a Next internal.
 */
import { CONTRACTS_VERSION, CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';
import { API_KEY_HEADER, PASSED_THROUGH, SAMPLE_ID, useSessionSecret } from './proxy.test-support';

describe('the two paths apps/web/proxy.ts admits for a published agent over A2A (ADR-0135)', () => {
  const RPC = '/api/a2a/agents/support-bot';
  const CARD = '/api/a2a/agents/support-bot/.well-known/agent-card.json';
  const send = (method: string, pathname: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method, headers }));

  it('passes both through with no credential, so the handler can answer 401 itself', async () => {
    expect((await send('POST', RPC)).headers.get(PASSED_THROUGH)).toBe('1');
    expect((await send('GET', CARD)).headers.get(PASSED_THROUGH)).toBe('1');
  });

  it('passes both through with a workspace API key, which is not an ordinary key route', async () => {
    expect(
      (await send('POST', RPC, { authorization: API_KEY_HEADER })).headers.get(PASSED_THROUGH),
    ).toBe('1');
    expect(
      (await send('GET', CARD, { authorization: API_KEY_HEADER })).headers.get(PASSED_THROUGH),
    ).toBe('1');
  });

  it('serves a client that sends no contracts-version header, which no A2A client does', async () => {
    const response = await send('POST', RPC, { authorization: API_KEY_HEADER });
    expect(response.status).toBe(200);
  });

  it('passes nothing next to them, and no other method on them', async () => {
    for (const [method, pathname] of [
      ['POST', `${RPC}/other`],
      ['GET', RPC],
      ['POST', CARD],
      ['GET', '/api/a2a/agents'],
      ['GET', '/api/a2a'],
    ] as const) {
      const response = await send(method, pathname, { authorization: API_KEY_HEADER });
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });
});

describe('the path apps/web/proxy.ts admits for a project tool endpoint (ADR-0134)', () => {
  const MCP = '/mcp/projects/support';
  const send = (method: string, pathname: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method, headers }));

  it('passes a POST through with or without a credential, so the handler answers 401 itself', async () => {
    expect((await send('POST', MCP)).headers.get(PASSED_THROUGH)).toBe('1');
    expect(
      (await send('POST', MCP, { authorization: API_KEY_HEADER })).headers.get(PASSED_THROUGH),
    ).toBe('1');
  });

  it('passes nothing next to it, and no other method on it', async () => {
    for (const [method, pathname] of [
      ['GET', MCP],
      ['POST', `${MCP}/extra`],
      ['POST', '/mcp/projects'],
      ['POST', '/mcp/projectsx'],
    ] as const) {
      const response = await send(method, pathname, { authorization: API_KEY_HEADER });
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });
});

describe('the path apps/web/proxy.ts admits for the Builder door (#1846 slice 5b)', () => {
  const send = (method: string, pathname: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method, headers }));

  it('passes a POST through with or without a credential, so the handler answers 401 itself', async () => {
    expect((await send('POST', '/mcp/builder')).headers.get(PASSED_THROUGH)).toBe('1');
    expect(
      (await send('POST', '/mcp/builder', { authorization: API_KEY_HEADER })).headers.get(
        PASSED_THROUGH,
      ),
    ).toBe('1');
  });

  it('passes nothing next to it, and no other method on it', async () => {
    for (const [method, pathname] of [
      ['GET', '/mcp/builder'],
      ['POST', '/mcp/builder/extra'],
      ['POST', '/mcp/builders'],
    ] as const) {
      const response = await send(method, pathname, { authorization: API_KEY_HEADER });
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });
});

describe('the paths apps/web/proxy.ts admits for the OAuth server (ADR-0134 part 3)', () => {
  const send = (method: string, pathname: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method, headers }));

  it('passes the eight routes through with no cookie and no credential', async () => {
    for (const [method, pathname] of [
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/.well-known/oauth-protected-resource/mcp/projects/support'],
      ['GET', '/.well-known/oauth-protected-resource/mcp/builder'],
      ['GET', '/.well-known/oauth-protected-resource/api/a2a/agents/support-bot'],
      ['GET', '/oauth/authorize'],
      ['POST', '/oauth/authorize'],
      ['POST', '/oauth/token'],
      ['POST', '/oauth/revoke'],
    ] as const) {
      expect(
        (await send(method, pathname)).headers.get(PASSED_THROUGH),
        `${method} ${pathname}`,
      ).toBe('1');
    }
  });

  it('passes nothing next to them, and no other method on them', async () => {
    for (const [method, pathname] of [
      ['GET', '/oauth/token'],
      ['PUT', '/oauth/revoke'],
      ['POST', '/oauth/token/extra'],
      ['GET', '/oauth/clients'],
      ['GET', '/.well-known/oauth-protected-resource/mcp/projects/a/b'],
      ['GET', '/.well-known/oauth-protected-resource/api/runs/x'],
    ] as const) {
      const response = await send(method, pathname, { authorization: API_KEY_HEADER });
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });
});

// ADR-0161 D3 and D9.
describe('the paths apps/web/proxy.ts admits for the ID-token exchange and its access token', () => {
  const ACCESS_TOKEN_HEADER = `Bearer awo_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
  useSessionSecret();
  const send = (method: string, pathname: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method, headers }));

  it('passes the exchange through with no session, and only its POST', async () => {
    const response = await send('POST', '/api/auth/token-exchange');
    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
    const other = await send('GET', '/api/auth/token-exchange');
    expect(other.headers.get(PASSED_THROUGH)).toBeNull();
  });

  it('admits an awo_live_ bearer on exactly the app-backend routes', async () => {
    for (const [method, pathname] of [
      ['POST', `/api/agents/${SAMPLE_ID}/runs`],
      ['GET', `/api/runs/${SAMPLE_ID}`],
      ['GET', `/api/runs/${SAMPLE_ID}/events`],
      ['POST', `/api/runs/${SAMPLE_ID}/interrupt`],
      ['POST', `/api/runs/${SAMPLE_ID}/approval`],
      ['GET', '/api/runs'],
      ['GET', '/api/me'],
    ] as const) {
      const response = await send(method, pathname, { authorization: ACCESS_TOKEN_HEADER });
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBe('1');
    }
  });

  it('keeps every other route behind the session gate for an awo_live_ bearer', async () => {
    for (const [method, pathname] of [
      ['GET', '/api/workspaces'],
      ['POST', '/api/files'],
      ['POST', '/api/runs'],
      ['POST', `/api/runs/${SAMPLE_ID}/feedback`],
      ['GET', `/api/agents/${SAMPLE_ID}`],
      ['POST', '/api/endpoint-clients'],
    ] as const) {
      const response = await send(method, pathname, { authorization: ACCESS_TOKEN_HEADER });
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
      expect(response.status, `${method} ${pathname}`).toBe(401);
    }
  });
});

// Issue #242 (SDK-10, S-22; ADR-0083).
describe('the paths apps/web/proxy.ts admits for `aw login` and its user token', () => {
  const USER_TOKEN_HEADER = `Bearer awu_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
  const send = (method: string, pathname: string, headers: Record<string, string> = {}) =>
    proxy(
      new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), {
        method,
        headers,
      }),
    );

  it('passes the three pre-authentication steps through with no credential', async () => {
    for (const [method, pathname] of [
      ['POST', '/api/auth/cli-device'],
      ['GET', '/api/auth/cli-verify'],
      ['POST', '/api/auth/cli-token'],
    ] as const) {
      const response = await send(method, pathname);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBe('1');
    }
  });

  it('admits the sign-in steps and the user token with the contracts version header (ADR-0078)', async () => {
    const stated = { [CONTRACTS_VERSION_HEADER]: CONTRACTS_VERSION };
    for (const [method, pathname, headers] of [
      ['POST', '/api/auth/cli-device', stated],
      ['POST', '/api/auth/cli-token', stated],
      ['DELETE', '/api/auth/cli-token', { ...stated, authorization: USER_TOKEN_HEADER }],
      ['POST', '/api/auth/cli-workspace', { ...stated, authorization: USER_TOKEN_HEADER }],
      ['GET', '/api/workspaces', { ...stated, authorization: USER_TOKEN_HEADER }],
    ] as const) {
      const response = await send(method, pathname, headers);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBe('1');
    }
    const unserved = await send('POST', '/api/auth/cli-device', {
      [CONTRACTS_VERSION_HEADER]: '999.0.0',
    });
    expect(unserved.status).toBe(426);
  });

  it('keeps the approval behind the session gate', async () => {
    const response = await send('POST', '/api/auth/cli-verify');
    expect(response.status).toBe(401);
    expect(response.headers.get(PASSED_THROUGH)).toBeNull();
  });

  it('passes a user token only to the person-facing routes', async () => {
    for (const pathname of [
      '/api/me',
      '/api/workspaces',
      '/api/workspaces/w-1/features',
      '/api/invitations/i-1/resend',
    ]) {
      const response = await send('GET', pathname, { authorization: USER_TOKEN_HEADER });
      expect(response.headers.get(PASSED_THROUGH), pathname).toBe('1');
    }
    for (const pathname of [
      '/api/agents',
      '/api/api-keys',
      '/api/workspaces-x',
      '/api/users',
      '/api/memberships',
      '/api/tokens',
      '/api/secrets',
      '/api/runs/run-1',
      // Review round 1: the edge passes any other bearer here, for the runner's run token.
      '/api/sessions',
      '/api/sessions/s-1/transcript',
      '/api/sessions/s-1/state-entries',
    ]) {
      const response = await send('GET', pathname, { authorization: USER_TOKEN_HEADER });
      expect(response.status, pathname).toBe(401);
    }
  });
});
