import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { POST as ACCEPT } from '../../app/api/invitations/[id]/accept/route';
import { POST as RESEND } from '../../app/api/invitations/[id]/resend/route';
import { DELETE as REVOKE } from '../../app/api/invitations/[id]/route';
import { POST as CREATE } from '../../app/api/invitations/route';
import { installTestDomains } from '../application-context-fixtures';
import { invitationIdentityCookieName, mintInvitationIdentityToken } from '../auth';
import { conferredBy } from '../rbac/core/conferral';
import { TEST_WORKSPACE_ID } from '../rbac/testing';
import {
  IDENTITY_ISSUER,
  installInvitationHarness,
  invitationCreation,
  TEST_SESSION_SECRET,
} from './invitation-routes.test-support';
import { createManualLinkInvitationSender } from './send-invitation';

export function registerValidationTests(env: NodeJS.ProcessEnv) {
  it('rejects undeclared fields on every invitation JSON body before any state change', () =>
    rejectsUndeclaredFieldsEveryInvitationJSONBodyBefore(env));

  it('rejects every malformed dynamic invitation id before a repository call', () =>
    rejectsEveryMalformedDynamicInvitationIdBeforeRepository(env));

  it(
    'makes foreign and nonexistent resend and revoke responses byte-identical',
    makesForeignNonexistentResendRevokeResponsesByteIdentical,
  );
}

async function rejectsUndeclaredFieldsEveryInvitationJSONBodyBefore(env: NodeJS.ProcessEnv) {
  env['SESSION_SECRET'] = TEST_SESSION_SECRET;
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
}

async function rejectsEveryMalformedDynamicInvitationIdBeforeRepository(env: NodeJS.ProcessEnv) {
  env['SESSION_SECRET'] = TEST_SESSION_SECRET;
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
}

async function makesForeignNonexistentResendRevokeResponsesByteIdentical() {
  installTestDomains({
    invitations: {
      recordAuditEvent: () => Promise.resolve(),
      sendInvitation: createManualLinkInvitationSender(),
    },
  });
  const harness = installInvitationHarness();
  try {
    const owner = (await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships()).find(
      (membership) => membership.email === 'owner@example.test',
    );
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
}
