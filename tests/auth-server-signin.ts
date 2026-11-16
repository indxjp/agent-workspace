import { expect, it } from 'vitest';
import { INVITATION_ACCEPT_PROBE } from './auth-server-fixtures.js';

export function registerSignInProbes(server: {
  readonly base: string;
  readonly token: string;
}): void {
  it('allows the OIDC sign-in exchange with no session — issue #118', async () => {
    for (const [method, pathname] of [
      ['GET', '/api/auth/login'],
      ['POST', '/api/auth/callback'],
      ['GET', '/api/auth/workspace'],
      ['POST', '/api/auth/workspace'],
    ] as const) {
      const init: RequestInit = {
        method,
        redirect: 'manual',
        headers: { 'content-type': 'application/json', origin: server.base },
      };
      const response = await fetch(
        `${server.base}${pathname}`,
        method === 'POST' ? { ...init, body: '{}' } : init,
      );
      // Never the gate's 401 — each of these still answers on its own terms (this server has no
      // OIDC configured, so 503/400 is what "reachable but not usable" looks like here).
      expect(response.status, `${method} ${pathname}`).not.toBe(401);
    }
  });

  it('allows the three pre-credential steps of `aw login` with no session — issue #242', async () => {
    for (const [method, pathname] of [
      ['POST', '/api/auth/cli-device'],
      ['POST', '/api/auth/cli-token'],
      ['GET', '/api/auth/cli-verify'],
    ] as const) {
      const init: RequestInit = {
        method,
        redirect: 'manual',
        headers: { 'content-type': 'application/json', origin: server.base },
      };
      const response = await fetch(
        `${server.base}${pathname}`,
        method === 'POST' ? { ...init, body: '{}' } : init,
      );
      // Never the gate's 401. This server has no database, so the CLI sign-in runtime is not
      // installed and its handlers answer `503 cli_auth_not_configured` — "reachable but not
      // usable here", as for OIDC above. `tests/no-route-answers-503.test.ts` drives the same
      // routes against a fully configured deployment, where none of them answers 503.
      expect(response.status, `${method} ${pathname}`).not.toBe(401);
    }
  });

  it('allows the ID-token exchange with no session, and names why it cannot serve — ADR-0161', async () => {
    const response = await fetch(`${server.base}/api/auth/token-exchange`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // This server has neither OIDC nor a database, so the handler, not the gate, answers D6's 503.
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      error: { code: 'token_exchange_not_configured' },
    });
  });

  // ── every redirect on the sign-in path is relative, observed on the wire (issue #201) ───────
  //
  // `request.url`'s origin is the address this server is *bound* to and never the address the
  // client used, so a `Location` built from it can send the browser to a different origin than
  // the one that asked — a reverse proxy, a container port map or a plain `localhost` /
  // `127.0.0.1` alias is enough — and the cookies minted on that same response are then not sent.
  //
  // Both assertions read the header as a **whole string**. Reading it through
  // `new URL(location).pathname` is exactly what hid the original defect, because
  // `new URL('http://localhost:3000/signin').pathname` is also `/signin`.
  it('redirects an unauthenticated page visit to /signin with a relative Location', async () => {
    const response = await fetch(`${server.base}/`, { redirect: 'manual' });
    // 307, not 303: this is `apps/web/proxy.ts`'s gate, and preserving the method matters for a
    // non-GET request to a page path (a Server Action posts to one).
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/signin');
    expect(response.headers.get('location')).not.toContain('://');
    expect(response.headers.get('location')).not.toContain(new URL(server.base).host);
    expect(response.headers.get('location')).not.toContain('localhost');
  }, 20000);

  it('answers a route handler’s own relative Location unchanged through the whole pipeline', async () => {
    // The control for the test above: `/api/auth/workspace` is exempt from the proxy gate, so
    // this header is the one `app/api/auth/workspace/route.ts` set, carried to the wire by the
    // route pipeline rather than rewritten by the proxy adapter. It is what proves the shape
    // `apps/web/app/api/auth/callback/route.ts` now uses survives end to end.
    const response = await fetch(`${server.base}/api/auth/workspace`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/signin?error=session_expired');
  }, 20000);

  it('exempts only the exact invitation acceptance POST for its route-local identity gate', async () => {
    const response = await fetch(`${server.base}${INVITATION_ACCEPT_PROBE}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'invitation_identity_required' },
    });
    const wider = await fetch(`${server.base}${INVITATION_ACCEPT_PROBE}/extra`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: '{}',
    });
    expect(wider.status).toBe(401);
    expect(await wider.json()).toMatchObject({
      error: { code: 'unauthenticated', details: ['no_session_cookie'] },
    });
  });

  it('answers 401 for a path that no route handler serves — the gate runs before routing', async () => {
    const invented = `/api/${Math.random().toString(36).slice(2)}/${Math.random().toString(36).slice(2)}`;
    const response = await fetch(`${server.base}${invented}`, { redirect: 'manual' });
    expect(response.status).toBe(401);
  });

  it('does not authenticate the /p/ surface (spec §34)', async () => {
    for (const pathname of ['/p/some-token', '/p/some-token/messages']) {
      const response = await fetch(`${server.base}${pathname}`, { redirect: 'manual' });
      expect([401, 403], pathname).not.toContain(response.status);
    }
  }, 15000);
}
