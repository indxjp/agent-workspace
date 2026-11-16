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
import { POST as postRunFeedback } from './app/api/runs/[id]/feedback/route';
import { proxy } from './proxy';
import { InMemoryRunStore } from './server/runs/memory-store';
import { installTestRunApi, resetTestRunApi } from './server/application-context-fixtures';
import {
  BROWSER_TOKEN_HEADER,
  PASSED_THROUGH,
  SAMPLE_ID,
  apiRequest,
  sendBrowserToken,
  useSessionSecret,
} from './proxy.test-support';

describe('the paths apps/web/proxy.ts admits on a bearer browser token', () => {
  useSessionSecret();

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
    const rated = await sendBrowserToken('POST', '/api/runs/run-1/feedback');
    expect(rated.headers.get(PASSED_THROUGH)).toBe('1');
    for (const [method, pathname] of [
      ['GET', '/api/runs/run-1/feedback'],
      ['POST', '/api/runs/run-1/feedback/x'],
      ['POST', '/api/runs/run-1/cancel'],
      ['POST', '/api/runs/run-1/interrupt'],
    ] as const) {
      const response = await sendBrowserToken(method, pathname);
      expect(response.status, `${method} ${pathname}`).toBe(401);
      expect(response.headers.get(PASSED_THROUGH), `${method} ${pathname}`).toBeNull();
    }
  });

  // Issue #251 (N-4): the two presign shapes, exactly POST /api/files/:id/{upload,download}-urls.
  it('passes the two presign POSTs through, and nothing next to them', async () => {
    for (const pathname of ['/api/files/ZmlsZQ/upload-urls', '/api/files/ZmlsZQ/download-urls']) {
      const minted = await sendBrowserToken('POST', pathname);
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
      const response = await sendBrowserToken(method, pathname);
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
