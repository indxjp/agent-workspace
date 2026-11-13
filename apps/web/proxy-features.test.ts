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

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

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
