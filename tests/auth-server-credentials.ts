import { expect, it } from 'vitest';
import {
  sessionCookieName,
  SESSION_TTL_SECONDS,
  mintSessionToken,
  newSessionClaims,
} from '../apps/web/server/auth/session.js';
import { SECRET } from './auth-server-fixtures.js';

export function registerCredentialProbes(server: {
  readonly base: string;
  readonly token: string;
}): void {
  // The explicit budget is the one the other first-hit tests above carry, for the same reason:
  // every earlier request to `/api/agents` stopped at the proxy gate, so this is the first one to
  // reach the route, and `next dev` compiles the route's whole module graph on demand inside it.
  // That compile alone takes 2.5–3.7 s on a green CI runner and has crossed Vitest's default 5 s
  // on a slower one, so the default budget measured the runner, not the gate.
  it('lets a valid session through the gate', async () => {
    const response = await fetch(`${server.base}/api/agents`, {
      redirect: 'manual',
      headers: { cookie: `${sessionCookieName()}=${server.token}` },
    });
    // No handler exists on this branch, so "through the gate" is any status that is not the
    // gate's own. 404 is the routing layer answering, which is exactly the proof wanted.
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  }, 20000);

  it('refuses a state-changing request that carries no Origin, even with a valid session', async () => {
    const response = await fetch(`${server.base}/api/agents`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: `${sessionCookieName()}=${server.token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'cross_origin' } });
  });

  it('refuses a state-changing request from another origin', async () => {
    const response = await fetch(`${server.base}/api/agents`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: `${sessionCookieName()}=${server.token}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('rejects an expired session with 401', async () => {
    const stale = await mintSessionToken(
      newSessionClaims(
        'admin@example.com',
        'default',
        Date.now() - (SESSION_TTL_SECONDS + 60) * 1000,
      ),
      SECRET,
    );
    const response = await fetch(`${server.base}/api/agents`, {
      redirect: 'manual',
      headers: { cookie: `${sessionCookieName()}=${stale}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'unauthenticated', details: ['expired_session'] },
    });
  });
}
