import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as ACCEPT } from '../../app/api/invitations/[id]/accept/route';
import { POST as RESEND } from '../../app/api/invitations/[id]/resend/route';
import { DELETE as REVOKE } from '../../app/api/invitations/[id]/route';
import { GET as LIST, POST as CREATE } from '../../app/api/invitations/route';
import { handleCallback, type CallbackDeps } from '../../app/api/auth/callback/route';
import {
  invitationIdentityCookieName,
  oidcTransactionCookieName,
  sessionCookieName,
  mintInvitationIdentityToken,
} from '../auth';
import { mintSessionToken, newSessionClaims, verifySessionToken } from '../auth/session';
import { conferredBy } from '../rbac/conferral';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { installRbacHarness, TEST_WORKSPACE_ID } from '../rbac/testing';
import { createInvitation as createInvitationHandler } from './handlers';
import type { InvitationAuditEvent } from './runtime';
import { createManualLinkInvitationSender } from './send-invitation';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';

const MEMBERS = [
  {
    email: 'owner@example.test',
    name: 'Owner',
    workspaceId: TEST_WORKSPACE_ID,
    role: 'owner' as const,
  },
  {
    email: 'admin@example.test',
    name: 'Admin',
    workspaceId: TEST_WORKSPACE_ID,
    role: 'admin' as const,
  },
  {
    email: 'builder@example.test',
    name: 'Builder',
    workspaceId: TEST_WORKSPACE_ID,
    role: 'builder' as const,
  },
  {
    email: 'viewer@example.test',
    name: 'Viewer',
    workspaceId: TEST_WORKSPACE_ID,
    role: 'viewer' as const,
  },
];

const TEST_SESSION_SECRET = 'invitation-session-secret-that-is-long-enough';
const IDENTITY_ISSUER = 'https://issuer.example.test';

function installInvitationHarness() {
  return installRbacHarness(MEMBERS, { newId: crypto.randomUUID });
}

async function sessionPrincipal(email: string, role: 'admin'): Promise<Principal> {
  const token = await mintSessionToken(newSessionClaims(email, 'default'), TEST_SESSION_SECRET);
  const verified = await verifySessionToken(token, TEST_SESSION_SECRET);
  if (!verified.ok) throw new Error(`test session could not be verified: ${verified.reason}`);
  const built = Principal.fromSession(
    verified.claims,
    { id: TEST_WORKSPACE_ID, slug: 'default' },
    role,
    {
      principalId: '2218cf6d-4c5f-42e9-9276-237504501564',
      userId: 'bb5a45b9-415a-484a-b4d7-b3d1713d7cb6',
      label: 'Removed invitation administrator',
    },
  );
  if (!built.ok) throw new Error(`test principal could not be built: ${built.because}`);
  return built.principal;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function invitationCreation(body: unknown): { id: string; token: string; link: string } {
  const response = record(body);
  const invitation = record(response['invitation']);
  const id = invitation['id'];
  const token = response['token'];
  const link = response['link'];
  if (typeof id !== 'string' || typeof token !== 'string' || typeof link !== 'string') {
    throw new Error(`creation response omitted its one-time fields: ${JSON.stringify(body)}`);
  }
  return { id, token, link };
}

function setCookieValue(response: Response, name: string): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith(`${name}=`)) return cookie.slice(name.length + 1).split(';')[0];
  }
  return undefined;
}

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
  clearApplicationContext();
  vi.restoreAllMocks();
});

describe('/api/invitations route wiring', () => {
  it('answers 503 rbac_runtime_not_configured while no context is installed', async () => {
    // The invitations domain and the RBAC gate live in one context, so the gate answers first.
    const harness = installInvitationHarness();
    clearApplicationContext();
    try {
      const response = await harness.call(CREATE, {
        method: 'POST',
        path: '/api/invitations',
        as: { email: 'owner@example.test' },
        body: { email: 'invitee@example.test', role: 'viewer' },
      });
      expect(response.status).toBe(503);
      expect(response.text).toContain('rbac_runtime_not_configured');
    } finally {
      harness.teardown();
    }
  });

  it('returns a token once, rotates it on resend, and redacts every list and audit shape', async () => {
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
        body: { email: 'invitee@example.test', role: 'viewer' },
      });
      expect(createdResponse.status).toBe(201);
      const created = invitationCreation(createdResponse.body);
      expect(created.link).toContain(encodeURIComponent(created.token));
      expect(JSON.stringify(audit)).not.toContain(created.token);

      const listed = await harness.call(LIST, {
        method: 'GET',
        path: '/api/invitations',
        as: { email: 'owner@example.test' },
      });
      expect(listed.status).toBe(200);
      expect(listed.text).not.toContain(created.token);
      expect(listed.text).not.toContain('tokenHash');

      const resentResponse = await harness.call(RESEND, {
        method: 'POST',
        path: `/api/invitations/${created.id}/resend`,
        as: { email: 'admin@example.test' },
        id: created.id,
      });
      expect(resentResponse.status).toBe(200);
      const resent = invitationCreation(resentResponse.body);
      expect(resent.token).not.toBe(created.token);
      expect(resent.id).toBe(created.id);
      expect(JSON.stringify(audit)).not.toContain(created.token);
      expect(JSON.stringify(audit)).not.toContain(resent.token);

      const revoked = await harness.call(REVOKE, {
        method: 'DELETE',
        path: `/api/invitations/${created.id}`,
        as: { email: 'owner@example.test' },
        id: created.id,
      });
      expect(revoked.status).toBe(200);
      expect(revoked.text).not.toContain(resent.token);
      expect(audit.map((event) => event.action)).toEqual([
        'invitation-created',
        'invitation-resent',
        'invitation-revoked',
      ]);
    } finally {
      harness.teardown();
    }
  });

  it('applies conferral dominance to Admin and route grants to Builder and Viewer', async () => {
    installTestDomains({
      invitations: {
        recordAuditEvent: () => Promise.resolve(),
        sendInvitation: createManualLinkInvitationSender(),
      },
    });
    const harness = installInvitationHarness();
    try {
      // ADR-0152: Admin holds everything Builder holds, so only Owner is beyond it.
      for (const role of ['owner'] as const) {
        const response = await harness.call(CREATE, {
          method: 'POST',
          path: '/api/invitations',
          as: { email: 'admin@example.test' },
          body: { email: `${role}@invitee.example.test`, role },
        });
        expect(response.status, response.text).toBe(403);
        expect(response.text).toContain('may not confer');
      }

      for (const caller of ['builder', 'viewer'] as const) {
        const response = await harness.call(CREATE, {
          method: 'POST',
          path: '/api/invitations',
          as: { email: `${caller}@example.test` },
          body: { email: `${caller}@invitee.example.test`, role: 'viewer' },
        });
        expect(response.status, response.text).toBe(403);
        expect(response.text).toContain('forbidden');
      }

      const allowed = await harness.call(CREATE, {
        method: 'POST',
        path: '/api/invitations',
        as: { email: 'admin@example.test' },
        body: { email: 'viewer-invite@example.test', role: 'viewer' },
      });
      expect(allowed.status, allowed.text).toBe(201);
    } finally {
      harness.teardown();
    }
  });

  it('rejects undeclared fields on every invitation JSON body before any state change', async () => {
    process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
    installTestDomains({
      invitations: {
        recordAuditEvent: () => Promise.resolve(),
        sendInvitation: createManualLinkInvitationSender(),
      },
    });
    const harness = installInvitationHarness();
    try {
      const rejectedCreate = await harness.call(CREATE, {
        method: 'POST',
        path: '/api/invitations',
        as: { email: 'owner@example.test' },
        body: {
          email: 'strict-body@example.test',
          role: 'viewer',
          workspaceId: 'foreign-workspace',
        },
      });
      expect(rejectedCreate).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_field' } },
      });
      expect(await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listInvitations()).toEqual([]);

      const createdResponse = await harness.call(CREATE, {
        method: 'POST',
        path: '/api/invitations',
        as: { email: 'owner@example.test' },
        body: { email: 'strict-body@example.test', role: 'viewer' },
      });
      const created = invitationCreation(createdResponse.body);
      const identity = await mintInvitationIdentityToken(
        { email: 'strict-body@example.test', issuer: IDENTITY_ISSUER, subject: 'strict-subject' },
        TEST_SESSION_SECRET,
      );
      const rejectedAccept = await harness.call(ACCEPT, {
        method: 'POST',
        path: `/api/invitations/${created.id}/accept`,
        as: null,
        id: created.id,
        body: { token: created.token, workspaceId: 'foreign-workspace' },
        origin: 'https://control-plane.test',
        cookies: { [invitationIdentityCookieName()]: identity },
      });
      expect(rejectedAccept).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_field' } },
      });

      const accepted = await harness.call(ACCEPT, {
        method: 'POST',
        path: `/api/invitations/${created.id}/accept`,
        as: null,
        id: created.id,
        body: { token: created.token },
        origin: 'https://control-plane.test',
        cookies: { [invitationIdentityCookieName()]: identity },
      });
      expect(accepted.status, accepted.text).toBe(200);
    } finally {
      harness.teardown();
    }
  });

  it('rejects every malformed dynamic invitation id before a repository call', async () => {
    process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
    installTestDomains({
      invitations: {
        recordAuditEvent: () => Promise.resolve(),
        sendInvitation: createManualLinkInvitationSender(),
      },
    });
    const harness = installInvitationHarness();
    try {
      const identity = await mintInvitationIdentityToken(
        { email: 'invitee@example.test', issuer: IDENTITY_ISSUER, subject: 'id-shape-subject' },
        TEST_SESSION_SECRET,
      );
      const probes = [
        harness.call(RESEND, {
          method: 'POST',
          path: '/api/invitations/not-a-uuid/resend',
          as: { email: 'owner@example.test' },
          id: 'not-a-uuid',
        }),
        harness.call(REVOKE, {
          method: 'DELETE',
          path: '/api/invitations/not-a-uuid',
          as: { email: 'owner@example.test' },
          id: 'not-a-uuid',
        }),
        harness.call(ACCEPT, {
          method: 'POST',
          path: '/api/invitations/not-a-uuid/accept',
          as: null,
          id: 'not-a-uuid',
          body: { token: 'not-a-token' },
          origin: 'https://control-plane.test',
          cookies: { [invitationIdentityCookieName()]: identity },
        }),
      ];
      for (const response of await Promise.all(probes)) {
        expect(response).toMatchObject({
          status: 400,
          body: { error: { code: 'invalid_field' } },
        });
        expect(response.text).not.toContain('22P02');
      }
    } finally {
      harness.teardown();
    }
  });

  it('makes foreign and nonexistent resend and revoke responses byte-identical', async () => {
    installTestDomains({
      invitations: {
        recordAuditEvent: () => Promise.resolve(),
        sendInvitation: createManualLinkInvitationSender(),
      },
    });
    const harness = installInvitationHarness();
    try {
      const owner = (
        await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships()
      ).find((membership) => membership.email === 'owner@example.test');
      if (owner === undefined) throw new Error('owner setup failed');
      const foreign = await harness.directory.forWorkspace(crypto.randomUUID()).createInvitation({
        email: 'foreign@example.test',
        role: conferredBy('owner', 'viewer', 'foreign concealment test'),
        invitedBy: owner.userId,
      });
      if (foreign.kind !== 'created') throw new Error('foreign invitation setup failed');
      const nonexistentId = crypto.randomUUID();

      for (const [handler, method, suffix] of [
        [RESEND, 'POST', '/resend'],
        [REVOKE, 'DELETE', ''],
      ] as const) {
        const foreignResponse = await harness.call(handler, {
          method,
          path: `/api/invitations/${foreign.invitation.id}${suffix}`,
          as: { email: 'owner@example.test' },
          id: foreign.invitation.id,
        });
        const nonexistentResponse = await harness.call(handler, {
          method,
          path: `/api/invitations/${nonexistentId}${suffix}`,
          as: { email: 'owner@example.test' },
          id: nonexistentId,
        });
        expect(foreignResponse.status).toBe(404);
        expect(foreignResponse.text).toBe(nonexistentResponse.text);
        expect(foreignResponse.text).not.toContain(foreign.invitation.id);
        expect(nonexistentResponse.text).not.toContain(nonexistentId);
      }
    } finally {
      harness.teardown();
    }
  });

  it('makes a mismatched identity, an active tenant session, and a nonexistent invitation indistinguishable', async () => {
    process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
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
  });

  it('accepts with only the dedicated OIDC identity cookie, binds identity, and mints the invited-workspace session', async () => {
    process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
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
  });

  it('attributes an already-member acceptance audit to that exact membership principal', async () => {
    process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
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
      const viewer = (
        await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships()
      ).find((membership) => membership.email === 'viewer@example.test');
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
  });

  it('chains the zero-membership OIDC callback into atomic new-user acceptance', async () => {
    process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
    process.env['OIDC_ISSUER_URL'] = IDENTITY_ISSUER;
    process.env['OIDC_CLIENT_ID'] = 'client';
    process.env['OIDC_CLIENT_SECRET'] = 'client-secret';
    process.env['OIDC_REDIRECT_URI'] = 'https://control-plane.test/api/auth/callback';
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
  });

  it('requires the application origin and dedicated identity cookie before reading an invitation', async () => {
    process.env['SESSION_SECRET'] = TEST_SESSION_SECRET;
    installTestDomains({
      invitations: {
        recordAuditEvent: () => Promise.resolve(),
        sendInvitation: createManualLinkInvitationSender(),
      },
    });
    const harness = installInvitationHarness();
    try {
      const tenantSession = await mintSessionToken(
        newSessionClaims('viewer@example.test', 'workspace-b'),
        TEST_SESSION_SECRET,
      );
      const contextId = crypto.randomUUID();
      const crossOrigin = await harness.call(ACCEPT, {
        method: 'POST',
        path: `/api/invitations/${contextId}/accept`,
        as: null,
        id: contextId,
        body: { token: 'not-a-token' },
        origin: 'https://attacker.example.test',
      });
      expect(crossOrigin).toMatchObject({
        status: 403,
        body: { error: { code: 'cross_origin' } },
      });

      const noIdentity = await harness.call(ACCEPT, {
        method: 'POST',
        path: `/api/invitations/${contextId}/accept`,
        as: null,
        id: contextId,
        body: { token: 'not-a-token' },
        origin: 'https://control-plane.test',
      });
      expect(noIdentity).toMatchObject({
        status: 401,
        body: { error: { code: 'invitation_identity_required' } },
      });

      const tenantSessionOnly = await harness.call(ACCEPT, {
        method: 'POST',
        path: `/api/invitations/${contextId}/accept`,
        as: null,
        id: contextId,
        body: { token: 'not-a-token' },
        origin: 'https://control-plane.test',
        cookies: { [sessionCookieName()]: tenantSession },
      });
      expect(tenantSessionOnly).toMatchObject({
        status: 404,
        body: { error: { code: 'invitation_not_valid' } },
      });
    } finally {
      harness.teardown();
    }
  });

  it('refuses API-key callers without borrowing a user identity', async () => {
    installTestDomains({
      invitations: {
        recordAuditEvent: () => Promise.resolve(),
        sendInvitation: createManualLinkInvitationSender(),
      },
    });
    const harness = installRbacHarness(MEMBERS);
    try {
      const key = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
        name: 'invitation-test',
        role: conferredBy('owner', 'admin', 'invitation route test'),
        expiresAt: null,
      });
      if (key.kind !== 'created') throw new Error('key setup failed');
      const response = await harness.call(CREATE, {
        method: 'POST',
        path: '/api/invitations',
        as: null,
        bearer: key.presented,
        body: { email: 'invitee@example.test', role: 'viewer' },
      });
      expect(response.status).toBe(403);
      expect(response.text).toContain('api_key_not_permitted');
      expect(await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listInvitations()).toEqual([]);
    } finally {
      harness.teardown();
    }
  });

  it('refuses a lifecycle write when the session membership vanished instead of stamping the oldest Owner', async () => {
    const directory = createMemoryDirectory({ users: MEMBERS });
    const scoped = directory.forWorkspace(TEST_WORKSPACE_ID);
    const adminMembership = (await scoped.listMemberships()).find(
      (membership) => membership.email === 'admin@example.test',
    );
    if (adminMembership === undefined) throw new Error('admin membership setup failed');
    const deleted = await scoped.deleteMembership(adminMembership.id);
    expect(deleted.kind).toBe('deleted');

    const audit: InvitationAuditEvent[] = [];
    const result = await createInvitationHandler(
      scoped,
      await sessionPrincipal('admin@example.test', 'admin'),
      { email: 'recipient@example.test', role: 'viewer' },
      {
        recordAuditEvent: (event) => {
          audit.push(event);
          return Promise.resolve();
        },
        sendInvitation: createManualLinkInvitationSender(),
      },
    );

    expect(result).toMatchObject({
      status: 500,
      body: { error: { code: 'authorisation_undecidable' } },
    });
    expect(await scoped.listInvitations()).toEqual([]);
    expect(audit).toEqual([]);
  });
});
