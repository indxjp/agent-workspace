/**
 * `POST /api/auth/callback` — the identity → membership branching: what each directory state
 * mints once `finishOidcLogin` has returned an identity. Refusals live in `callback.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  invitationIdentityCookieName,
  selectionCookieName,
  signInSessionCookieName,
  verifyInvitationIdentityToken,
  verifySignInSessionToken,
} from '../../../../server/auth';
import { createMemoryDirectory } from '../../../../server/rbac/memory-directory';

import {
  ISSUER,
  SECRET,
  expectRelativeLocation,
  fakeDeps,
  installDirectory,
  multiDirectory,
  setCookieValue,
  soloDirectory,
  transactionRequest,
  useCallbackEnvironment,
} from './callback.test-support';
import { handleCallback } from './route';

describe('POST /api/auth/callback — membership branching', () => {
  useCallbackEnvironment();

  it('mints only a pre-membership invitation identity for a new OIDC identity', async () => {
    const directory = createMemoryDirectory();
    installDirectory(directory);
    const response = await handleCallback(
      transactionRequest(),
      fakeDeps({ subject: 'sub-1', email: 'nobody@example.test', name: null }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, '/signin?invitation=ready');
    expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
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
    installDirectory(directory);

    const response = await handleCallback(
      transactionRequest(),
      fakeDeps({ subject: 'unbound-subject', email: 'existing@example.test', name: null }),
    );

    expect(response.status).toBe(303);
    expectRelativeLocation(response, '/signin?invitation=ready');
    expect(setCookieValue(response, invitationIdentityCookieName())).toBeDefined();
    expect(await directory.findIdentity(ISSUER, 'unbound-subject')).toBeNull();
  });

  it('mints a tenant session directly for exactly one CURRENT membership', async () => {
    const directory = soloDirectory();
    installDirectory(directory);
    const response = await handleCallback(
      transactionRequest(),
      fakeDeps({ subject: 'sub-solo', email: 'solo@example.test', name: null }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, '/');
    expect(setCookieValue(response, signInSessionCookieName())).toBeDefined();
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
    installDirectory(directory);

    // Alice changed her provider email to the Owner's address.
    const response = await handleCallback(
      transactionRequest(),
      fakeDeps({ subject: 'sub-alice', email: 'owner@example.test', name: null }),
    );
    expect(response.status).toBe(303);
    const verified = await verifySignInSessionToken(
      setCookieValue(response, signInSessionCookieName()) ?? '',
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
    const directory = soloDirectory();
    installDirectory(directory);
    const response = await handleCallback(
      transactionRequest(),
      fakeDeps({ subject: 'sub-solo', email: 'solo@example.test', name: null, next }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, expected);
  });

  it('sets a selection cookie, not a session, for more than one CURRENT membership', async () => {
    installDirectory(await multiDirectory());

    const response = await handleCallback(
      transactionRequest(),
      fakeDeps({ subject: 'sub-multi', email: 'multi@example.test', name: null }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, '/api/auth/workspace');
    expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
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
    installDirectory(await multiDirectory());

    const response = await handleCallback(
      transactionRequest(),
      fakeDeps({ subject: 'sub-multi', email: 'multi@example.test', name: null, next }),
    );
    expect(response.status).toBe(303);
    expectRelativeLocation(response, expected);
    expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
  });

  // BREAK-IT CHECK for all three arms above (done by hand while writing these tests, reverted
  // before commit): restoring `NextResponse.redirect(new URL(path, request.url), 303)` at each of
  // the three sites makes every `expectRelativeLocation` call fail — the header becomes
  // `https://app.example.test/…`, which is the server's *bind* origin and not necessarily the
  // caller's. Restoring `redirectTo` makes them pass again, and the diff after reverting is empty.
});
