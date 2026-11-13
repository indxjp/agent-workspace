import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { handleCallback, type CallbackDeps } from '../../app/api/auth/callback/route';
import { POST as ACCEPT } from '../../app/api/invitations/[id]/accept/route';
import { POST as CREATE } from '../../app/api/invitations/route';
import { installTestDomains } from '../application-context-fixtures';
import {
  invitationIdentityCookieName,
  mintInvitationIdentityToken,
  oidcTransactionCookieName,
  sessionCookieName,
} from '../auth';
import { mintSessionToken, newSessionClaims } from '../auth/session';
import { TEST_WORKSPACE_ID } from '../rbac/testing';
import {
  IDENTITY_ISSUER,
  installInvitationHarness,
  invitationCreation,
  setCookieValue,
  TEST_SESSION_SECRET,
} from './invitation-routes.test-support';
import type { InvitationAuditEvent } from './runtime';
import { createManualLinkInvitationSender } from './send-invitation';

export function registerAcceptanceTests(env: NodeJS.ProcessEnv) {
  it('makes a mismatched identity, an active tenant session, and a nonexistent invitation indistinguishable', () =>
    makesMismatchedIdentityActiveTenantSessionNonexistentInvitation(env));

  it('accepts with only the dedicated OIDC identity cookie, binds identity, and mints the invited-workspace session', () =>
    acceptsOnlyDedicatedOIDCIdentityCookieBindsIdentity(env));

  it('attributes an already-member acceptance audit to that exact membership principal', () =>
    attributesAlreadyMemberAcceptanceAuditThatExactMembership(env));

  it('chains the zero-membership OIDC callback into atomic new-user acceptance', () =>
    chainsZeroMembershipOIDCCallbackIntoAtomicNew(env));
}

async function makesMismatchedIdentityActiveTenantSessionNonexistentInvitation(
  env: NodeJS.ProcessEnv,
) {
  env['SESSION_SECRET'] = TEST_SESSION_SECRET;
  installTestDomains({
    invitations: {
      recordAuditEvent: () => Promise.resolve(),
      sendInvitation: createManualLinkInvitationSender(),
    },
  });
  const harness = installInvitationHarness();
  try {
    const createdResponse = await harness.call(CREATE, {
      method: 'POST',
      path: '/api/invitations',
      as: { email: 'owner@example.test' },
      body: { email: 'admin@example.test', role: 'viewer' },
    });
    const created = invitationCreation(createdResponse.body);

    const wrongIdentity = await mintInvitationIdentityToken(
      { email: 'viewer@example.test', issuer: IDENTITY_ISSUER, subject: 'viewer-subject' },
      TEST_SESSION_SECRET,
    );
    const mismatch = await harness.call(ACCEPT, {
      method: 'POST',
      path: `/api/invitations/${created.id}/accept`,
      as: null,
      id: created.id,
      body: { token: created.token },
      origin: 'https://control-plane.test',
      cookies: { [invitationIdentityCookieName()]: wrongIdentity },
    });
    const random = await harness.call(ACCEPT, {
      method: 'POST',
      path: `/api/invitations/${crypto.randomUUID()}/accept`,
      as: null,
      id: crypto.randomUUID(),
      body: { token: created.token },
      origin: 'https://control-plane.test',
      cookies: { [invitationIdentityCookieName()]: wrongIdentity },
    });
    expect(mismatch.status).toBe(404);
    expect(random.status).toBe(404);
    expect(mismatch.text).toBe(random.text);
    expect(mismatch.text).not.toContain(TEST_WORKSPACE_ID);
    expect(mismatch.text).not.toContain('admin@example.test');

    const workspaceBSession = await mintSessionToken(
      newSessionClaims('viewer@example.test', 'workspace-b'),
      TEST_SESSION_SECRET,
    );
    const matchingIdentity = await mintInvitationIdentityToken(
      { email: 'admin@example.test', issuer: IDENTITY_ISSUER, subject: 'admin-subject' },
      TEST_SESSION_SECRET,
    );
    const activeOtherSession = await harness.call(ACCEPT, {
      method: 'POST',
      path: `/api/invitations/${created.id}/accept`,
      as: null,
      id: created.id,
      body: { token: created.token },
      origin: 'https://control-plane.test',
      cookies: {
        [invitationIdentityCookieName()]: matchingIdentity,
        [sessionCookieName()]: workspaceBSession,
      },
    });
    expect(activeOtherSession.status).toBe(404);
    expect(activeOtherSession.text).toBe(random.text);
  } finally {
    harness.teardown();
  }
}

async function acceptsOnlyDedicatedOIDCIdentityCookieBindsIdentity(env: NodeJS.ProcessEnv) {
  env['SESSION_SECRET'] = TEST_SESSION_SECRET;
  const audit: InvitationAuditEvent[] = [];
  installTestDomains({
    invitations: {
      recordAuditEvent: (event) => {
        audit.push(event);
        return Promise.resolve();
      },
      sendInvitation: createManualLinkInvitationSender(),
    },
  });
  const harness = installInvitationHarness();
  try {
    const createdResponse = await harness.call(CREATE, {
      method: 'POST',
      path: '/api/invitations',
      as: { email: 'owner@example.test' },
      body: { email: 'new-identity@example.test', role: 'viewer' },
    });
    const created = invitationCreation(createdResponse.body);
    const identityToken = await mintInvitationIdentityToken(
      {
        email: 'new-identity@example.test',
        issuer: IDENTITY_ISSUER,
        subject: 'new-identity-subject',
      },
      TEST_SESSION_SECRET,
    );
    const response = await harness.call(ACCEPT, {
      method: 'POST',
      path: `/api/invitations/${created.id}/accept`,
      as: null,
      id: created.id,
      body: { token: created.token },
      origin: 'https://control-plane.test',
      cookies: { [invitationIdentityCookieName()]: identityToken },
    });

    expect(response.status, response.text).toBe(200);
    const bound = await harness.directory.findIdentity(IDENTITY_ISSUER, 'new-identity-subject');
    expect(bound).not.toBeNull();
    expect(await harness.directory.membershipsForUser(bound?.userId ?? '')).toEqual([
      expect.objectContaining({ workspaceId: TEST_WORKSPACE_ID, role: 'viewer' }),
    ]);
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.some((cookie) => cookie.startsWith(`${sessionCookieName()}=`))).toBe(true);
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${invitationIdentityCookieName()}=`) && cookie.includes('Max-Age=0'),
      ),
    ).toBe(true);
    expect(audit.at(-1)).toMatchObject({ action: 'invitation-accepted' });
  } finally {
    harness.teardown();
  }
}

async function attributesAlreadyMemberAcceptanceAuditThatExactMembership(env: NodeJS.ProcessEnv) {
  env['SESSION_SECRET'] = TEST_SESSION_SECRET;
  const audit: InvitationAuditEvent[] = [];
  installTestDomains({
    invitations: {
      recordAuditEvent: (event) => {
        audit.push(event);
        return Promise.resolve();
      },
      sendInvitation: createManualLinkInvitationSender(),
    },
  });
  const harness = installInvitationHarness();
  try {
    const viewer = (await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships()).find(
      (membership) => membership.email === 'viewer@example.test',
    );
    if (viewer === undefined) throw new Error('viewer setup failed');
    const createdResponse = await harness.call(CREATE, {
      method: 'POST',
      path: '/api/invitations',
      as: { email: 'owner@example.test' },
      body: { email: viewer.email, role: 'viewer' },
    });
    const created = invitationCreation(createdResponse.body);
    const identityToken = await mintInvitationIdentityToken(
      { email: viewer.email, issuer: IDENTITY_ISSUER, subject: 'existing-viewer-subject' },
      TEST_SESSION_SECRET,
    );

    const response = await harness.call(ACCEPT, {
      method: 'POST',
      path: `/api/invitations/${created.id}/accept`,
      as: null,
      id: created.id,
      body: { token: created.token },
      origin: 'https://control-plane.test',
      cookies: { [invitationIdentityCookieName()]: identityToken },
    });

    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: 'already_a_member' } },
    });
    expect(audit.at(-1)).toMatchObject({
      action: 'invitation-accepted',
      actorPrincipalId: viewer.principalId,
      actorUserId: viewer.userId,
    });
  } finally {
    harness.teardown();
  }
}

async function chainsZeroMembershipOIDCCallbackIntoAtomicNew(env: NodeJS.ProcessEnv) {
  env['SESSION_SECRET'] = TEST_SESSION_SECRET;
  env['OIDC_ISSUER_URL'] = IDENTITY_ISSUER;
  env['OIDC_CLIENT_ID'] = 'client';
  env['OIDC_CLIENT_SECRET'] = 'client-secret';
  env['OIDC_REDIRECT_URI'] = 'https://control-plane.test/api/auth/callback';
  installTestDomains({
    invitations: {
      recordAuditEvent: () => Promise.resolve(),
      sendInvitation: createManualLinkInvitationSender(),
    },
  });
  const harness = installInvitationHarness();
  try {
    const createdResponse = await harness.call(CREATE, {
      method: 'POST',
      path: '/api/invitations',
      as: { email: 'owner@example.test' },
      body: { email: 'callback-new@example.test', role: 'viewer' },
    });
    const created = invitationCreation(createdResponse.body);
    const deps: CallbackDeps = {
      finishOidcLogin: () =>
        Promise.resolve({
          email: 'callback-new@example.test',
          subject: 'callback-new-subject',
          name: null,
        }),
    };
    const callback = await handleCallback(
      new Request('https://control-plane.test/api/auth/callback', {
        method: 'POST',
        headers: {
          host: 'control-plane.test',
          origin: 'https://control-plane.test',
          cookie: `${oidcTransactionCookieName()}=transaction`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'code=code&state=state',
      }),
      deps,
    );
    const identityCookie = setCookieValue(callback, invitationIdentityCookieName());
    expect(callback.status).toBe(303);
    expect(identityCookie).toBeDefined();
    expect(setCookieValue(callback, sessionCookieName())).toBeUndefined();
    expect(await harness.directory.findUserByEmail('callback-new@example.test')).toBeNull();

    const accepted = await harness.call(ACCEPT, {
      method: 'POST',
      path: `/api/invitations/${created.id}/accept`,
      as: null,
      id: created.id,
      body: { token: created.token },
      origin: 'https://control-plane.test',
      cookies: { [invitationIdentityCookieName()]: identityCookie ?? '' },
    });
    expect(accepted.status, accepted.text).toBe(200);
    const bound = await harness.directory.findIdentity(IDENTITY_ISSUER, 'callback-new-subject');
    expect(bound).not.toBeNull();
    expect(await harness.directory.membershipsForUser(bound?.userId ?? '')).toEqual([
      expect.objectContaining({ workspaceId: TEST_WORKSPACE_ID, role: 'viewer' }),
    ]);
    expect(
      accepted.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${sessionCookieName()}=`)),
    ).toBe(true);
  } finally {
    harness.teardown();
  }
}
