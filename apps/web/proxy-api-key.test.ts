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

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { API_ROUTES } from '@indx-workspace/contracts/routes';
import { proxy } from './proxy';
import { isAgentEndpointRoute } from './server/auth/agent-endpoint-routes';
import { acceptsApiKey, isApiKeyRoute, matchApiRoute } from './server/auth/api-key-routes';
import {
  PASSED_THROUGH,
  SAMPLE_ID,
  apiRequest,
  concretePath,
  keyRequest,
  passesWithoutAKey,
  useSessionSecret,
} from './proxy.test-support';

describe('the paths apps/web/proxy.ts admits on a bearer API key', () => {
  // A configured secret, so the denials below are the session check refusing a missing cookie and
  // not `server_not_configured` — which would pass the same assertion for the wrong reason.
  useSessionSecret();

  it('derives from a catalogue that declares both kinds of route', () => {
    expect(API_ROUTES.filter(acceptsApiKey).length).toBeGreaterThan(0);
    expect(API_ROUTES.filter((route) => !acceptsApiKey(route)).length).toBeGreaterThan(0);
  });

  it('passes every route the contracts declare API-key accessible through, by its own method', async () => {
    for (const route of API_ROUTES.filter(acceptsApiKey)) {
      const pathname = concretePath(route.path);
      const label = `${route.method} ${route.path}`;
      expect(isApiKeyRoute(route.method, pathname), label).toBe(true);
      const response = await proxy(keyRequest(route.method, pathname));
      expect(response.headers.get(PASSED_THROUGH), label).toBe('1');
      expect(response.status, label).toBe(200);
    }
  });

  it('admits a key on no route whose contracts name another credential', async () => {
    for (const route of API_ROUTES.filter((candidate) => !acceptsApiKey(candidate))) {
      const pathname = concretePath(route.path);
      const label = `${route.method} ${route.path} (${String(route.security)})`;
      expect(isApiKeyRoute(route.method, pathname), label).toBe(false);
      if (passesWithoutAKey(route)) continue;
      const response = await proxy(keyRequest(route.method, pathname));
      expect(response.status, label).toBe(401);
      expect(response.headers.get(PASSED_THROUGH), label).toBeNull();
    }
  });

  it('admits a key on no path outside the catalogue, and answers it 404', async () => {
    for (const [method, pathname] of [
      ['GET', '/api/users/42'],
      ['GET', `/api/agents/${SAMPLE_ID}/unknown`],
      ['GET', '/api/not-a-route'],
      ['GET', `/api/agents/${SAMPLE_ID}/runs/extra`],
    ] as const) {
      const label = `${method} ${pathname}`;
      expect(isApiKeyRoute(method, pathname), label).toBe(false);
      expect(matchApiRoute(method, pathname), label).toEqual({ kind: 'unknown' });
      const response = await proxy(keyRequest(method, pathname));
      // Issue #416: no route serves these, so a key is told so rather than sent to sign in.
      expect(response.status, label).toBe(404);
      expect(response.headers.get(PASSED_THROUGH), label).toBeNull();
    }
  });

  // Issue #416: `aw runs start ""` built `/api/agents//runs`, which answered a valid key `401`.
  it('answers a key 404 not_found on an unknown or malformed API path', async () => {
    for (const [method, pathname] of [
      ['POST', '/api/agents//runs'],
      ['GET', '/api/agentz'],
      ['GET', '/api'],
    ] as const) {
      const label = `${method} ${pathname}`;
      const response = await proxy(keyRequest(method, pathname));
      expect(response.status, label).toBe(404);
      expect(response.headers.get('cache-control'), label).toBe('no-store');
      expect(response.headers.get('allow'), label).toBeNull();
      await expect(response.json(), label).resolves.toEqual({
        error: {
          code: 'not_found',
          message: 'No API route matches this path.',
          details: ['unknown_route'],
        },
      });
    }
  });

  // PR #418 review: a served path under a method it does not take is 405 with `Allow`, not 404.
  it('answers a key 405 method_not_allowed with Allow on a served path under the wrong method', async () => {
    for (const [method, pathname, catalogPath] of [
      ['PUT', '/api/agents', '/api/agents'],
      ['DELETE', `/api/runs/${SAMPLE_ID}`, '/api/runs/:id'],
      // Where `/api/agents//runs` lands after Next's slash-collapsing redirect: an agent id `runs`.
      ['POST', '/api/agents/runs', '/api/agents/:id'],
    ] as const) {
      const label = `${method} ${pathname}`;
      const served = new Set(
        API_ROUTES.filter((route) => route.path === catalogPath).map((route) => route.method),
      );
      expect(served.has(method), label).toBe(false);
      if (served.has('GET')) served.add('HEAD' as never);
      const allow = [...served].sort().join(', ');

      const response = await proxy(keyRequest(method, pathname));
      expect(response.status, label).toBe(405);
      expect(response.headers.get('allow'), label).toBe(allow);
      expect(response.headers.get(PASSED_THROUGH), label).toBeNull();
      await expect(response.json(), label).resolves.toEqual({
        error: {
          code: 'method_not_allowed',
          message: `This path does not accept ${method}.`,
          details: ['method_not_allowed'],
        },
      });
    }
  });

  // PR #418 review: `curl -I` with a valid key is a HEAD, which Next answers from the GET handler.
  it('admits a key on HEAD wherever it is admitted on GET', async () => {
    for (const pathname of ['/api/agents', `/api/runs/${SAMPLE_ID}`, '/api/me']) {
      expect(isApiKeyRoute('HEAD', pathname), pathname).toBe(true);
      const response = await proxy(keyRequest('HEAD', pathname));
      expect(response.headers.get(PASSED_THROUGH), pathname).toBe('1');
    }
    expect(isApiKeyRoute('HEAD', '/api/not-a-route')).toBe(false);
  });

  it('keeps the 401 on an unknown API path for a caller with no API key, so it learns nothing', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer sk_live_00000000000000000000000000000000' },
      { authorization: 'Bearer awt_live_00000000000000000000000000000000' },
    ]) {
      for (const [method, pathname] of [
        ['GET', '/api/not-a-route'],
        ['PUT', '/api/agents'],
      ] as const) {
        const response = await proxy(
          new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method, headers }),
        );
        expect(response.status, `${method} ${pathname} ${JSON.stringify(headers)}`).toBe(401);
      }
    }
  });

  it('reads every served route as served, including the excluded sign-in and runner routes', () => {
    // The tool endpoint is catalogued but lives outside `/api/`, which `matchApiRoute` covers; the
    // proxy routes it as an agent endpoint instead. Nothing else may sit outside `/api/` silently.
    expect(
      API_ROUTES.filter((entry) => !entry.path.startsWith('/api/')).map(
        (entry) => `${entry.method} ${entry.path}`,
      ),
    ).toEqual(['POST /mcp/projects/:name', 'POST /mcp/builder']);
    expect(isAgentEndpointRoute('POST', '/mcp/projects/x')).toBe(true);
    expect(isAgentEndpointRoute('POST', '/mcp/builder')).toBe(true);
    for (const route of API_ROUTES.filter((entry) => entry.path.startsWith('/api/'))) {
      expect(matchApiRoute(route.method, concretePath(route.path)), route.path).toEqual({
        kind: 'served',
      });
    }
    expect(matchApiRoute('GET', '/api/auth/login').kind).toBe('served');
    expect(matchApiRoute('POST', '/api/setup').kind).toBe('served');
    expect(matchApiRoute('HEAD', '/api/agents').kind).toBe('served');
    expect(matchApiRoute('POST', `/api/sessions/${SAMPLE_ID}/transcript`).kind).toBe('served');
  });

  it('passes the quickstart routes through: agents, runs, projects, engines, models, me and tokens', async () => {
    for (const [method, pathname] of [
      ['GET', '/api/me'],
      ['GET', '/api/agents'],
      ['POST', `/api/agents/${SAMPLE_ID}/runs`],
      ['GET', '/api/runs'],
      ['GET', `/api/runs/${SAMPLE_ID}`],
      ['GET', `/api/runs/${SAMPLE_ID}/events`],
      ['GET', '/api/projects'],
      ['GET', '/api/engines'],
      ['GET', '/api/models'],
      ['POST', '/api/tokens'],
    ] as const) {
      const response = await proxy(keyRequest(method, pathname));
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBe('1');
    }
  });

  it('denies /api/me when no credential is presented at all', async () => {
    const response = await proxy(apiRequest('/api/me'));

    expect(response.status).toBe(401);
    expect(response.headers.get(PASSED_THROUGH)).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'unauthenticated',
        message: 'Sign in, or present a valid API key, to use this API.',
        details: ['no_session_cookie'],
      },
    });
  });

  it('keeps a key-accessible route behind the session gate when the bearer is not an API key', async () => {
    const response = await proxy(
      apiRequest('/api/agents', {
        authorization: 'Bearer sk_live_00000000000000000000000000000000',
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get(PASSED_THROUGH)).toBeNull();
  });
});
