import { expect, it } from 'vitest';
import { POST as RESEND } from '../../app/api/invitations/[id]/resend/route';
import { DELETE as REVOKE } from '../../app/api/invitations/[id]/route';
import { POST as CREATE, GET as LIST } from '../../app/api/invitations/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { installInvitationHarness, invitationCreation } from './invitation-routes.test-support';
import type { InvitationAuditEvent } from './runtime';
import { createManualLinkInvitationSender } from './send-invitation';

export function registerManagementTests() {
  it(
    'answers 503 rbac_runtime_not_configured while no context is installed',
    answers503RbacRuntimeNotConfiguredWhileNo,
  );

  it(
    'returns a token once, rotates it on resend, and redacts every list and audit shape',
    returnsTokenOnceRotatesItResendRedactsEvery,
  );

  it(
    'applies conferral dominance to Admin and route grants to Builder and Viewer',
    appliesConferralDominanceAdminRouteGrantsBuilderViewer,
  );
}

async function answers503RbacRuntimeNotConfiguredWhileNo() {
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
}

async function returnsTokenOnceRotatesItResendRedactsEvery() {
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
}

async function appliesConferralDominanceAdminRouteGrantsBuilderViewer() {
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
}
