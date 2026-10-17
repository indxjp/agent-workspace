import crypto from 'node:crypto';

import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiKeys } from '../schema/api-keys.js';
import { auditEvents } from '../schema/audit-events.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { createDatabaseDirectoryRoot } from './directory.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = (process.env['TEST_DATABASE_URL'] ?? '').trim() !== '';

describe.skipIf(!hasDatabase)('workspace principal repository lifecycle', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const memberUserId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_rf101_principal_repository');
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: `rf101-${workspaceId.slice(0, 8)}`,
      name: 'RF-101 repository tests',
    });
    await isolated.db.insert(users).values({
      id: memberUserId,
      email: 'member@example.test',
      name: 'Member',
    });
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  it('creates a Membership and its exact principal atomically', async () => {
    const root = createDatabaseDirectoryRoot(isolated.db);
    const directory = root.forWorkspace(workspaceId);
    const created = await directory.createMembership({
      email: 'member@example.test',
      role: 'builder',
    });

    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error(created.kind);
    const rows = await isolated.db
      .select()
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.id, created.membership.principalId));
    expect(rows).toEqual([
      expect.objectContaining({
        id: created.membership.principalId,
        workspaceId,
        kind: 'membership',
        membershipId: created.membership.id,
        apiKeyId: null,
        revokedAt: null,
      }),
    ]);

    const duplicate = await directory.createMembership({
      email: 'member@example.test',
      role: 'viewer',
    });
    expect(duplicate).toEqual({ kind: 'already-a-member', email: 'member@example.test' });
    const totals = await isolated.db
      .select({ value: count() })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.membershipId, created.membership.id));
    expect(Number(totals[0]?.value)).toBe(1);
    await expect(root.membershipsForUser(memberUserId)).resolves.toEqual([
      expect.objectContaining({
        principalId: created.membership.principalId,
        workspaceId,
        role: 'builder',
      }),
    ]);
  });

  it('authenticates an API key as its exact principal and revokes both in one transaction', async () => {
    const root = createDatabaseDirectoryRoot(isolated.db);
    const directory = root.forWorkspace(workspaceId);
    const keyHash = crypto.createHash('sha256').update('rf101-secret').digest('hex');
    const created = await directory.createApiKey({
      name: 'automation',
      role: 'builder',
      keyPrefix: 'ak_live_rf101',
      keyHash,
      expiresAt: null,
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error(created.kind);

    await expect(root.authenticateApiKeyHash(keyHash, new Date())).resolves.toMatchObject({
      id: created.key.id,
      principalId: created.key.principalId,
      workspaceId,
      role: 'builder',
    });

    const revoked = await directory.revokeApiKey(created.key.id, new Date());
    expect(revoked.kind).toBe('revoked');
    if (revoked.kind !== 'revoked') throw new Error(revoked.kind);
    const [principal] = await isolated.db
      .select({ revokedAt: workspacePrincipals.revokedAt })
      .from(workspacePrincipals)
      .where(
        and(
          eq(workspacePrincipals.id, created.key.principalId),
          eq(workspacePrincipals.apiKeyId, created.key.id),
        ),
      );
    expect(principal?.revokedAt?.getTime()).toBe(revoked.key.revokedAt?.getTime());
    await expect(root.authenticateApiKeyHash(keyHash, new Date())).resolves.toBeNull();

    const [stored] = await isolated.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.id, created.key.id));
    expect(stored?.id).toBe(created.key.id);
  });

  it('createUser returns the principal created with its Membership', async () => {
    const directory = createDatabaseDirectoryRoot(isolated.db).forWorkspace(workspaceId);
    const created = await directory.createUser({
      email: 'new-user@example.test',
      name: 'New User',
      role: 'viewer',
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error(created.kind);
    const [source] = await isolated.db
      .select({ membershipId: workspacePrincipals.membershipId })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.id, created.membership.principalId));
    expect(source?.membershipId).toBe(created.membership.id);

    const [membership] = await isolated.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.id, created.membership.id));
    expect(membership?.id).toBe(created.membership.id);
  });

  it('retains an audit event and its workspace when its membership principal is deleted', async () => {
    const directory = createDatabaseDirectoryRoot(isolated.db).forWorkspace(workspaceId);
    const created = await directory.createUser({
      email: 'audited-member@example.test',
      name: 'Audited Member',
      role: 'viewer',
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error(created.kind);

    const eventId = crypto.randomUUID();
    await isolated.db.insert(auditEvents).values({
      id: eventId,
      workspaceId,
      actorUserId: created.user.id,
      actorPrincipalId: created.membership.principalId,
      actorLabel: created.user.name,
      action: 'permission-changed',
      subjectId: created.membership.id,
      subjectLabel: created.user.name,
    });

    await isolated.db.delete(memberships).where(eq(memberships.id, created.membership.id));

    await expect(
      isolated.db
        .select({
          workspaceId: auditEvents.workspaceId,
          actorPrincipalId: auditEvents.actorPrincipalId,
          actorLabel: auditEvents.actorLabel,
        })
        .from(auditEvents)
        .where(eq(auditEvents.id, eventId)),
    ).resolves.toEqual([
      {
        workspaceId,
        actorPrincipalId: null,
        actorLabel: created.user.name,
      },
    ]);
  });
});
