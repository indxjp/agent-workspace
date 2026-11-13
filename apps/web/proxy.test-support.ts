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

import { afterAll, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { type ApiRoute } from '@indx-workspace/contracts/routes';
import { proxy } from './proxy';
import { MIN_SESSION_SECRET_LENGTH } from './server/auth/session';

// The exact argument shape `adapter.js` uses when it re-reads a proxy response's `Location`.
export const ADAPTER_OPTIONS = { forceLocale: false, headers: {}, nextConfig: {} } as const;

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
export const PASSED_THROUGH = 'x-middleware-next';

export const API_KEY_HEADER = 'Bearer ak_live_00000000000000000000000000000000';

export const SAMPLE_ID = '11111111-1111-4111-8111-111111111111';

export function apiRequest(
  pathname: string,
  headers: Readonly<Record<string, string>> = {},
): NextRequest {
  return new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), { headers });
}

export function keyRequest(method: string, pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), {
    method,
    headers: { authorization: API_KEY_HEADER },
  });
}

/** A concrete path for a catalogue path: every `:param` becomes a UUID-shaped segment. */
export function concretePath(path: string): string {
  return path.replace(/:[A-Za-z]+/gu, SAMPLE_ID);
}

/**
 * Catalogue routes the proxy passes through for a reason other than an API key — sign-in, the
 * invitation acceptance, a trigger's fire URL, setup detection and the runner's per-run token on
 * `/api/sessions/**` — so
 * a refusal of the key on them cannot be observed through `proxy()`; the derived matcher is
 * asserted for them instead.
 */
export function passesWithoutAKey(route: ApiRoute): boolean {
  return (
    route.path.startsWith('/api/sessions/') ||
    route.path.startsWith('/api/setup/') ||
    route.security === 'endpoint-credential' ||
    route.path === '/api/invitations/:id/accept' ||
    route.path === '/api/triggers/:id/fire/:secret' ||
    route.path === '/api/auth/cli-device' ||
    (route.method === 'POST' && route.path === '/api/auth/cli-token') ||
    // ADR-0161 D3: the exchange authenticates the endpoint client itself.
    route.path === '/api/auth/token-exchange' ||
    (route.method === 'POST' && route.path === '/api/auth/workspace')
  );
}

/**
 * The bearer-browser-token allowlist (issue #236, SDK-04, S-1) — a credential-shape exemption
 * only. `decide()`'s scope grammar (`apps/web/server/rbac/decide.ts`) is what actually refuses a
 * token whose scope does not reach the row a matched path names; this pins that the proxy's own
 * match is exactly the route shapes §3.1's grammar admits; the routes still verify the bearer
 * themselves. `POST` is asserted for the run-starting shape because that is the only method §3.1
 * grants a session scope over `agents`.
 */
export const BROWSER_TOKEN_HEADER = 'Bearer awt_live_00000000000000000000000000000000';

export function useSessionSecret() {
  const previousSecret = process.env['SESSION_SECRET'];
  beforeAll(() => {
    process.env['SESSION_SECRET'] = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
    else process.env['SESSION_SECRET'] = previousSecret;
  });
}

export function sendBrowserToken(method: string, pathname: string) {
  return proxy(
    new NextRequest(new URL(pathname, 'http://127.0.0.1:3000'), {
      method,
      headers: { authorization: BROWSER_TOKEN_HEADER },
    }),
  );
}
