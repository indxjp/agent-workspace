import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { invitations } from '../schema/invitations.js';
import { memberships } from '../schema/memberships.js';
import { userIdentities } from '../schema/user-identities.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseDirectoryRoot } from './directory.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

function identity(email: string) {
  return { email, issuer: 'https://issuer.example.test', subject: `subject:${email}` };
}

describe.skipIf(!hasDatabase)('PostgreSQL invitation lifecycle', () => {
  let isolated: IsolatedTestDatabase;
  let workspaceId: string;
  let ownerId: string;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_directory_invitations');
    workspaceId = crypto.randomUUID();
    ownerId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: `invite-${crypto.randomUUID()}`,
      name: 'Invitations',
    });
    await isolated.db
      .insert(users)
      .values({ id: ownerId, email: `${ownerId}@example.test`, name: 'Owner' });
    await isolated.db.insert(memberships).values({ workspaceId, userId: ownerId, role: 'owner' });
  }, 180_000);

  afterAll(async () => isolated.close());

  function pendingInput(email: string, tokenHash: string) {
    return {
      email,
      role: 'viewer' as const,
      invitedBy: ownerId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  it('lets exactly one concurrent normalised duplicate invitation survive', async () => {
    const repository = createDatabaseDirectoryRoot(isolated.db).forWorkspace(workspaceId);
    const local = crypto.randomUUID();
    const [first, second] = await Promise.all([
      repository.createInvitation(pendingInput(`${local}@example.test`, 'hash-one')),
      repository.createInvitation(
        pendingInput(` ${local.toUpperCase()}@EXAMPLE.TEST `, 'hash-two'),
      ),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(['already-invited', 'created']);
    const rows = await isolated.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          eq(invitations.email, `${local}@example.test`),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('accepts a new user and membership atomically once under concurrent replay', async () => {
    const root = createDatabaseDirectoryRoot(isolated.db);
    const email = `${crypto.randomUUID()}@example.test`;
    const tokenHash = `hash-${crypto.randomUUID()}`;
    const created = await root
      .forWorkspace(workspaceId)
      .createInvitation(pendingInput(email, tokenHash));
    if (created.kind !== 'created') throw new Error('setup failed');

    const outcomes = await Promise.all([
      root.acceptInvitation(created.invitation.id, tokenHash, identity(email), new Date()),
      root.acceptInvitation(created.invitation.id, tokenHash, identity(email), new Date()),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      'accepted',
      'already-accepted',
    ]);
    const acceptedOutcome = outcomes.find((outcome) => outcome.kind === 'accepted');
    expect(acceptedOutcome?.kind).toBe('accepted');
    if (acceptedOutcome?.kind !== 'accepted') throw new Error('no acceptance won the replay race');
    expect(acceptedOutcome.workspaceSlug).toMatch(/^invite-/u);

    const userRows = await isolated.db.select().from(users).where(eq(users.email, email));
    expect(userRows).toHaveLength(1);
    const acceptedUser = userRows[0];
    if (acceptedUser === undefined) throw new Error('accepted user was not persisted');
    const memberRows = await isolated.db
      .select()
      .from(memberships)
      .where(
        and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, acceptedUser.id)),
      );
    expect(memberRows).toHaveLength(1);
    expect(
      await isolated.db
        .select({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.issuer, identity(email).issuer),
            eq(userIdentities.subject, identity(email).subject),
          ),
        ),
    ).toEqual([{ userId: acceptedUser.id }]);
  });

  it('refuses a conflicting issuer-subject binding without leaving user, membership, or acceptance writes', async () => {
    const root = createDatabaseDirectoryRoot(isolated.db);
    const email = `${crypto.randomUUID()}@example.test`;
    const tokenHash = `hash-${crypto.randomUUID()}`;
    const created = await root
      .forWorkspace(workspaceId)
      .createInvitation(pendingInput(email, tokenHash));
    if (created.kind !== 'created') throw new Error('setup failed');

    const otherUserId = crypto.randomUUID();
    await isolated.db.insert(users).values({
      id: otherUserId,
      email: `${otherUserId}@example.test`,
      name: 'Other identity',
    });
    const conflicting = identity(email);
    await isolated.db.insert(userIdentities).values({
      issuer: conflicting.issuer,
      subject: conflicting.subject,
      userId: otherUserId,
    });

    expect(
      await root.acceptInvitation(created.invitation.id, tokenHash, conflicting, new Date()),
    ).toEqual({ kind: 'invalid' });
    expect(await isolated.db.select().from(users).where(eq(users.email, email))).toEqual([]);
    expect(
      await isolated.db.select().from(memberships).where(eq(memberships.workspaceId, workspaceId)),
    ).not.toContainEqual(expect.objectContaining({ userId: otherUserId }));
    expect(
      await isolated.db
        .select({ acceptedAt: invitations.acceptedAt })
        .from(invitations)
        .where(eq(invitations.id, created.invitation.id)),
    ).toEqual([{ acceptedAt: null }]);
  });

  it('reuses an existing user and consumes the token when that user is already a member', async () => {
    const root = createDatabaseDirectoryRoot(isolated.db);
    const existingId = crypto.randomUUID();
    const email = `${existingId}@example.test`;
    await isolated.db.insert(users).values({ id: existingId, email, name: 'Existing' });

    const firstHash = `hash-${crypto.randomUUID()}`;
    const first = await root
      .forWorkspace(workspaceId)
      .createInvitation(pendingInput(email, firstHash));
    if (first.kind !== 'created') throw new Error('setup failed');
    const accepted = await root.acceptInvitation(
      first.invitation.id,
      firstHash,
      identity(email),
      new Date(),
    );
    expect(accepted).toMatchObject({ kind: 'accepted', user: { id: existingId } });
    if (accepted.kind !== 'accepted') throw new Error('setup failed');

    const secondHash = `hash-${crypto.randomUUID()}`;
    const second = await root
      .forWorkspace(workspaceId)
      .createInvitation(pendingInput(email, secondHash));
    if (second.kind !== 'created') throw new Error('setup failed');
    expect(
      await root.acceptInvitation(second.invitation.id, secondHash, identity(email), new Date()),
    ).toEqual({
      kind: 'already-member',
      workspaceId,
      userId: existingId,
      principalId: accepted.membership.principalId,
    });
    expect(
      await root.acceptInvitation(second.invitation.id, secondHash, identity(email), new Date()),
    ).toEqual({ kind: 'already-accepted' });
  });

  it('rotates on resend, and guarded lifecycle writes report the committed terminal state', async () => {
    const root = createDatabaseDirectoryRoot(isolated.db);
    const repository = root.forWorkspace(workspaceId);
    const email = `${crypto.randomUUID()}@example.test`;
    const oldHash = `old-${crypto.randomUUID()}`;
    const newHash = `new-${crypto.randomUUID()}`;
    const created = await repository.createInvitation(pendingInput(email, oldHash));
    if (created.kind !== 'created') throw new Error('setup failed');

    const resent = await repository.resendInvitation(
      created.invitation.id,
      newHash,
      new Date(Date.now() + 120_000),
    );
    expect(resent).toMatchObject({ kind: 'resent', invitation: { tokenHash: newHash } });
    expect(
      await root.acceptInvitation(created.invitation.id, oldHash, identity(email), new Date()),
    ).toEqual({ kind: 'invalid' });
    expect(
      await root.acceptInvitation(created.invitation.id, newHash, identity(email), new Date()),
    ).toMatchObject({ kind: 'accepted' });
    expect(
      await repository.resendInvitation(
        created.invitation.id,
        `later-${crypto.randomUUID()}`,
        new Date(Date.now() + 180_000),
      ),
    ).toMatchObject({ kind: 'already-accepted' });
    expect(await repository.revokeInvitation(created.invitation.id, new Date())).toMatchObject({
      kind: 'already-accepted',
    });
  });

  it('folds archived workspace acceptance into the same invalid result as a random id', async () => {
    const root = createDatabaseDirectoryRoot(isolated.db);
    const repository = root.forWorkspace(workspaceId);
    const email = `${crypto.randomUUID()}@example.test`;
    const tokenHash = `hash-${crypto.randomUUID()}`;
    const created = await repository.createInvitation(pendingInput(email, tokenHash));
    if (created.kind !== 'created') throw new Error('setup failed');

    await isolated.db
      .update(workspaces)
      .set({ archivedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
    const archived = await root.acceptInvitation(
      created.invitation.id,
      tokenHash,
      identity(email),
      new Date(),
    );
    const random = await root.acceptInvitation(
      crypto.randomUUID(),
      tokenHash,
      identity(email),
      new Date(),
    );
    expect(archived).toEqual({ kind: 'invalid' });
    expect(archived).toEqual(random);
    expect(await isolated.db.select().from(users).where(eq(users.email, email))).toHaveLength(0);

    await isolated.db
      .update(workspaces)
      .set({ archivedAt: null })
      .where(eq(workspaces.id, workspaceId));
  });

  it('refuses expired, revoked, wrong-email, and foreign-workspace operations deterministically', async () => {
    const root = createDatabaseDirectoryRoot(isolated.db);
    const repository = root.forWorkspace(workspaceId);
    const email = `${crypto.randomUUID()}@example.test`;
    const tokenHash = `hash-${crypto.randomUUID()}`;
    const created = await repository.createInvitation(pendingInput(email, tokenHash));
    if (created.kind !== 'created') throw new Error('setup failed');

    expect(
      await root.acceptInvitation(
        created.invitation.id,
        tokenHash,
        identity('other@example.test'),
        new Date(),
      ),
    ).toEqual({ kind: 'invalid' });
    expect(
      await root.acceptInvitation(
        created.invitation.id,
        tokenHash,
        identity(email),
        new Date(Date.now() + 120_000),
      ),
    ).toEqual({ kind: 'expired' });

    const revokedEmail = `${crypto.randomUUID()}@example.test`;
    const revokedHash = `hash-${crypto.randomUUID()}`;
    const revoked = await repository.createInvitation(pendingInput(revokedEmail, revokedHash));
    if (revoked.kind !== 'created') throw new Error('setup failed');
    expect(await repository.revokeInvitation(revoked.invitation.id, new Date())).toMatchObject({
      kind: 'revoked',
    });
    expect(
      await root.acceptInvitation(
        revoked.invitation.id,
        revokedHash,
        identity(revokedEmail),
        new Date(),
      ),
    ).toEqual({ kind: 'revoked' });

    const foreignWorkspace = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({
      id: foreignWorkspace,
      slug: `foreign-${crypto.randomUUID()}`,
      name: 'Foreign',
    });
    const foreign = root.forWorkspace(foreignWorkspace);
    expect(await foreign.listInvitations()).toEqual([]);
    expect(await foreign.resendInvitation(revoked.invitation.id, 'x', new Date())).toEqual({
      kind: 'no-such-invitation',
      id: revoked.invitation.id,
    });
    expect(await foreign.revokeInvitation(revoked.invitation.id, new Date())).toEqual({
      kind: 'no-such-invitation',
      id: revoked.invitation.id,
    });
  });
});
