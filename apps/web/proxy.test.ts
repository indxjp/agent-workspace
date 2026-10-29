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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { NextRequest } from 'next/server';
import { NextURL } from 'next/dist/server/web/next-url';
import { getRelativeURL } from 'next/dist/shared/lib/router/utils/relativize-url';

import { API_ROUTES, type ApiRoute } from '@indx-workspace/contracts/routes';

import { POST as postRunFeedback } from './app/api/runs/[id]/feedback/route';
import { proxy } from './proxy';
import { InMemoryRunStore } from './server/runs/memory-store';
import { isAgentEndpointRoute } from './server/auth/agent-endpoint-routes';
import { acceptsApiKey, isApiKeyRoute, matchApiRoute } from './server/auth/api-key-routes';
import { MIN_SESSION_SECRET_LENGTH } from './server/auth/session';
import {
  installTestDomains,
  installTestRunApi,
  resetTestRunApi,
} from './server/application-context-fixtures';
import { clearApplicationContext } from './server/application-context';

// The exact argument shape `adapter.js` uses when it re-reads a proxy response's `Location`.
const ADAPTER_OPTIONS = { forceLocale: false, headers: {}, nextConfig: {} } as const;

describe('the Location contract apps/web/proxy.ts is written against', () => {
  it('refuses a relative Location: NextURL reads its second argument as options, never as a base', () => {
    // `{ forceLocale, headers, nextConfig }` has no `pathname` key and is not a string, so
    // `next-url.js` takes the options branch, leaves `base` undefined, and evaluates
    // `new URL('/signin', undefined)`. There is no flag that avoids this — the call sits above the
    // `__NEXT_NO_MIDDLEWARE_URL_NORMALIZE` guard.
    expect(() => new NextURL('/signin', ADAPTER_OPTIONS)).toThrow(TypeError);

    // The same input with a base is fine, which is the proof that the throw is about the missing
    // origin and not about `/signin`.
    expect(new NextURL('/signin', 'http://127.0.0.1:3000', ADAPTER_OPTIONS).pathname).toBe(
      '/signin',
    );
  });

  it('strips the origin from a same-origin absolute Location, which is why the wire header is relative', () => {
    // `proxy.ts` builds its target with `new URL('/signin', request.url)`, and the adapter builds
    // the URL it compares against from that same `request.url`, so the hosts match by construction
    // and this branch always fires.
    const requestURL = new NextURL('http://127.0.0.1:3000/', ADAPTER_OPTIONS);
    const redirectURL = new NextURL(
      new URL('/signin', 'http://127.0.0.1:3000/').toString(),
      ADAPTER_OPTIONS,
    );
    expect(redirectURL.host).toBe(requestURL.host);
    expect(getRelativeURL(redirectURL, requestURL)).toBe('/signin');
    expect(getRelativeURL(redirectURL, requestURL)).not.toContain('://');

    // And the negative control: a cross-origin target is left absolute, so the rewrite above is a
    // same-origin relativisation and not a blanket "drop the host".
    const elsewhere = new NextURL('https://elsewhere.test/signin', ADAPTER_OPTIONS);
    expect(getRelativeURL(elsewhere, requestURL)).toBe('https://elsewhere.test/signin');
  });
});

/**
 * The bearer-API-key admission — the gate that decides whether a key-only caller ever reaches a
 * route handler at all.
 *
 * A route's own tests import its `GET` and call it with a `Request`, which does not cross this
 * file; so a route that is complete on the server side and refused here answers `401` in every
 * deployment and `200` in every unit test. That happened twice: to `/api/me` (issue #233), and to
 * `/api/agents`, `/api/runs`, `/api/projects`, `/api/engines` and `/api/models` (issue #388) while
 * a hand-kept five-prefix list stood in for the contracts. The admission is now derived from the
 * contracts' route catalogue (`server/auth/api-key-routes.ts`), and these cases assert it against
 * that catalogue route by route, so the two cannot drift: every route whose `security` is the
 * default passes a key through, and every route that names another credential does not.
 *
 * `NextResponse.next()` carries `x-middleware-next: 1`; that header, and only it, is what
 * "passed through to the route" means on the wire.
 */
const PASSED_THROUGH = 'x-middleware-next';
const API_KEY_HEADER = 'Bearer ak_live_00000000000000000000000000000000';
const SAMPLE_ID = '11111111-1111-4111-8111-111111111111';

function apiRequest(pathname: string, headers: Readonly<Record<string, string>> = {}): NextRequest {
  return new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { headers });
}

function keyRequest(method: string, pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), {
    method,
    headers: { authorization: API_KEY_HEADER },
  });
}

/** A concrete path for a catalogue path: every `:param` becomes a UUID-shaped segment. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z]+/gu, SAMPLE_ID);
}

/**
 * Catalogue routes the proxy passes through for a reason other than an API key — sign-in, the
 * invitation acceptance, a trigger's fire URL, setup detection and the runner's per-run token on
 * `/api/sessions/**` — so
 * a refusal of the key on them cannot be observed through `proxy()`; the derived matcher is
 * asserted for them instead.
 */
function passesWithoutAKey(route: ApiRoute): boolean {
  return (
    route.path.startsWith('/api/sessions/') ||
    route.path.startsWith('/api/setup/') ||
    route.security === 'endpoint-credential' ||
    route.path === '/api/invitations/:id/accept' ||
    route.path === '/api/triggers/:id/fire/:secret' ||
    route.path === '/api/auth/cli-device' ||
    (route.method === 'POST' && route.path === '/api/auth/cli-token') ||
    (route.method === 'POST' && route.path === '/api/auth/workspace')
  );
}

describe('the paths apps/web/proxy.ts admits on a bearer API key', () => {
  // A configured secret, so the denials below are the session check refusing a missing cookie and
  // not `server_not_configured` — which would pass the same assertion for the wrong reason.
  const previousSecret = process.env['SESSION_SECRET'];
  beforeAll(() => {
    process.env['SESSION_SECRET'] = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
    else process.env['SESSION_SECRET'] = previousSecret;
  });

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

/**
 * The bearer-browser-token allowlist (issue #236, SDK-04, S-1) — a credential-shape exemption
 * only. `decide()`'s scope grammar (`apps/web/server/rbac/decide.ts`) is what actually refuses a
 * token whose scope does not reach the row a matched path names; this pins that the proxy's own
 * match is exactly the route shapes §3.1's grammar admits; the routes still verify the bearer
 * themselves. `POST` is asserted for the run-starting shape because that is the only method §3.1
 * grants a session scope over `agents`.
 */
const BROWSER_TOKEN_HEADER = 'Bearer awt_live_00000000000000000000000000000000';

describe('the paths apps/web/proxy.ts admits on a bearer browser token', () => {
  const previousSecret = process.env['SESSION_SECRET'];
  beforeAll(() => {
    process.env['SESSION_SECRET'] = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
    else process.env['SESSION_SECRET'] = previousSecret;
  });

  it('passes a run read and its events through', async () => {
    for (const pathname of ['/api/runs/run-1', '/api/runs/run-1/events']) {
      const response = await proxy(apiRequest(pathname, { authorization: BROWSER_TOKEN_HEADER }));
      expect(response.headers.get(PASSED_THROUGH), pathname).toBe('1');
    }
  });

  it('passes case-insensitive bearer schemes accepted by the browser-token parser', async () => {
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const response = await proxy(
        apiRequest('/api/runs/run-1', {
          authorization: `${scheme} awt_live_00000000000000000000000000000000`,
        }),
      );
      expect(response.headers.get(PASSED_THROUGH), scheme).toBe('1');
    }
  });

  it('keeps the browser-token prefix case-sensitive', async () => {
    const response = await proxy(
      apiRequest('/api/runs/run-1', {
        authorization: 'bearer AWT_LIVE_00000000000000000000000000000000',
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get(PASSED_THROUGH)).toBeNull();
  });

  it('passes a POST that starts a run through', async () => {
    const response = await proxy(
      new NextRequest(new URL('/api/agents/agent-1/runs', 'http://127.0.0.1:3000'), {
        method: 'POST',
        headers: { authorization: BROWSER_TOKEN_HEADER },
      }),
    );
    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
  });

  it('denies the run collection list and every other shape, so the match stays exact', async () => {
    for (const request of [
      apiRequest('/api/runs', { authorization: BROWSER_TOKEN_HEADER }),
      apiRequest('/api/agents', { authorization: BROWSER_TOKEN_HEADER }),
      apiRequest('/api/me', { authorization: BROWSER_TOKEN_HEADER }),
      new NextRequest(new URL('/api/agents/agent-1/runs', 'http://127.0.0.1:3000'), {
        method: 'GET',
        headers: { authorization: BROWSER_TOKEN_HEADER },
      }),
    ]) {
      const response = await proxy(request);
      expect(response.status).toBe(401);
      expect(response.headers.get(PASSED_THROUGH)).toBeNull();
    }
  });

  /**
   * The two run sub-routes §3.1's grammar does NOT admit. A prefix match on `/api/runs/` let both
   * past the edge on a browser token; they are writes, and the edge gate must not be wider than
   * the comment above `isBrowserTokenExemptRoute` claims it is.
   */
  it('denies the run writes outside the grammar — interrupt and revoke-tokens', async () => {
    for (const pathname of ['/api/runs/run-1/interrupt', '/api/runs/run-1/revoke-tokens']) {
      const response = await proxy(
        new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), {
          method: 'POST',
          headers: { authorization: BROWSER_TOKEN_HEADER },
        }),
      );
      expect(response.status, pathname).toBe(401);
      expect(response.headers.get(PASSED_THROUGH), pathname).toBeNull();
    }
  });

  // Issue #539 (S2-05c): the third shape, rating a run — exactly POST /api/runs/:id/feedback.
  it('passes a POST that rates a run through, and nothing next to it', async () => {
    const send = (method: string, pathname: string) =>
      proxy(
        new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), {
          method,
          headers: { authorization: BROWSER_TOKEN_HEADER },
        }),
      );
    const rated = await send('POST', '/api/runs/run-1/feedback');
    expect(rated.headers.get(PASSED_THROUGH)).toBe('1');
    for (const [method, pathname] of [
      ['GET', '/api/runs/run-1/feedback'],
      ['POST', '/api/runs/run-1/feedback/x'],
      ['POST', '/api/runs/run-1/cancel'],
      ['POST', '/api/runs/run-1/interrupt'],
    ] as const) {
      const response = await send(method, pathname);
      expect(response.status, `${method} ${pathname}`).toBe(401);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });

  // Issue #251 (N-4): the two presign shapes, exactly POST /api/files/:id/{upload,download}-urls.
  it('passes the two presign POSTs through, and nothing next to them', async () => {
    const send = (method: string, pathname: string) =>
      proxy(
        new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), {
          method,
          headers: { authorization: BROWSER_TOKEN_HEADER },
        }),
      );
    for (const pathname of ['/api/files/ZmlsZQ/upload-urls', '/api/files/ZmlsZQ/download-urls']) {
      const minted = await send('POST', pathname);
      expect(minted.headers.get(PASSED_THROUGH), pathname).toBe('1');
    }
    for (const [method, pathname] of [
      ['GET', '/api/files/ZmlsZQ/upload-urls'],
      ['POST', '/api/files/ZmlsZQ/upload-urls/x'],
      ['POST', '/api/files/ZmlsZQ/upload-complete'],
      ['POST', '/api/files/ZmlsZQ'],
      ['POST', '/api/files'],
      ['GET', '/api/files/ZmlsZQ'],
      ['POST', '/api/files/ZmlsZQ/upload'],
    ] as const) {
      const response = await send(method, pathname);
      expect(response.status, `${method} ${pathname}`).toBe(401);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });

  it('end to end: a session token rates its own run through proxy() and the route (204)', async () => {
    const store = new InMemoryRunStore();
    const sessionId = crypto.randomUUID();
    const run = await store.create({
      engine: 'claude-agent-sdk',
      id: crypto.randomUUID(),
      workspaceId: SAMPLE_ID,
      agentId: crypto.randomUUID(),
      sessionId,
      initiatingUserId: null,
      ownerPrincipalId: SAMPLE_ID,
    });
    const recorded: string[] = [];
    installTestRunApi({
      authenticate: () =>
        Promise.resolve({
          principalId: SAMPLE_ID,
          ownerPrincipalId: SAMPLE_ID,
          userId: null,
          workspaceId: SAMPLE_ID,
          role: 'owner',
          scope: { kind: 'session', id: sessionId },
        }),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: () => undefined,
      recordRunFeedback: (_principal, rated, feedback) => {
        recorded.push(`${rated.id} ${feedback.rating}`);
        return Promise.resolve();
      },
    });
    try {
      const request = new NextRequest(
        new URL(`/api/runs/${run.id}/feedback`, 'http://127.0.0.1:3000'),
        {
          method: 'POST',
          headers: { authorization: BROWSER_TOKEN_HEADER, 'content-type': 'application/json' },
          body: JSON.stringify({ rating: 'up' }),
        },
      );
      const edge = await proxy(request);
      expect(edge.headers.get(PASSED_THROUGH)).toBe('1');
      const response = await postRunFeedback(request, { params: Promise.resolve({ id: run.id }) });
      expect(response.status).toBe(204);
      expect(recorded).toEqual([`${run.id} up`]);
    } finally {
      resetTestRunApi();
    }
  });

  it('denies a non-GET method on the run read shapes the grammar reads', async () => {
    for (const method of ['POST', 'DELETE']) {
      const response = await proxy(
        new NextRequest(new URL('/api/runs/run-1', 'http://127.0.0.1:3000'), {
          method,
          headers: { authorization: BROWSER_TOKEN_HEADER },
        }),
      );
      expect(response.status, method).toBe(401);
      expect(response.headers.get(PASSED_THROUGH), method).toBeNull();
    }
  });
});

describe('the three paths apps/web/proxy.ts admits for Vercel Cron (ADR-0120 clause 7, ADR-0144 D5, #1674)', () => {
  const send = (method: string, pathname: string) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method }));

  it('passes GET /api/cron/retention through with no session; the route checks CRON_SECRET', async () => {
    const response = await send('GET', '/api/cron/retention');
    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
  });

  it('passes GET /api/cron/triggers through with no session; the route checks CRON_SECRET', async () => {
    const response = await send('GET', '/api/cron/triggers');
    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
  });

  it('passes GET /api/cron/storage-cleanup through with no session; the route checks CRON_SECRET', async () => {
    const response = await send('GET', '/api/cron/storage-cleanup');
    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
  });

  it('passes it through with the bearer Vercel Cron actually sends', async () => {
    const response = await proxy(
      new NextRequest(new URL('/api/cron/retention', 'http://127.0.0.1:3000'), {
        method: 'GET',
        headers: { authorization: `Bearer ${'e'.repeat(64)}` },
      }),
    );
    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
  });

  it('keeps every other method and neighbouring path behind the session gate', async () => {
    for (const [method, pathname] of [
      ['POST', '/api/cron/retention'],
      ['DELETE', '/api/cron/retention'],
      ['GET', '/api/cron/retention/extra'],
      ['POST', '/api/cron/triggers'],
      ['DELETE', '/api/cron/triggers'],
      ['GET', '/api/cron/triggers/extra'],
      ['POST', '/api/cron/storage-cleanup'],
      ['GET', '/api/cron/storage-cleanup/extra'],
      ['GET', '/api/cron'],
    ] as const) {
      const response = await send(method, pathname);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });
});

describe('the readiness probe apps/web/proxy.ts admits (issue #1562)', () => {
  const send = (method: string, pathname: string) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method }));

  it('passes GET /api/readyz through with no session, as a kubelet probe sends it', async () => {
    const response = await send('GET', '/api/readyz');
    expect(response.headers.get(PASSED_THROUGH)).toBe('1');
  });

  it('keeps every other method and neighbouring path behind the session gate', async () => {
    for (const [method, pathname] of [
      ['POST', '/api/readyz'],
      ['GET', '/api/readyz/extra'],
      ['GET', '/api/ready'],
    ] as const) {
      const response = await send(method, pathname);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });
});

describe('the pre-authentication paths and the page redirect of apps/web/proxy.ts', () => {
  const previousSecret = process.env['SESSION_SECRET'];
  beforeAll(() => {
    process.env['SESSION_SECRET'] = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
    else process.env['SESSION_SECRET'] = previousSecret;
  });
  const send = (method: string, pathname: string) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method }));

  it('passes setup, the OIDC exchange and invitation acceptance through with no session', async () => {
    for (const [method, pathname] of [
      ['GET', '/api/setup/runtime-detect'],
      ['POST', '/api/setup'],
      ['GET', '/api/auth/login'],
      ['GET', '/api/auth/workspace'],
      ['POST', '/api/auth/callback'],
      ['POST', '/api/auth/workspace'],
      ['POST', `/api/invitations/${SAMPLE_ID}/accept`],
    ] as const) {
      const response = await send(method, pathname);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBe('1');
    }
  });

  it('keeps every other method and neighbouring path behind the session gate', async () => {
    for (const [method, pathname] of [
      ['POST', '/api/setup/runtime-detect'],
      ['GET', '/api/setup'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/auth/callback'],
      ['GET', `/api/invitations/${SAMPLE_ID}/accept`],
      ['POST', `/api/invitations/${SAMPLE_ID}/accept/extra`],
    ] as const) {
      const response = await send(method, pathname);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
      expect(response.status, `${method} ${pathname}`).toBe(401);
    }
  });

  it('redirects a session-less page visit to /signin, and lets the sign-in page itself through', async () => {
    const page = await send('GET', '/agents');
    expect(page.status).toBe(307);
    expect(new URL(String(page.headers.get('location'))).pathname).toBe('/signin');
    const signin = await send('GET', '/signin');
    expect(signin.headers.get(PASSED_THROUGH)).toBe('1');
  });
});

describe('the one path apps/web/proxy.ts admits for a trigger fire (ADR-0144)', () => {
  const FIRE = '/api/triggers/7d0c3f5e-0000-4000-8000-000000000001/fire/awcs_live_x';
  const send = (method: string, pathname: string) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method }));

  it('passes POST through with no session; the route checks the secret in the path', async () => {
    expect((await send('POST', FIRE)).headers.get(PASSED_THROUGH)).toBe('1');
  });

  it('keeps every other method, the management routes and neighbouring paths behind the gate', async () => {
    for (const [method, pathname] of [
      ['GET', FIRE],
      ['PUT', FIRE],
      ['POST', '/api/triggers'],
      ['POST', '/api/triggers/7d0c3f5e-0000-4000-8000-000000000001/secret'],
      ['POST', '/api/triggers/7d0c3f5e-0000-4000-8000-000000000001/fire'],
      ['POST', `${FIRE}/extra`],
    ] as const) {
      const response = await send(method, pathname);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });
});

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

// ADR-0105 slice 1, S1-17 (#455): the hosted surface may be framed by its own origin only.
describe('the frame-ancestors policy apps/web/proxy.ts sets on the hosted surface', () => {
  const previousSecret = process.env['SESSION_SECRET'];
  beforeAll(() => {
    process.env['SESSION_SECRET'] = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
    else process.env['SESSION_SECRET'] = previousSecret;
  });
  const send = (method: string, pathname: string) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method }));

  it("answers the surface page, its session bootstrap and anything below /p/s with frame-ancestors 'self'", async () => {
    for (const [method, pathname] of [
      ['GET', '/p/s/main'],
      ['POST', '/p/s/main/sessions'],
      ['GET', '/p/s/main/widget.js'],
      ['GET', '/p/s'],
    ] as const) {
      const response = await send(method, pathname);
      expect(response.headers.get('content-security-policy'), `${method} ${pathname}`).toBe(
        "frame-ancestors 'self'",
      );
      // Public: passed straight through, never redirected to sign-in, and no CORS.
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBe('1');
      expect(response.headers.get('location'), `${method} ${pathname}`).toBeNull();
      expect(response.headers.get('access-control-allow-origin'), pathname).toBeNull();
    }
  });

  it('leaves a public share, an upper-case look-alike and an authenticated page without it', async () => {
    for (const pathname of ['/p/abc', '/p/sx', '/P/s/main', '/agents']) {
      const response = await send('GET', pathname);
      expect(response.headers.get('content-security-policy'), pathname).toBeNull();
    }
    // The look-alike and the page are not public: the page gate still sends them to sign-in.
    for (const pathname of ['/P/s/main', '/agents']) {
      const response = await send('GET', pathname);
      expect(response.status, pathname).toBe(307);
      expect(new URL(response.headers.get('location') ?? '').pathname, pathname).toBe('/signin');
    }
  });

  it('adds no frame-ancestors policy to an API answer', async () => {
    const response = await send('GET', '/api/me');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  // Issue #622: the page of a surface with allowedOrigins may be framed by them, and its session
  // bootstrap answers their CORS preflight; nothing else under /p/s changes.
  describe('with a surface that lists allowedOrigins', () => {
    const SHOP = 'https://shop.example.com';
    let resolveFails = false;
    beforeAll(() => {
      installTestDomains({
        surfaces: {
          kind: 'serving',
          runtime: {
            resolve: (name) => {
              if (resolveFails) return Promise.reject(new Error('the database is down'));
              return Promise.resolve(
                name === 'main'
                  ? {
                      workspaceId: '33333333-3333-4333-8333-333333333333',
                      agentId: '22222222-2222-4222-8222-222222222222',
                      agentName: 'support',
                      environment: 'local' as const,
                      versionId: '55555555-5555-4555-8555-555555555555',
                      versionNumber: 1,
                      promoted: false,
                      surface: { name: 'main', agent: 'support', allowedOrigins: [SHOP] },
                    }
                  : null,
              );
            },
            open: () => Promise.reject(new Error('the proxy never opens a session')),
            checkModel: () => Promise.reject(new Error('the proxy never checks a model')),
            visitorSurface: () => Promise.resolve(null),
            servedSurfaces: () =>
              Promise.resolve([{ name: 'main', agent: 'support', allowedOrigins: [SHOP] }]),
          },
        },
      });
    });
    afterAll(() => {
      clearApplicationContext();
    });

    it("frames the page from 'self' and the listed origins, and nothing else", async () => {
      const page = await send('GET', '/p/s/main');
      expect(page.headers.get('content-security-policy')).toBe(`frame-ancestors 'self' ${SHOP}`);
      for (const [method, pathname] of [
        ['POST', '/p/s/main/sessions'],
        ['GET', '/p/s/main/widget.js'],
        ['GET', '/p/s/other'],
      ] as const) {
        const response = await send(method, pathname);
        expect(response.headers.get('content-security-policy'), pathname).toBe(
          "frame-ancestors 'self'",
        );
      }
    });

    it("falls back to 'self' when the surface cannot be resolved", async () => {
      resolveFails = true;
      try {
        const page = await send('GET', '/p/s/main');
        expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
      } finally {
        resolveFails = false;
      }
    });

    const preflight = (origin: string, pathname = '/p/s/main/sessions') =>
      proxy(
        new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST' },
        }),
      );

    it('grants the preflight of a listed origin, POST with a JSON body, no credentials', async () => {
      const response = await preflight(SHOP);
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(SHOP);
      expect(response.headers.get('access-control-allow-methods')).toBe('POST');
      expect(response.headers.get('access-control-allow-headers')).toBe('content-type');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('vary')).toContain('origin');
    });

    it('answers any other preflight with no grant', async () => {
      for (const [origin, pathname] of [
        ['https://evil.example', '/p/s/main/sessions'],
        ['null', '/p/s/main/sessions'],
        [SHOP, '/p/s/other/sessions'],
      ] as const) {
        const response = await preflight(origin, pathname);
        expect(response.status, `${origin} ${pathname}`).toBe(204);
        expect(response.headers.get('access-control-allow-origin'), origin).toBeNull();
      }
    });

    // Issue #680: the four run routes a visitor token may call answer CORS to a listed origin.
    const VISITOR_ROUTES = [
      ['GET', '/api/runs/run-1'],
      ['GET', '/api/runs/run-1/events'],
      ['POST', '/api/agents/agent-1/runs'],
      ['POST', '/api/runs/run-1/feedback'],
      ['POST', '/api/files/ZmlsZQ/upload-urls'],
      ['POST', '/api/files/ZmlsZQ/download-urls'],
      ['POST', '/api/sessions/session-1/attachments'],
    ] as const;
    const crossOrigin = (method: string, pathname: string, headers: Record<string, string>) =>
      proxy(
        new NextRequest(new URL(pathname, 'https://aw.example.com'), {
          method,
          headers: { 'sec-fetch-site': 'cross-site', ...headers },
        }),
      );

    it('answers the preflight of each visitor run route for a listed origin, no credentials', async () => {
      for (const [method, pathname] of VISITOR_ROUTES) {
        const response = await crossOrigin('OPTIONS', pathname, {
          origin: SHOP,
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization, x-agent-workspace-contracts',
        });
        expect(response.status, pathname).toBe(204);
        expect(response.headers.get('access-control-allow-origin'), pathname).toBe(SHOP);
        expect(response.headers.get('access-control-allow-methods'), pathname).toBe(method);
        expect(response.headers.get('access-control-allow-headers'), pathname).toContain(
          'authorization',
        );
        expect(response.headers.get('access-control-allow-credentials'), pathname).toBeNull();
      }
    });

    it('grants no preflight to another origin, another method or another API path', async () => {
      for (const [origin, method, pathname] of [
        ['https://evil.example', 'GET', '/api/runs/run-1'],
        [SHOP, 'POST', '/api/runs/run-1'],
        [SHOP, 'DELETE', '/api/runs/run-1/feedback'],
      ] as const) {
        const response = await crossOrigin('OPTIONS', pathname, {
          origin,
          'access-control-request-method': method,
        });
        expect(response.status, `${origin} ${method} ${pathname}`).toBe(204);
        expect(response.headers.get('access-control-allow-origin'), pathname).toBeNull();
      }
      for (const [method, pathname] of [
        ['POST', '/api/runs/run-1/interrupt'],
        ['GET', '/api/agents'],
        ['GET', '/api/runs'],
      ] as const) {
        const response = await crossOrigin('OPTIONS', pathname, {
          origin: SHOP,
          'access-control-request-method': method,
        });
        expect(response.status, pathname).not.toBe(204);
        expect(response.headers.get('access-control-allow-origin'), pathname).toBeNull();
      }
    });

    it('lets a listed origin read each visitor run route answer, refusals included', async () => {
      for (const [method, pathname] of VISITOR_ROUTES) {
        for (const headers of [
          { origin: SHOP, authorization: BROWSER_TOKEN_HEADER },
          { origin: SHOP },
        ]) {
          const response = await crossOrigin(method, pathname, headers);
          expect(response.headers.get('access-control-allow-origin'), pathname).toBe(SHOP);
          expect(response.headers.get('access-control-expose-headers'), pathname).toContain(
            'retry-after',
          );
          expect(response.headers.get('access-control-allow-credentials'), pathname).toBeNull();
        }
      }
      const refused = await crossOrigin('GET', '/api/runs/run-1', { origin: SHOP });
      expect(refused.status).toBe(401);
      const tooOld = await crossOrigin('GET', '/api/runs/run-1', {
        origin: SHOP,
        [CONTRACTS_VERSION_HEADER]: '0.0.1',
      });
      expect(tooOld.status).toBe(426);
      expect(tooOld.headers.get('access-control-allow-origin')).toBe(SHOP);
    });

    it('lets no other origin or API path read an answer', async () => {
      const evil = await crossOrigin('GET', '/api/runs/run-1', {
        origin: 'https://evil.example',
        authorization: BROWSER_TOKEN_HEADER,
      });
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
      expect(evil.headers.get('vary')).toContain('origin');
      const other = await crossOrigin('GET', '/api/agents', { origin: SHOP });
      expect(other.headers.get('access-control-allow-origin')).toBeNull();
      expect(other.headers.get('vary')).toBeNull();
    });
  });
});

describe('the deployment feature gate of apps/web/proxy.ts (ADR-0160 D7)', () => {
  const previousFeatures = process.env['AW_DEPLOYMENT_FEATURES'];
  afterEach(() => {
    if (previousFeatures === undefined) delete process.env['AW_DEPLOYMENT_FEATURES'];
    else process.env['AW_DEPLOYMENT_FEATURES'] = previousFeatures;
  });
  const send = (method: string, pathname: string) =>
    proxy(new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { method }));

  it('answers 404 feature_disabled before authentication for a feature the deployment leaves out', async () => {
    process.env['AW_DEPLOYMENT_FEATURES'] = 'chat,runs';
    const response = await send('GET', '/api/files');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      error: { code: 'feature_disabled', details: ['files'] },
    });
  });

  it('refuses the anonymous discovery documents of a feature that is not installed', async () => {
    process.env['AW_DEPLOYMENT_FEATURES'] = 'chat,runs';
    const response = await send('GET', '/.well-known/oauth-protected-resource/mcp/builder');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'feature_disabled', details: ['builder'] },
    });
  });

  it('lets an installed feature and a core route reach the credential check', async () => {
    process.env['AW_DEPLOYMENT_FEATURES'] = 'chat,runs';
    expect((await send('GET', '/api/runs')).status).toBe(401);
    expect((await send('GET', '/api/agents')).status).toBe(401);
  });

  it('leaves the public /p/** pages to their own not-found', async () => {
    process.env['AW_DEPLOYMENT_FEATURES'] = 'chat,runs';
    const response = await send('GET', '/p/s/main');
    expect(response.status).not.toBe(404);
  });

  // Measured against `next start` on Next 16.4.3: `/api/triggers/` is answered `308` to
  // `/api/triggers` before the proxy runs, and `/api/%74riggers` reaches the proxy still encoded
  // and then matches no route (`404`). Neither reaches the triggers handler unrefused; the proxy
  // only has to keep its credential check for them.
  it('keeps the credential check for a trailing-slash form, which Next redirects before the proxy', async () => {
    process.env['AW_DEPLOYMENT_FEATURES'] = 'chat,runs';
    const response = await send('GET', '/api/triggers/');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('keeps the credential check for a percent-encoded form, which no route serves', async () => {
    process.env['AW_DEPLOYMENT_FEATURES'] = 'chat,runs';
    const response = await send('GET', '/api/%74riggers');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('answers 503 service_unavailable when the variable is invalid', async () => {
    process.env['AW_DEPLOYMENT_FEATURES'] = 'not-a-feature';
    const response = await send('GET', '/api/files');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'service_unavailable', details: ['deployment_features_invalid'] },
    });
  });

  it('changes nothing when the variable is unset', async () => {
    delete process.env['AW_DEPLOYMENT_FEATURES'];
    expect((await send('GET', '/api/files')).status).toBe(401);
  });
});
