import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { POST as ACCEPT } from '../../app/api/invitations/[id]/accept/route';
import { POST as CREATE } from '../../app/api/invitations/route';
import { installTestDomains } from '../application-context-fixtures';
import { sessionCookieName } from '../auth';
import { mintSessionToken, newSessionClaims } from '../auth/session';
import { conferredBy } from '../rbac/core/conferral';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { installRbacHarness, TEST_WORKSPACE_ID } from '../rbac/testing';
import { createInvitation as createInvitationHandler } from './handlers';
import {
  installInvitationHarness,
  MEMBERS,
  sessionPrincipal,
  TEST_SESSION_SECRET,
} from './invitation-routes.test-support';
import type { InvitationAuditEvent } from './runtime';
import { createManualLinkInvitationSender } from './send-invitation';

export function registerIdentityTests(env: NodeJS.ProcessEnv) {
  it('requires the application origin and dedicated identity cookie before reading an invitation', () =>
    requiresApplicationOriginDedicatedIdentityCookieBeforeReading(env));

  it(
    'refuses API-key callers without borrowing a user identity',
    refusesAPIKeyCallersWithoutBorrowingUserIdentity,
  );

  it(
    'refuses a lifecycle write when the session membership vanished instead of stamping the oldest Owner',
    refusesLifecycleWriteWhenSessionMembershipVanishedInstead,
  );
}

async function requiresApplicationOriginDedicatedIdentityCookieBeforeReading(
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
}

async function refusesAPIKeyCallersWithoutBorrowingUserIdentity() {
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
}

async function refusesLifecycleWriteWhenSessionMembershipVanishedInstead() {
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
}
