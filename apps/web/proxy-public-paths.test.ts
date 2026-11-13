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
import { proxy } from './proxy';
import { PASSED_THROUGH, SAMPLE_ID, useSessionSecret } from './proxy.test-support';

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
  useSessionSecret();
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
