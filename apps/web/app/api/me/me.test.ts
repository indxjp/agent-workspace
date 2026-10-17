/**
 * `GET /api/me`, driven as Next.js would drive it — issue #233.
 *
 * The route module itself is imported and called with real `Request` objects, so what is proved
 * here is the **wiring**: that the handler goes through `authorise`, that both principal kinds
 * reach it, and that a credential which stopped being usable answers `401` rather than a `200`
 * carrying a stale principal. `apps/web/server/rbac/me.test.ts` proves the projection; this file
 * proves the route.
 *
 * ## Concealment is not applicable, and that is a fact about the route
 *
 * Every other single-row route of this task conceals whether an id it was handed exists (issue
 * #117's "indistinguishable 404"). `/api/me` has no id parameter and names no row: a principal is
 * a singleton per caller, so there is nothing to conceal and no test here for it. Stated rather
 * than left as an omission a reader has to interpret (ADR-0031).
 *
 * ## Why the expiry case installs its own resolver
 *
 * `installRbacHarness` mints the session token it verifies, from the caller the harness was asked
 * for, so it cannot present an *expired* one. The last block therefore installs a runtime whose
 * `identify`
 * is the production shape from `apps/web/server/composition/session-rbac.ts` — read the session
 * cookie, `verifySessionToken`, `null` on any failure — over the same in-memory directory, and
 * drives the same route with a real token minted twelve hours and one second ago. A fresh token
 * through the *same* resolver is asserted to reach `200`, so the `401` is evidence about the
 * expiry rather than about a resolver that never worked.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  mintSessionToken,
  newSessionClaims,
  sessionCookieName,
  SESSION_TTL_SECONDS,
  verifySessionToken,
} from '../../../server/auth/session';
import { sessionCookieValue } from '../../../server/composition/identity';
import { conferredBy } from '../../../server/rbac/conferral';
import {
  parsePresentedKey,
  presentedKeyText,
  readBearerApiKeyAttempt,
} from '../../../server/rbac/api-key';
import { createMemoryDirectory } from '../../../server/rbac/memory-directory';
import { Principal } from '../../../server/rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../../../server/rbac/runtime';
import {
  installRbacHarness,
  TEST_WORKSPACE_ID,
  TEST_WORKSPACE_SLUG,
  type RbacHarness,
} from '../../../server/rbac/testing';

import { GET } from './route';

const MEMBER = { email: 'member@example.test' };
const SECRET = 'a-me-route-test-session-secret-that-is-long-enough';

let live: RbacHarness | null = null;

afterEach(() => {
  live?.teardown();
  live = null;
  clearRbacRuntime();
});

function harness(): RbacHarness {
  const built = installRbacHarness([
    { email: MEMBER.email, name: 'Aya Ito', workspaceId: TEST_WORKSPACE_ID, role: 'admin' },
  ]);
  live = built;
  return built;
}

/** Mint a key in the harness's own directory and hand back what a caller would present. */
async function mintKey(built: RbacHarness, name: string): Promise<{ id: string; key: string }> {
  const created = await built.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
    name,
    role: conferredBy('owner', 'builder', 'the fixture in apps/web/app/api/me/me.test.ts'),
    expiresAt: null,
  });
  if (created.kind !== 'created') throw new Error(`the fixture could not mint a key: ${name}`);
  return { id: created.key.id, key: created.presented };
}

describe('GET /api/me answers for both principal kinds', () => {
  it('names the workspace, role, principal id, user and label of a session caller', async () => {
    const built = harness();

    const response = await built.call(GET, { method: 'GET', path: '/api/me', as: MEMBER });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      principalId: expect.any(String) as unknown,
      kind: 'membership',
      role: 'admin',
      workspaceId: TEST_WORKSPACE_ID,
      userId: expect.any(String) as unknown,
      label: 'Aya Ito',
    });
    // `authorise` is the only caller of `forWorkspace` in the program and it calls it on the
    // `allow` branch alone, so this is a positive record that the gate ran rather than two
    // absences a handler that skipped it would also satisfy.
    expect(built.scopedWorkspaces).toEqual([TEST_WORKSPACE_ID]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('names the workspace and role of an API-key caller, whose userId is null', async () => {
    const built = harness();
    const key = await mintKey(built, 'ci');

    const response = await built.call(GET, {
      method: 'GET',
      path: '/api/me',
      as: null,
      bearer: key.key,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      principalId: expect.any(String) as unknown,
      kind: 'api-key',
      role: 'builder',
      workspaceId: TEST_WORKSPACE_ID,
      userId: null,
      label: 'ci',
    });
  });

  it('puts no credential material and no withheld field into any body it produced', async () => {
    const built = harness();
    const key = await mintKey(built, 'scanned');
    const parsed = parsePresentedKey(key.key);
    if (parsed === null) throw new Error('the fixture minted a key its own parser cannot read');
    await built.call(GET, { method: 'GET', path: '/api/me', as: null, bearer: key.key });
    await built.call(GET, { method: 'GET', path: '/api/me', as: MEMBER });

    expect(built.responses).toHaveLength(2);
    for (const recorded of built.responses) {
      // The credential itself and its secret half, scanned in the response text — R-12 §1.5's
      // method, which is what would catch a future field carrying either.
      for (const secret of [key.key, parsed.secret]) {
        expect(recorded.text, 'credential material reached a response body').not.toContain(secret);
      }
      // And the three public fields of `Principal` the wire withholds, by key rather than by
      // substring: the in-memory fixture spells its generated principal ids `api_key-principal:…`,
      // so a text scan for `api_key` would be measuring the fixture rather than the serializer.
      expect(Object.keys(JSON.parse(recorded.text) as object)).toEqual([
        'principalId',
        'kind',
        'role',
        'workspaceId',
        'userId',
        'label',
      ]);
    }
  });
});

describe('GET /api/me refuses a credential that stopped being usable', () => {
  it('answers 401 in the standard envelope for a revoked key, not 200 with a stale principal', async () => {
    const built = harness();
    const key = await mintKey(built, 'doomed');
    // The same key reaches a principal first, so the 401 below is evidence about the revocation.
    expect(
      (await built.call(GET, { method: 'GET', path: '/api/me', as: null, bearer: key.key })).status,
    ).toBe(200);

    const revoked = await built.directory.forWorkspace(TEST_WORKSPACE_ID).revokeApiKey(key.id);
    expect(revoked.kind).toBe('revoked');

    const response = await built.call(GET, {
      method: 'GET',
      path: '/api/me',
      as: null,
      bearer: key.key,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: 'unauthenticated',
        message: expect.any(String) as unknown,
        detail: expect.any(String) as unknown,
      },
    });
    // Nothing was authorised, so nothing was scoped: the second call recorded no workspace.
    expect(built.scopedWorkspaces).toEqual([TEST_WORKSPACE_ID]);
  });

  it('answers 401 for an expired session, through the production identity resolver', async () => {
    const directory = createMemoryDirectory({
      users: [
        { email: MEMBER.email, name: 'Aya Ito', workspaceId: TEST_WORKSPACE_ID, role: 'admin' },
      ],
    });
    // The production shape of `installRbacApi`'s resolver, over the in-memory directory: a bearer
    // key first, else the session cookie, and `null` for any verification failure.
    configureRbacRuntime({
      directory,
      identify: async (request: Request): Promise<Principal | null> => {
        const attempt = readBearerApiKeyAttempt(request.headers.get('authorization'));
        if (attempt.kind === 'invalid') return null;
        if (attempt.kind === 'presented') {
          const identity = await directory.authenticateApiKey(
            presentedKeyText(attempt.key),
            new Date(),
          );
          return identity === null ? null : Principal.fromApiKey(identity);
        }
        const verified = await verifySessionToken(
          sessionCookieValue(request.headers.get('cookie')),
          SECRET,
        );
        if (!verified.ok) return null;
        const role = await directory.resolveRole(verified.claims.sub, TEST_WORKSPACE_ID);
        if (role === null) return null;
        const membership = (await directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships()).find(
          (candidate) => candidate.email === verified.claims.sub,
        );
        if (membership === undefined) return null;
        const built = Principal.fromSession(
          verified.claims,
          { id: TEST_WORKSPACE_ID, slug: TEST_WORKSPACE_SLUG },
          role,
          {
            principalId: membership.principalId,
            userId: membership.userId,
            label: membership.name,
          },
        );
        return built.ok ? built.principal : null;
      },
    });

    const call = async (token: string): Promise<Response> =>
      GET(
        new Request('https://control-plane.test/api/me', {
          headers: { cookie: `${sessionCookieName()}=${token}` },
        }),
      );

    // One second past the maximum lifetime this build issues.
    const expiredAt = Date.now() - (SESSION_TTL_SECONDS + 1) * 1000;
    const expired = await mintSessionToken(
      newSessionClaims(MEMBER.email, TEST_WORKSPACE_SLUG, expiredAt),
      SECRET,
    );
    const verdict = await verifySessionToken(expired, SECRET);
    expect(verdict.ok ? 'verified' : verdict.code).toBe('expired_session');

    const refused = await call(expired);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: {
        code: 'unauthenticated',
        message: expect.any(String) as unknown,
        detail: expect.any(String) as unknown,
      },
    });

    // The control: a fresh token through the same resolver reaches the principal, so the 401
    // above is about the expiry and not about a resolver that never worked.
    const fresh = await mintSessionToken(
      newSessionClaims(MEMBER.email, TEST_WORKSPACE_SLUG),
      SECRET,
    );
    const allowed = await call(fresh);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ kind: 'membership', role: 'admin' });
  });

  it('answers 401 for no credential at all', async () => {
    const built = harness();

    const response = await built.call(GET, { method: 'GET', path: '/api/me', as: null });

    expect(response.status).toBe(401);
    expect(built.scopedWorkspaces).toEqual([]);
  });
});

describe('GET /api/me on a deployment with no RBAC runtime', () => {
  it('answers 503, because nothing was checked and nothing pretends to have been', async () => {
    const built = harness();
    // The same request reaches a principal while the runtime is installed…
    expect((await built.call(GET, { method: 'GET', path: '/api/me', as: MEMBER })).status).toBe(
      200,
    );
    built.teardown();
    live = null;

    const response = await built.call(GET, { method: 'GET', path: '/api/me', as: MEMBER });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        code: 'rbac_runtime_not_configured',
        message: expect.any(String) as unknown,
        detail: expect.any(String) as unknown,
      },
    });
  });
});
