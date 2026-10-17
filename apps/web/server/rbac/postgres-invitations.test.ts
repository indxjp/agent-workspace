import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  invitations,
  memberships,
  type IsolatedTestDatabase,
  users,
  workspaces,
} from '@agent-workspace/core/db/unscoped';
import { conferredBy } from './conferral';
import { createPostgresDirectory } from './postgres-directory';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

function identity(email: string) {
  return { email, issuer: 'https://issuer.example.test', subject: `subject:${email}` };
}

describe.skipIf(!hasDatabase)('PostgreSQL invitation adapter', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  let workspaceId: string;
  let ownerId: string;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_postgres_invitations');
    workspaceId = crypto.randomUUID();
    ownerId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: `adapter-${crypto.randomUUID()}`,
      name: 'Invitation adapter',
    });
    await isolated.db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      name: 'Owner',
    });
    await isolated.db.insert(memberships).values({
      workspaceId,
      userId: ownerId,
      role: 'owner',
    });
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await root.close();
    await isolated.close();
  });

  it('persists only a hash, rotates it on resend, and survives a database-root restart', async () => {
    let directory = createPostgresDirectory(root.directory);
    const email = `${crypto.randomUUID()}@example.test`;
    const created = await directory.forWorkspace(workspaceId).createInvitation({
      email,
      role: conferredBy('owner', 'viewer', 'PostgreSQL invitation adapter test'),
      invitedBy: ownerId,
    });
    if (created.kind !== 'created') throw new Error('setup failed');

    const storedBefore = (await isolated.db.select().from(invitations)).filter(
      (row) => row.id === created.invitation.id,
    );
    expect(storedBefore).toHaveLength(1);
    expect(storedBefore[0]?.tokenHash).not.toBe(created.token);
    expect(JSON.stringify(storedBefore)).not.toContain(created.token);

    const resent = await directory
      .forWorkspace(workspaceId)
      .resendInvitation(created.invitation.id);
    if (resent.kind !== 'resent') throw new Error('resend failed');
    const storedAfter = (await isolated.db.select().from(invitations)).filter(
      (row) => row.id === created.invitation.id,
    );
    expect(storedAfter[0]?.tokenHash).not.toBe(storedBefore[0]?.tokenHash);
    expect(JSON.stringify(storedAfter)).not.toContain(resent.token);
    expect(
      await directory.acceptInvitation(created.invitation.id, created.token, identity(email)),
    ).toEqual({ kind: 'invalid' });

    await root.close();
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    directory = createPostgresDirectory(root.directory);
    expect(
      await directory.acceptInvitation(created.invitation.id, resent.token, identity(email)),
    ).toMatchObject({ kind: 'accepted', workspaceId });
    expect(
      await directory.acceptInvitation(created.invitation.id, resent.token, identity(email)),
    ).toEqual({ kind: 'already-accepted' });
  });
});
