import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  invitations,
  memberships,
  type IsolatedTestDatabase,
  users,
  workspacePrincipals,
  workspaces,
} from '@agent-workspace/core/db/unscoped';
import { POST as ACCEPT } from '../../app/api/invitations/[id]/accept/route';
import { POST as RESEND } from '../../app/api/invitations/[id]/resend/route';
import { DELETE as REVOKE } from '../../app/api/invitations/[id]/route';
import { POST as CREATE } from '../../app/api/invitations/route';
import {
  invitationIdentityCookieName,
  mintInvitationIdentityToken,
  mintSessionToken,
  newSessionClaims,
  verifySessionToken,
} from '../auth';
import { createPostgresDirectory } from '../rbac/postgres-directory';
import { Principal } from '../rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../rbac/runtime';
import { clearInvitationsRuntime, configureInvitationsRuntime } from './runtime';
import { createManualLinkInvitationSender } from './send-invitation';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
const SECRET = 'postgres-redaction-session-secret-long-enough';
const ISSUER = 'https://issuer.example.test';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected response object');
  }
  return value as Record<string, unknown>;
}

describe.skipIf(!hasDatabase)('full PostgreSQL invitation and audit redaction', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  let workspaceId: string;
  let workspaceSlug: string;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_invitation_full_redaction');
    workspaceId = crypto.randomUUID();
    workspaceSlug = `redaction-${crypto.randomUUID()}`;
    const ownerId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: workspaceSlug,
      name: 'Full redaction',
    });
    await isolated.db.insert(users).values({
      id: ownerId,
      email: 'owner@example.test',
      name: 'Owner',
    });
    const membershipId = '1a33d449-ac39-4bf8-9804-63bbd69c1463';
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId, userId: ownerId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: 'b267020f-254a-426a-be38-bbb10031cc77',
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    delete process.env['SESSION_SECRET'];
    clearInvitationsRuntime();
    clearRbacRuntime();
    vi.restoreAllMocks();
    await root.close();
    await isolated.close();
  });

  it('retains the plaintext in no invitation row, audit row, or log across create and accept', async () => {
    process.env['SESSION_SECRET'] = SECRET;
    const directory = createPostgresDirectory(root.directory);
    const sessionToken = await mintSessionToken(
      newSessionClaims('owner@example.test', workspaceSlug),
      SECRET,
    );
    const verified = await verifySessionToken(sessionToken, SECRET);
    if (!verified.ok) throw new Error('session setup failed');
    const membership = (await directory.forWorkspace(workspaceId).listMemberships()).find(
      (candidate) => candidate.email === 'owner@example.test',
    );
    if (membership === undefined) throw new Error('membership setup failed');
    const built = Principal.fromSession(
      verified.claims,
      { id: workspaceId, slug: workspaceSlug },
      'owner',
      {
        principalId: membership.principalId,
        userId: membership.userId,
        label: membership.name,
      },
    );
    if (!built.ok) throw new Error('principal setup failed');
    configureRbacRuntime({ directory, identify: () => Promise.resolve(built.principal) });
    configureInvitationsRuntime({
      recordAuditEvent: (event) => root.recordAuditEvent(event),
      sendInvitation: createManualLinkInvitationSender(),
    });

    const logs: unknown[][] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    }

    const createdResponse = await CREATE(
      new Request('https://control-plane.test/api/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new-user@example.test', role: 'viewer' }),
      }),
    );
    expect(createdResponse.status).toBe(201);
    const createdBody = object(await createdResponse.json());
    const token = createdBody['token'];
    const invitation = object(createdBody['invitation']);
    const id = invitation['id'];
    if (typeof token !== 'string' || typeof id !== 'string')
      throw new Error('create omitted secret');

    const identityCookie = await mintInvitationIdentityToken(
      { email: 'new-user@example.test', issuer: ISSUER, subject: 'new-user-subject' },
      SECRET,
    );
    const malformedId = 'not-a-uuid';
    const malformedRequests = [
      RESEND(
        new Request(`https://control-plane.test/api/invitations/${malformedId}/resend`, {
          method: 'POST',
        }),
        { params: Promise.resolve({ id: malformedId }) },
      ),
      REVOKE(
        new Request(`https://control-plane.test/api/invitations/${malformedId}`, {
          method: 'DELETE',
        }),
        { params: Promise.resolve({ id: malformedId }) },
      ),
      ACCEPT(
        new Request(`https://control-plane.test/api/invitations/${malformedId}/accept`, {
          method: 'POST',
          headers: {
            host: 'control-plane.test',
            origin: 'https://control-plane.test',
            cookie: `${invitationIdentityCookieName()}=${identityCookie}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token }),
        }),
        { params: Promise.resolve({ id: malformedId }) },
      ),
    ];
    for (const malformed of await Promise.all(malformedRequests)) {
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain('22P02');
    }
    const acceptRequest = () =>
      new Request(`https://control-plane.test/api/invitations/${id}/accept`, {
        method: 'POST',
        headers: {
          host: 'control-plane.test',
          origin: 'https://control-plane.test',
          cookie: `${invitationIdentityCookieName()}=${identityCookie}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });
    const accepted = await ACCEPT(acceptRequest(), { params: Promise.resolve({ id }) });
    expect(accepted.status).toBe(200);
    const replay = await ACCEPT(acceptRequest(), { params: Promise.resolve({ id }) });
    expect(replay.status).toBe(409);

    const invitationRows = await isolated.db.select().from(invitations);
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('scope setup failed');
    const auditRows = (await root.auditEventRepository.forScope(scope).list()).items;
    expect(auditRows.map((row) => row.action)).toEqual([
      'invitation-accepted',
      'invitation-created',
    ]);
    expect(JSON.stringify(invitationRows)).not.toContain(token);
    expect(JSON.stringify(auditRows)).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain(token);
    const acceptedUser = await root.directory.findUserByEmail('new-user@example.test');
    expect(acceptedUser).not.toBeNull();
    expect(await root.directory.membershipsForUser(acceptedUser?.id ?? '')).toEqual([
      expect.objectContaining({ workspaceId, role: 'viewer' }),
    ]);
  });
});
