import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { invitations } from '../../schema/invitations.js';
import { memberships } from '../../schema/memberships.js';
import { userIdentities } from '../../schema/user-identities.js';
import { users } from '../../schema/users.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import { workspaces } from '../../schema/workspaces.js';
import type { AcceptInvitationOutcome, DirectoryUserRecord } from '../directory.js';
import { INVITATION_COLUMNS, normaliseEmail, type Transaction, USER_COLUMNS } from './queries.js';

interface InvitationIdentity {
  readonly email: string;
  readonly issuer: string;
  readonly subject: string;
}

/** An OIDC identity as one value: the (issuer, subject) pair that binds to exactly one user. */
type OidcIdentity = Pick<InvitationIdentity, 'issuer' | 'subject'>;

/** Rolls back every acceptance write when a concurrent OIDC binding chose another user. */
class InvitationIdentityConflict extends Error {}

/**
 * A display name for a user this program is creating for the first time, with nothing else to
 * call them: the local part of their email, exactly as `apps/web/server/rbac/handlers.ts`'s
 * `createUser` requires one from its caller but `acceptInvitation` has
 * none to ask for — the invitee never fills in a form, they redeem a link. `users_name_not_blank`
 * still has to hold, so this can never be empty: a local part that is somehow blank falls back to
 * the whole address, which the shape check already guarantees is non-blank.
 */
function defaultDisplayName(email: string): string {
  const local = email.split('@')[0]?.trim();
  return local !== undefined && local !== '' ? local : email;
}

function nowOrLater(now: Date) {
  return sql`greatest(now(), ${now}::timestamptz)`;
}

async function selectBoundUserId(tx: Transaction, identity: OidcIdentity) {
  const rows = await tx
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(eq(userIdentities.issuer, identity.issuer), eq(userIdentities.subject, identity.subject)),
    )
    .limit(1);
  return rows[0]?.userId;
}

async function selectUserByEmail(tx: Transaction, email: string) {
  const rows = await tx.select(USER_COLUMNS).from(users).where(eq(users.email, email)).limit(1);
  return rows[0];
}

/**
 * One condition, one query: id, hash and email are checked together, so a wrong id, a
 * wrong hash and a wrong email are one and the same "no row" outcome rather than three
 * branches that could disagree about which is faster or which is logged. An archived
 * workspace is folded into that same absence: lifecycle state is part of the positive
 * admission query, not a later rejection that confirms the tenant exists. `FOR UPDATE`
 * serialises a concurrent replay of the same token against the same row.
 */
async function lockMatchingInvitation(
  tx: Transaction,
  id: string,
  tokenHash: string,
  email: string,
) {
  const rows = await tx
    .select({ ...INVITATION_COLUMNS, workspaceSlug: workspaces.slug })
    .from(invitations)
    .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
    .where(
      and(
        eq(invitations.id, id),
        eq(invitations.tokenHash, tokenHash),
        eq(invitations.email, email),
        isNull(workspaces.archivedAt),
      ),
    )
    .for('update')
    .limit(1);
  return rows[0];
}

type LockedInvitation = NonNullable<Awaited<ReturnType<typeof lockMatchingInvitation>>>;

/**
 * Every branch past the matching query already matched id, hash and email, so distinguishing them
 * reveals nothing about a workspace the caller could not already prove they were invited
 * to — the concealment property is the query, not these checks.
 */
function rejectedInvitationKind(invitation: LockedInvitation, now: Date) {
  if (invitation.revokedAt !== null) return 'revoked' as const;
  if (invitation.acceptedAt !== null) return 'already-accepted' as const;
  if (invitation.expiresAt.getTime() <= now.getTime()) return 'expired' as const;
  return undefined;
}

async function insertUserIfAbsent(tx: Transaction, email: string) {
  const existing = await selectUserByEmail(tx, email);
  if (existing !== undefined) return existing;
  const inserted = await tx
    .insert(users)
    .values({ email, name: defaultDisplayName(email) })
    .onConflictDoNothing({ target: users.email })
    .returning(USER_COLUMNS);
  return inserted[0] ?? (await selectUserByEmail(tx, email));
}

/** Binds a freshly resolved user to the OIDC identity, failing when a concurrent binder won. */
async function bindNewIdentity(tx: Transaction, email: string, identity: OidcIdentity) {
  const user = await insertUserIfAbsent(tx, email);
  if (user === undefined) throw new Error('invitation acceptance created no user row');

  await tx
    .insert(userIdentities)
    .values({ issuer: identity.issuer, subject: identity.subject, userId: user.id })
    .onConflictDoNothing({ target: [userIdentities.issuer, userIdentities.subject] });
  if ((await selectBoundUserId(tx, identity)) !== user.id) {
    throw new InvitationIdentityConflict();
  }
  return user;
}

/**
 * The OIDC binding is part of this transaction, never a callback-side provisional write. A
 * pre-existing binding must name the same global user as the invitation email. The post-insert
 * re-read handles a concurrent binder; throwing rolls back a user we may have inserted earlier in
 * this transaction instead of leaving residue from a refused accept. `undefined` means invalid.
 */
async function resolveInvitedUser(
  tx: Transaction,
  email: string,
  identity: OidcIdentity,
): Promise<DirectoryUserRecord | undefined> {
  const boundUserId = await selectBoundUserId(tx, identity);
  if (boundUserId === undefined) return bindNewIdentity(tx, email, identity);
  const boundUsers = await tx
    .select(USER_COLUMNS)
    .from(users)
    .where(and(eq(users.id, boundUserId), eq(users.email, email)))
    .limit(1);
  return boundUsers[0];
}

async function existingMembershipPrincipalId(
  tx: Transaction,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const rows = await tx
    .select({ principalId: workspacePrincipals.id })
    .from(memberships)
    .innerJoin(
      workspacePrincipals,
      and(
        eq(workspacePrincipals.workspaceId, memberships.workspaceId),
        eq(workspacePrincipals.membershipId, memberships.id),
        eq(workspacePrincipals.kind, 'membership'),
        isNull(workspacePrincipals.revokedAt),
      ),
    )
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error('existing invitation member has no exact principal');
  return row.principalId;
}

async function markInvitationAccepted(tx: Transaction, id: string, now: Date) {
  await tx
    .update(invitations)
    .set({ acceptedAt: nowOrLater(now) })
    .where(eq(invitations.id, id));
}

async function insertMembershipPrincipal(
  tx: Transaction,
  membershipId: string,
  workspaceId: string,
) {
  const inserted = await tx
    .insert(workspacePrincipals)
    .values({ workspaceId, kind: 'membership', membershipId })
    .returning({ principalId: workspacePrincipals.id });
  const principal = inserted[0];
  if (principal === undefined) throw new Error('membership principal insert returned no row');
  return principal;
}

interface AcceptRequest {
  readonly id: string;
  readonly tokenHash: string;
  readonly identity: InvitationIdentity;
  /** The normalised invitation email. */
  readonly email: string;
  readonly now: Date;
}

async function acceptInTransaction(
  tx: Transaction,
  request: AcceptRequest,
): Promise<AcceptInvitationOutcome> {
  const { id, tokenHash, identity, email, now } = request;
  const invitation = await lockMatchingInvitation(tx, id, tokenHash, email);
  if (invitation === undefined) return { kind: 'invalid' };
  const rejected = rejectedInvitationKind(invitation, now);
  if (rejected !== undefined) return { kind: rejected };

  const user = await resolveInvitedUser(tx, email, identity);
  if (user === undefined) return { kind: 'invalid' };

  const insertedMembership = await tx
    .insert(memberships)
    .values({ workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role })
    .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] })
    .returning({
      id: memberships.id,
      userId: memberships.userId,
      role: memberships.role,
      createdAt: memberships.createdAt,
    });
  const membershipRow = insertedMembership[0];
  if (membershipRow === undefined) {
    // The token is still consumed: a single-use link that failed only because the invitee
    // already has another way into the workspace must not stay live for a second attempt.
    const principalId = await existingMembershipPrincipalId(tx, invitation.workspaceId, user.id);
    await markInvitationAccepted(tx, id, now);
    return {
      kind: 'already-member',
      workspaceId: invitation.workspaceId,
      userId: user.id,
      principalId,
    };
  }

  const principal = await insertMembershipPrincipal(tx, membershipRow.id, invitation.workspaceId);
  await markInvitationAccepted(tx, id, now);
  return {
    kind: 'accepted',
    workspaceId: invitation.workspaceId,
    workspaceSlug: invitation.workspaceSlug,
    user,
    membership: { ...membershipRow, principalId: principal.principalId, email, name: user.name },
  };
}

/** Redeems an invitation in one atomic transaction; see `DatabaseDirectoryRoot.acceptInvitation`. */
export async function acceptInvitationTransaction(
  db: Database,
  id: string,
  tokenHash: string,
  identity: InvitationIdentity,
  now: Date,
): Promise<AcceptInvitationOutcome> {
  const email = normaliseEmail(identity.email);
  try {
    return await db.transaction((tx) =>
      acceptInTransaction(tx, { id, tokenHash, identity, email, now }),
    );
  } catch (error) {
    if (error instanceof InvitationIdentityConflict) return { kind: 'invalid' };
    throw error;
  }
}
