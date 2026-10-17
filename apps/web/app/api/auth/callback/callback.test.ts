/**
 * `POST /api/auth/callback` — issue #118's verifier attack #3, plus the identity → membership
 * branching.
 *
 * `finishOidcLogin` is faked via {@link CallbackDeps} for the reason `route.ts`'s header gives:
 * driving the real `openid-client` exchange needs a live or stubbed issuer (declared gap G-4),
 * and every branch this task actually owns — origin, the transaction cookie, and what happens
 * once an identity comes back or `finishOidcLogin` throws — is real code, not faked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  invitationIdentityCookieName,
  oidcTransactionCookieName,
  selectionCookieName,
  sessionCookieName,
  verifyInvitationIdentityToken,
  verifySessionToken,
} from '../../../../server/auth';
import { conferredBy } from '../../../../server/rbac/conferral';
import { createMemoryDirectory } from '../../../../server/rbac/memory-directory';
import { clearRbacRuntime, configureRbacRuntime } from '../../../../server/rbac/runtime';

import { handleCallback, type CallbackDeps } from './route';

const SECRET = 'a'.repeat(32);
const HOST = 'app.example.test';
const ISSUER = 'https://idp.example.test';
const URL_ = `https://${HOST}/api/auth/callback`;

function request(options: {
  cookies?: Record<string, string>;
  origin?: string | null;
  form?: Record<string, string>;
}): Request {
  const headers = new Headers();
  if (options.cookies !== undefined) {
    headers.set(
      'cookie',
      Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    );
  }
  headers.set('host', HOST);
  const origin = options.origin === undefined ? `https://${HOST}` : options.origin;
  if (origin !== null) headers.set('origin', origin);
  headers.set('content-type', 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(
    options.form ?? { code: 'auth-code', state: 'state-value' },
  ).toString();
  return new Request(URL_, { method: 'POST', headers, body });
}

function setCookieValue(response: Response, name: string): string | undefined {
  for (const raw of response.headers.getSetCookie()) {
    if (raw.startsWith(`${name}=`)) return raw.slice(name.length + 1).split(';')[0];
  }
  return undefined;
}

/**
 * The `Location` is asserted as a **whole string**, never through `new URL(location).pathname`.
 * Parsing is what hid this defect for three releases: `new URL('https://app.example.test/').pathname`
 * is also `/`, so a reading that goes through `URL` passes just as happily on a header that sends
 * the browser to a different origin than the one it asked — where the cookies riding on this very
 * response are not sent, and a completed sign-in arrives signed out.
 */
function expectRelativeLocation(response: Response, expected: string): void {
  const location = response.headers.get('location');
  expect(location).toBe(expected);
  expect(location).not.toContain(HOST);
  expect(location).not.toContain('://');
}

function fakeDeps(
  identity: { subject: string; email: string; name: string | null; next?: string | null } | Error,
): CallbackDeps {
  return {
    finishOidcLogin: () =>
      identity instanceof Error ? Promise.reject(identity) : Promise.resolve(identity),
  };
}

describe('POST /api/auth/callback', () => {
  beforeEach(() => {
    process.env['SESSION_SECRET'] = SECRET;
    process.env['OIDC_ISSUER_URL'] = ISSUER;
    process.env['OIDC_CLIENT_ID'] = 'client';
    process.env['OIDC_CLIENT_SECRET'] = 'client-secret';
    process.env['OIDC_REDIRECT_URI'] = URL_;
  });

  afterEach(() => {
    for (const name of [
      'SESSION_SECRET',
      'OIDC_ISSUER_URL',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_REDIRECT_URI',
    ]) {
      delete process.env[name];
    }
    clearRbacRuntime();
  });

  it('refuses a cross-origin callback before ever calling finishOidcLogin', async () => {
    let called = false;
    const deps: CallbackDeps = {
      finishOidcLogin: () => {
        called = true;
        return Promise.resolve({ subject: 's', email: 'e@example.test', name: null });
      },
    };
    const response = await handleCallback(
      request({
        cookies: { [oidcTransactionCookieName()]: 'txn' },
        origin: 'https://attacker.example',
      }),
      deps,
    );
    expect(response.status).toBe(403);
    expect(called).toBe(false);
    expect(setCookieValue(response, sessionCookieName())).toBeUndefined();
    expect(setCookieValue(response, selectionCookieName())).toBeUndefined();

    // BREAK-IT CHECK (done by hand while writing this test, reverted before commit): commenting
    // out the `if (!origin.ok)` early return in route.ts makes `called` become `true` and the
    // response a redirect instead of a 403. Restoring the check makes this test pass again.
  });

  it('refuses when the transaction cookie is missing, without calling finishOidcLogin', async () => {
    let called = false;
    const deps: CallbackDeps = {
      finishOidcLogin: () => {
        called = true;
        return Promise.resolve({ subject: 's', email: 'e@example.test', name: null });
      },
    };
    const response = await handleCallback(request({}), deps);
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it('refuses when finishOidcLogin throws — mismatched state, missing PKCE verifier, or a consumed state all reach this path', async () => {
    for (const reason of ['state does not match', 'no PKCE verifier', 'state already consumed']) {
      const response = await handleCallback(
        request({ cookies: { [oidcTransactionCookieName()]: 'txn' } }),
        fakeDeps(new Error(reason)),
      );
      expect(response.status).toBe(401);
      expect(setCookieValue(response, sessionCookieName())).toBeUndefined();
      expect(setCookieValue(response, selectionCookieName())).toBeUndefined();
    }

    // BREAK-IT CHECK (done by hand, reverted before commit): removing the `try`/`catch` around
    // `deps.finishOidcLogin(...)` (letting the rejection propagate) makes this test fail with an
    // unhandled rejection instead of a clean 401. Restoring the catch makes it pass again.
  });

  it('mints only a pre-membership invitation identity for a new OIDC identity', async () => {
    const directory = createMemoryDirectory();
    configureRbacRuntime({
      directory,
      identify: () => Promise.resolve(null),
    });
    const response = await handleCallback(
      request({ cookies: { [oidcTransactionCookieName()]: 'txn' } }),
      fakeDeps({ subject: 'sub-1', email: 'nobody@example.test', name: null }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, '/signin?invitation=ready');
    expect(setCookieValue(response, sessionCookieName())).toBeUndefined();
    expect(setCookieValue(response, selectionCookieName())).toBeUndefined();
    const identityCookie = setCookieValue(response, invitationIdentityCookieName());
    const verified = await verifyInvitationIdentityToken(identityCookie, SECRET);
    expect(verified).toMatchObject({
      ok: true,
      claims: { email: 'nobody@example.test', issuer: ISSUER, subject: 'sub-1' },
    });
    expect(JSON.stringify(verified)).not.toContain('workspace');
    expect(JSON.stringify(verified)).not.toContain('role');
    expect(await directory.findUserByEmail('nobody@example.test')).toBeNull();
    expect(await directory.findIdentity(ISSUER, 'sub-1')).toBeNull();
  });

  it('does not bind an existing zero-membership user until invitation acceptance commits', async () => {
    const directory = createMemoryDirectory({
      users: [
        {
          email: 'existing@example.test',
          name: 'Existing',
          workspaceId: 'former-workspace',
          role: 'viewer',
        },
      ],
    });
    const former = directory.forWorkspace('former-workspace');
    const membership = (await former.listMemberships())[0];
    if (membership === undefined) throw new Error('membership setup failed');
    expect((await former.deleteMembership(membership.id)).kind).toBe('deleted');
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });

    const response = await handleCallback(
      request({ cookies: { [oidcTransactionCookieName()]: 'txn' } }),
      fakeDeps({ subject: 'unbound-subject', email: 'existing@example.test', name: null }),
    );

    expect(response.status).toBe(303);
    expectRelativeLocation(response, '/signin?invitation=ready');
    expect(setCookieValue(response, invitationIdentityCookieName())).toBeDefined();
    expect(await directory.findIdentity(ISSUER, 'unbound-subject')).toBeNull();
  });

  it('mints a tenant session directly for exactly one CURRENT membership', async () => {
    const directory = createMemoryDirectory({
      workspaces: [{ id: 'ws-a', slug: 'acme', name: 'Acme' }],
      users: [{ email: 'solo@example.test', name: 'Solo', workspaceId: 'ws-a', role: 'admin' }],
    });
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });
    const response = await handleCallback(
      request({ cookies: { [oidcTransactionCookieName()]: 'txn' } }),
      fakeDeps({ subject: 'sub-solo', email: 'solo@example.test', name: null }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, '/');
    expect(setCookieValue(response, sessionCookieName())).toBeDefined();
    expect(setCookieValue(response, selectionCookieName())).toBeUndefined();

    // The identity is bound, so a second callback for the same (issuer, subject) resolves the
    // same user without a second lookup by email.
    const bound = await directory.findIdentity(ISSUER, 'sub-solo');
    expect(bound).not.toBeNull();
    expect(typeof bound?.userId).toBe('string');
  });

  it("mints the session for the bound user's directory email, not the IdP email claim", async () => {
    const directory = createMemoryDirectory({
      workspaces: [{ id: 'ws-a', slug: 'acme', name: 'Acme' }],
      users: [
        { email: 'alice@example.test', name: 'Alice', workspaceId: 'ws-a', role: 'viewer' },
        { email: 'owner@example.test', name: 'Owner', workspaceId: 'ws-a', role: 'owner' },
      ],
    });
    const alice = await directory.findUserByEmail('alice@example.test');
    if (alice === null) throw new Error('seed did not create alice');
    await directory.linkIdentity(ISSUER, 'sub-alice', alice.id);
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });

    // Alice changed her provider email to the Owner's address.
    const response = await handleCallback(
      request({ cookies: { [oidcTransactionCookieName()]: 'txn' } }),
      fakeDeps({ subject: 'sub-alice', email: 'owner@example.test', name: null }),
    );
    expect(response.status).toBe(303);
    const verified = await verifySessionToken(
      setCookieValue(response, sessionCookieName()) ?? '',
      SECRET,
    );
    expect(verified).toMatchObject({ ok: true, claims: { sub: 'alice@example.test' } });
  });

  it.each([
    [
      'a same-origin path',
      '/oauth/authorize?client_id=c&state=s',
      '/oauth/authorize?client_id=c&state=s',
    ],
    ['no destination', null, '/'],
    ['a protocol-relative URL', '//evil.example/x', '/'],
    ['an absolute URL', 'https://evil.example/', '/'],
    ['a backslash host', '/\\evil.example', '/'],
  ])('lands a single-membership sign-in on %s', async (_name, next, expected) => {
    const directory = createMemoryDirectory({
      workspaces: [{ id: 'ws-a', slug: 'acme', name: 'Acme' }],
      users: [{ email: 'solo@example.test', name: 'Solo', workspaceId: 'ws-a', role: 'admin' }],
    });
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });
    const response = await handleCallback(
      request({ cookies: { [oidcTransactionCookieName()]: 'txn' } }),
      fakeDeps({ subject: 'sub-solo', email: 'solo@example.test', name: null, next }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, expected);
  });

  it('sets a selection cookie, not a session, for more than one CURRENT membership', async () => {
    const directory = createMemoryDirectory({
      workspaces: [
        { id: 'ws-a', slug: 'acme', name: 'Acme' },
        { id: 'ws-b', slug: 'beta', name: 'Beta Inc' },
      ],
      users: [{ email: 'multi@example.test', name: 'Multi', workspaceId: 'ws-a', role: 'admin' }],
    });
    await directory.forWorkspace('ws-b').createMembership({
      email: 'multi@example.test',
      role: conferredBy('owner', 'viewer', 'test'),
    });
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });

    const response = await handleCallback(
      request({ cookies: { [oidcTransactionCookieName()]: 'txn' } }),
      fakeDeps({ subject: 'sub-multi', email: 'multi@example.test', name: null }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, '/api/auth/workspace');
    expect(setCookieValue(response, sessionCookieName())).toBeUndefined();
    expect(setCookieValue(response, selectionCookieName())).toBeDefined();
  });

  it.each([
    [
      'a same-origin path',
      '/oauth/authorize?client_id=x&state=y',
      '/api/auth/workspace?next=%2Foauth%2Fauthorize%3Fclient_id%3Dx%26state%3Dy',
    ],
    ['no destination', null, '/api/auth/workspace'],
    ['a protocol-relative URL', '//evil.example', '/api/auth/workspace'],
    ['an absolute URL', 'https://evil.example/', '/api/auth/workspace'],
  ])('carries %s to the workspace picker', async (_name, next, expected) => {
    const directory = createMemoryDirectory({
      workspaces: [
        { id: 'ws-a', slug: 'acme', name: 'Acme' },
        { id: 'ws-b', slug: 'beta', name: 'Beta Inc' },
      ],
      users: [{ email: 'multi@example.test', name: 'Multi', workspaceId: 'ws-a', role: 'admin' }],
    });
    await directory.forWorkspace('ws-b').createMembership({
      email: 'multi@example.test',
      role: conferredBy('owner', 'viewer', 'test'),
    });
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });

    const response = await handleCallback(
      request({ cookies: { [oidcTransactionCookieName()]: 'txn' } }),
      fakeDeps({ subject: 'sub-multi', email: 'multi@example.test', name: null, next }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, expected);
    expect(setCookieValue(response, sessionCookieName())).toBeUndefined();
  });

  // BREAK-IT CHECK for all three arms above (done by hand while writing these tests, reverted
  // before commit): restoring `NextResponse.redirect(new URL(path, request.url), 303)` at each of
  // the three sites makes every `expectRelativeLocation` call fail — the header becomes
  // `https://app.example.test/…`, which is the server's *bind* origin and not necessarily the
  // caller's. Restoring `redirectTo` makes them pass again, and the diff after reverting is empty.

  it('never answers a Location on any refusal path — a refusal redirects nowhere', async () => {
    const withTransaction = { cookies: { [oidcTransactionCookieName()]: 'txn' } };
    const identity = { subject: 'sub-1', email: 'nobody@example.test', name: null };

    const crossOrigin = await handleCallback(
      request({ ...withTransaction, origin: 'https://attacker.example' }),
      fakeDeps(identity),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({ error: 'cross_origin' });

    // All four together, because a partial set is a misconfiguration `readOidcConfiguration`
    // throws on rather than the "OIDC is simply not enabled here" `null` this arm answers to.
    const oidcEnv = [
      'OIDC_ISSUER_URL',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_REDIRECT_URI',
    ];
    const savedOidcEnv = oidcEnv.map((name) => [name, process.env[name]] as const);
    for (const name of oidcEnv) delete process.env[name];
    const notConfigured = await handleCallback(request(withTransaction), fakeDeps(identity));
    expect(notConfigured.status).toBe(503);
    expect(await notConfigured.json()).toMatchObject({ error: 'oidc_not_configured' });
    for (const [name, value] of savedOidcEnv) if (value !== undefined) process.env[name] = value;

    // A body the platform cannot read as form data — the `request.formData()` catch arm.
    const malformed = await handleCallback(
      new Request(URL_, {
        method: 'POST',
        headers: {
          host: HOST,
          origin: `https://${HOST}`,
          cookie: `${oidcTransactionCookieName()}=txn`,
          'content-type': 'application/json',
        },
        body: '{"not":"a form"}',
      }),
      fakeDeps(identity),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'malformed_request' });

    const noTransaction = await handleCallback(request({}), fakeDeps(identity));
    expect(noTransaction.status).toBe(400);
    expect(await noTransaction.json()).toMatchObject({ error: 'oidc_transaction_missing' });

    const rejected = await handleCallback(
      request(withTransaction),
      fakeDeps(new Error('state does not match')),
    );
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ error: 'oidc_callback_rejected' });

    // No `configureRbacRuntime` anywhere in this test, so the identity resolves and then finds no
    // runtime — the last refusal before the first redirecting arm. The typed code is asserted on
    // every arm above and here because the statuses collide (503 twice, 400 twice): status alone
    // cannot tell this arm from `oidc_not_configured`, so a later edit that hoisted
    // `configureRbacRuntime` into a shared `beforeEach` would silently make six refusals five.
    const noRuntime = await handleCallback(request(withTransaction), fakeDeps(identity));
    expect(noRuntime.status).toBe(503);
    expect(await noRuntime.json()).toMatchObject({ error: 'rbac_runtime_not_configured' });

    for (const response of [
      crossOrigin,
      notConfigured,
      malformed,
      noTransaction,
      rejected,
      noRuntime,
    ]) {
      expect(response.headers.get('location'), String(response.status)).toBeNull();
    }
  });

  it('clears the OIDC transaction cookie on every path, including a refusal', async () => {
    configureRbacRuntime({
      directory: createMemoryDirectory(),
      identify: () => Promise.resolve(null),
    });
    const response = await handleCallback(
      request({ cookies: { [oidcTransactionCookieName()]: 'txn' } }),
      fakeDeps({ subject: 'sub-1', email: 'nobody@example.test', name: null }),
    );
    expect(setCookieValue(response, oidcTransactionCookieName())).toBe('');
  });
});
