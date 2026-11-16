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
import { CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';
import { installTestDomains } from './server/application-context-fixtures';
import { BROWSER_TOKEN_HEADER, PASSED_THROUGH, useSessionSecret } from './proxy.test-support';
import { clearApplicationContext } from './server/application-context';

// ADR-0105 slice 1, S1-17 (#455): the hosted surface may be framed by its own origin only.
describe('the frame-ancestors policy apps/web/proxy.ts sets on the hosted surface', () => {
  useSessionSecret();
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
            env: () => process.env,
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
