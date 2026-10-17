import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  memberships,
  type IsolatedTestDatabase,
  users,
  workspaces,
  workspacePrincipals,
} from '@agent-workspace/core/db/unscoped';
import { POST as CREATE } from '../../app/api/invitations/route';
import { installRbacHarness } from '../rbac/testing';
import { clearInvitationsRuntime, configureInvitationsRuntime } from './runtime';
import { createManualLinkInvitationSender } from './send-invitation';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

function tokenFrom(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('creation response was not an object');
  }
  const token = (body as Record<string, unknown>)['token'];
  if (typeof token !== 'string') throw new Error('creation response omitted the token');
  return token;
}

describe.skipIf(!hasDatabase)('invitation audit redaction', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  let workspaceId: string;
  let ownerId: string;
  let ownerPrincipalId: string;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_invitation_audit_redaction');
    workspaceId = crypto.randomUUID();
    ownerId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    ownerPrincipalId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: `audit-${crypto.randomUUID()}`,
      name: 'Audit redaction',
    });
    await isolated.db.insert(users).values({
      id: ownerId,
      email: 'audit-owner@example.test',
      name: 'Audit owner',
    });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: membershipId,
        workspaceId,
        userId: ownerId,
        role: 'owner',
      });
      await tx.insert(workspacePrincipals).values({
        id: ownerPrincipalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    clearInvitationsRuntime();
    vi.restoreAllMocks();
    await root.close();
    await isolated.close();
  });

  it('writes an audit row and no log line containing the presented token', async () => {
    const logs: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });

    configureInvitationsRuntime({
      recordAuditEvent: (event) => root.recordAuditEvent(event),
      sendInvitation: createManualLinkInvitationSender(),
    });
    const harness = installRbacHarness(
      [
        {
          id: ownerId,
          principalId: ownerPrincipalId,
          email: 'audit-owner@example.test',
          name: 'Audit owner',
          workspaceId,
          role: 'owner',
        },
      ],
      { workspaceId, workspaceSlug: 'audit-redaction', newId: crypto.randomUUID },
    );
    try {
      const response = await harness.call(CREATE, {
        method: 'POST',
        path: '/api/invitations',
        as: { email: 'audit-owner@example.test' },
        body: { email: 'recipient@example.test', role: 'viewer' },
      });
      expect(response.status, response.text).toBe(201);
      const token = tokenFrom(response.body);

      const scope = await root.scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error('workspace scope was not resolved');
      const rows = (await root.auditEventRepository.forScope(scope).list()).items;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'invitation-created',
        actorUserId: ownerId,
      });
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(JSON.stringify(logs)).not.toContain(token);
    } finally {
      harness.teardown();
    }
  });
});
