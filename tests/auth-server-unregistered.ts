import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  MIN_SESSION_SECRET_LENGTH,
  sessionCookieName,
  mintSessionToken,
  newSessionClaims,
} from '../apps/web/server/auth/session.js';
import {
  discoverApiRouteHandlers,
  UNREGISTERED_ROUTE_FILE,
  UNREGISTERED_ROUTE_PATH,
  UNREGISTERED_ROUTE_CANARY,
  PUBLIC_ROUTE_PATH,
  PUBLIC_ROUTE_MARKER,
  probes,
} from './auth-server-fixtures.js';

export function registerFixtureProbes(server: {
  readonly base: string;
  readonly token: string;
}): void {
  // ── the second half of the acceptance criterion ────────────────────────────────────────────
  it('discovers the brand-new route by walking the tree, so the probe matrix covers it', () => {
    expect(existsSync(UNREGISTERED_ROUTE_FILE)).toBe(true);
    expect(discoverApiRouteHandlers()).toContain(UNREGISTERED_ROUTE_PATH);
    // And it reached the matrix above under its own steam. If this fails, the GET/POST 401
    // assertions for this path were never generated and their absence proved nothing.
    expect(probes).toContain(UNREGISTERED_ROUTE_PATH);
    // The tracked handlers reached it too, so the filter admits the repository's own routes and
    // is not simply returning this file's fixture back to it.
    expect(probes).toContain('/api/agents');
    expect(probes).toContain('/api/runs/probe-id/events');
  });

  it('ignores a route handler that neither git tracks nor this test wrote', () => {
    // The negative control for the membership rule, executed. A real `route.ts` on disk, under a
    // root laid out exactly like `apps/web`, is not reported — because nothing tracks it and this
    // file did not write it. That is the property that keeps `probes` stable no matter what a
    // sibling test plants under `apps/web/app/api` in a parallel worker (ADR-0019 §4).
    //
    // Built under the OS temp directory, never inside the repository: a control for a race must
    // not itself be one.
    const foreignRoot = mkdtempSync(path.join(tmpdir(), 'w1cp06-foreign-'));
    try {
      const dir = path.join(foreignRoot, 'app', 'api', 'somebody-elses-fixture');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'route.ts'), 'export function GET() {}\n', 'utf8');
      expect(existsSync(path.join(dir, 'route.ts'))).toBe(true);
      expect(discoverApiRouteHandlers(foreignRoot)).toEqual([]);
    } finally {
      rmSync(foreignRoot, { recursive: true, force: true });
    }
  });

  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    '%s on a route registered nowhere → 401, and the body never carries the canary',
    async (method) => {
      const response = await fetch(`${server.base}${UNREGISTERED_ROUTE_PATH}`, {
        method,
        redirect: 'manual',
      });
      expect(response.status, method).toBe(401);
      expect(await response.text(), method).not.toContain(UNREGISTERED_ROUTE_CANARY);
    },
  );

  it('serves the brand-new route to a valid session, so the 401 above was the gate', async () => {
    const response = await fetch(`${server.base}${UNREGISTERED_ROUTE_PATH}`, {
      redirect: 'manual',
      headers: { cookie: `${sessionCookieName()}=${server.token}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    // The handler called `requireWorkspaceScope()`, so this body is also the proof that the whole
    // module graph under index.ts compiles and runs under Turbopack with workspace.ts's one
    // type-only sibling import erased.
    expect(await response.json()).toEqual({
      canary: UNREGISTERED_ROUTE_CANARY,
      scope: { workspaceSlug: 'default', actorEmail: 'admin@example.com', role: 'owner' },
    });
  });

  // ── where an unauthenticated endpoint (a sign-in, eventually) can live ─────────────────────
  it.each(['GET', 'POST'])(
    '%s an unauthenticated handler under /p/ reaches it, with no session and no auth import',
    async (method) => {
      const response = await fetch(`${server.base}${PUBLIC_ROUTE_PATH}`, {
        method,
        redirect: 'manual',
      });
      expect(response.status, `${method}: ${await response.clone().text()}`).toBe(200);
      expect(await response.json(), method).toEqual({ reached: PUBLIC_ROUTE_MARKER });
    },
  );

  it('refuses the same handler moved under /api/, which is why sign-in cannot live there', async () => {
    // Not a hypothetical: these are the paths §34's conventions would put a sign-in at.
    for (const pathname of ['/api/auth/signin', '/api/auth/login', '/api/session', '/api/login']) {
      const response = await fetch(`${server.base}${pathname}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', origin: server.base },
        body: '{}',
      });
      expect(response.status, pathname).toBe(401);
    }
  });

  it('rejects a session signed with somebody else’s secret with 401', async () => {
    const forged = await mintSessionToken(
      newSessionClaims('attacker@example.com', 'other'),
      'z'.repeat(MIN_SESSION_SECRET_LENGTH),
    );
    const response = await fetch(`${server.base}/api/agents`, {
      redirect: 'manual',
      headers: { cookie: `${sessionCookieName()}=${forged}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'unauthenticated', details: ['invalid_signature'] },
    });
  });
}
