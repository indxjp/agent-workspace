import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { apiKeys } from '../../schema/api-keys.js';
import { invitations } from '../../schema/invitations.js';
import { memberships } from '../../schema/memberships.js';
import { userIdentities } from '../../schema/user-identities.js';
import { users } from '../../schema/users.js';
import { workspaces } from '../../schema/workspaces.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import type { DatabaseDirectoryRoot, DirectoryUserRecord } from '../directory.js';
import {
  endpointBindings,
  INVITATION_COLUMNS,
  isActiveMembershipPrincipal,
  isConstraint,
  KEY_COLUMNS,
  KEY_ROW_COLUMNS,
  normaliseEmail,
  USER_COLUMNS,
} from './queries.js';

/**
 * A display name for a user this program is creating for the first time, with nothing else to
 * call them: the local part of their email, exactly as `apps/web/server/rbac/handlers.ts`'s
 * `createUser` requires one from its caller but {@link DatabaseDirectoryRoot.acceptInvitation} has
 * none to ask for — the invitee never fills in a form, they redeem a link. `users_name_not_blank`
 * still has to hold, so this can never be empty: a local part that is somehow blank falls back to
 * the whole address, which the shape check already guarantees is non-blank.
 */
function defaultDisplayName(email: string): string {
  const local = email.split('@')[0]?.trim();
  return local !== undefined && local !== '' ? local : email;
}

/** Rolls back every acceptance write when a concurrent OIDC binding chose another user. */
class InvitationIdentityConflict extends Error {}

export function createDatabaseDirectoryRootQueries(
  db: Database,
): Omit<DatabaseDirectoryRoot, 'forWorkspace'> {
  return {
    async authenticateApiKeyHash(keyHash, now) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select(KEY_COLUMNS)
          .from(apiKeys)
          .innerJoin(
            workspacePrincipals,
            and(
              eq(workspacePrincipals.workspaceId, apiKeys.workspaceId),
              eq(workspacePrincipals.apiKeyId, apiKeys.id),
            ),
          )
          .where(
            and(
              eq(apiKeys.keyHash, keyHash),
              isNull(apiKeys.revokedAt),
              isNull(workspacePrincipals.revokedAt),
              or(
                isNull(apiKeys.expiresAt),
                gt(apiKeys.expiresAt, sql`greatest(now(), ${now}::timestamptz)`),
              ),
            ),
          )
          .limit(1);
        const key = rows[0];
        if (key === undefined) return null;
        // A key that acts for a person never outlives that person's principal or membership.
        if (
          key.actsForPrincipalId !== null &&
          !(await isActiveMembershipPrincipal(tx, key.workspaceId, key.actsForPrincipalId))
        ) {
          return null;
        }
        // An endpoint-bound key authenticates only while its client is live and still names a
        // target; a deleted agent cascades its row away, which fails closed here.
        const binding = (await endpointBindings(tx, key.workspaceId, key.id)).get(key.id);
        if (binding !== undefined && (binding.scope === null || binding.clientRevokedAt !== null)) {
          return null;
        }
        const updated = await tx
          .update(apiKeys)
          .set({ lastUsedAt: sql`greatest(now(), ${now}::timestamptz)` })
          .where(eq(apiKeys.id, key.id))
          .returning(KEY_ROW_COLUMNS);
        const updatedKey = updated[0];
        return updatedKey === undefined
          ? null
          : {
              ...updatedKey,
              principalId: key.principalId,
              actsForPrincipalId: key.actsForPrincipalId,
              endpointScope: binding?.scope ?? null,
            };
      });
    },
    async resolveRole(email, workspaceId) {
      const rows = await db
        .select({ role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(eq(memberships.workspaceId, workspaceId), eq(users.email, normaliseEmail(email))),
        )
        .limit(1);
      return rows[0]?.role ?? null;
    },
    async principalById(workspaceId, principalId) {
      const principalRows = await db
        .select({
          kind: workspacePrincipals.kind,
          membershipId: workspacePrincipals.membershipId,
          apiKeyId: workspacePrincipals.apiKeyId,
          actsForPrincipalId: workspacePrincipals.actsForPrincipalId,
        })
        .from(workspacePrincipals)
        .where(
          and(
            eq(workspacePrincipals.workspaceId, workspaceId),
            eq(workspacePrincipals.id, principalId),
            isNull(workspacePrincipals.revokedAt),
          ),
        )
        .limit(1);
      const principal = principalRows[0];
      if (principal === undefined) return null;
      if (principal.kind === 'membership') {
        if (principal.membershipId === null) {
          throw new Error(
            `workspace_principals ${principalId} is kind 'membership' with a null membership_id; ` +
              'the source XOR check should make this unreachable.',
          );
        }
        const rows = await db
          .select({ role: memberships.role, userId: users.id, name: users.name })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.workspaceId, workspaceId),
              eq(memberships.id, principal.membershipId),
            ),
          )
          .limit(1);
        const row = rows[0];
        // The explicit else: a membership row removed since the principal was minted is not
        // re-read as some stale role, it is "this principal does not authenticate any more".
        if (row === undefined) return null;
        return {
          principalId,
          kind: 'membership',
          role: row.role,
          label: row.name,
          userId: row.userId,
          apiKeyId: null,
          actsForPrincipalId: null,
        };
      }
      if (principal.apiKeyId === null) {
        throw new Error(
          `workspace_principals ${principalId} is kind 'api_key' with a null api_key_id; the ` +
            'source XOR check should make this unreachable.',
        );
      }
      const rows = await db
        .select({
          role: apiKeys.role,
          name: apiKeys.name,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, principal.apiKeyId)))
        .limit(1);
      const row = rows[0];
      // An endpoint-scoped key must not mint browser tokens or be re-read as an ordinary
      // principal: ADR-0134 keeps its authority to the one endpoint it is bound to.
      if (
        row !== undefined &&
        (await endpointBindings(db, workspaceId, principal.apiKeyId)).has(principal.apiKeyId)
      ) {
        return null;
      }
      // Re-checks the same freshness `authenticateApiKeyHash` applies to a directly-presented key:
      // a key that has since been revoked or has expired must stop authenticating a browser token
      // it minted on exactly the same request it would stop authenticating itself.
      if (
        row === undefined ||
        row.revokedAt !== null ||
        (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now())
      ) {
        return null;
      }
      // A key that acts for a person never outlives that person's principal or membership.
      if (
        principal.actsForPrincipalId !== null &&
        !(await isActiveMembershipPrincipal(db, workspaceId, principal.actsForPrincipalId))
      ) {
        return null;
      }
      return {
        principalId,
        kind: 'api_key',
        role: row.role,
        label: row.name,
        userId: null,
        apiKeyId: principal.apiKeyId,
        actsForPrincipalId: principal.actsForPrincipalId,
      };
    },
    async findUserByEmail(email) {
      const rows = await db
        .select(USER_COLUMNS)
        .from(users)
        .where(eq(users.email, normaliseEmail(email)))
        .limit(1);
      return rows[0] ?? null;
    },
    async findIdentity(issuer, subject) {
      const rows = await db
        .select({ userId: userIdentities.userId, email: users.email })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)))
        .limit(1);
      return rows[0] ?? null;
    },
    async linkIdentity(issuer, subject, userId) {
      try {
        await db.insert(userIdentities).values({ issuer, subject, userId });
      } catch (error) {
        if (isConstraint(error, 'user_identities_issuer_subject_key')) {
          // A replay is idempotent only when the durable binding still names the same user. A
          // different user is identity substitution, not a successful replay.
          const existing = await db
            .select({ userId: userIdentities.userId })
            .from(userIdentities)
            .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)))
            .limit(1);
          if (existing[0]?.userId === userId) return;
          throw new Error('OIDC identity is already bound to a different user', { cause: error });
        }
        throw error;
      }
    },
    async membershipsForUser(userId) {
      return db
        .select({
          principalId: workspacePrincipals.id,
          workspaceId: memberships.workspaceId,
          workspaceSlug: workspaces.slug,
          workspaceName: workspaces.name,
          role: memberships.role,
        })
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
        .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
        .where(eq(memberships.userId, userId))
        .orderBy(asc(workspaces.name));
    },
    async acceptInvitation(id, tokenHash, identity, now) {
      const email = normaliseEmail(identity.email);
      try {
        return await db.transaction(async (tx) => {
          // One condition, one query: id, hash and email are checked together, so a wrong id, a
          // wrong hash and a wrong email are one and the same "no row" outcome rather than three
          // branches that could disagree about which is faster or which is logged. An archived
          // workspace is folded into that same absence: lifecycle state is part of the positive
          // admission query, not a later rejection that confirms the tenant exists. `FOR UPDATE`
          // serialises a concurrent replay of the same token against the same row.
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
          const invitation = rows[0];
          if (invitation === undefined) return { kind: 'invalid' as const };
          // Every branch past this point already matched id, hash and email, so distinguishing them
          // reveals nothing about a workspace the caller could not already prove they were invited
          // to — the concealment property is the query above, not these checks.
          if (invitation.revokedAt !== null) return { kind: 'revoked' as const };
          if (invitation.acceptedAt !== null) return { kind: 'already-accepted' as const };
          if (invitation.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' as const };

          // The OIDC binding is part of this transaction, never a callback-side provisional write.
          // A pre-existing binding must name the same global user as the invitation email. The
          // post-insert re-read handles a concurrent binder; throwing rolls back a user we may have
          // inserted earlier in this transaction instead of leaving residue from a refused accept.
          const existingBindings = await tx
            .select({ userId: userIdentities.userId })
            .from(userIdentities)
            .where(
              and(
                eq(userIdentities.issuer, identity.issuer),
                eq(userIdentities.subject, identity.subject),
              ),
            )
            .limit(1);

          let user: DirectoryUserRecord | undefined;
          const existingBinding = existingBindings[0];
          if (existingBinding !== undefined) {
            const boundUsers = await tx
              .select(USER_COLUMNS)
              .from(users)
              .where(and(eq(users.id, existingBinding.userId), eq(users.email, email)))
              .limit(1);
            user = boundUsers[0];
            if (user === undefined) return { kind: 'invalid' as const };
          } else {
            const existingUsers = await tx
              .select(USER_COLUMNS)
              .from(users)
              .where(eq(users.email, email))
              .limit(1);
            user = existingUsers[0];
            if (user === undefined) {
              const inserted = await tx
                .insert(users)
                .values({ email, name: defaultDisplayName(email) })
                .onConflictDoNothing({ target: users.email })
                .returning(USER_COLUMNS);
              user = inserted[0];
              if (user === undefined) {
                const racedUsers = await tx
                  .select(USER_COLUMNS)
                  .from(users)
                  .where(eq(users.email, email))
                  .limit(1);
                user = racedUsers[0];
              }
            }
            if (user === undefined) throw new Error('invitation acceptance created no user row');

            await tx
              .insert(userIdentities)
              .values({ issuer: identity.issuer, subject: identity.subject, userId: user.id })
              .onConflictDoNothing({
                target: [userIdentities.issuer, userIdentities.subject],
              });
            const committedBindings = await tx
              .select({ userId: userIdentities.userId })
              .from(userIdentities)
              .where(
                and(
                  eq(userIdentities.issuer, identity.issuer),
                  eq(userIdentities.subject, identity.subject),
                ),
              )
              .limit(1);
            if (committedBindings[0]?.userId !== user.id) {
              throw new InvitationIdentityConflict();
            }
          }
          if (user === undefined) throw new Error('invitation acceptance created no user row');

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
            const existingPrincipals = await tx
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
              .where(
                and(
                  eq(memberships.workspaceId, invitation.workspaceId),
                  eq(memberships.userId, user.id),
                ),
              )
              .limit(1);
            const existingPrincipal = existingPrincipals[0];
            if (existingPrincipal === undefined) {
              throw new Error('existing invitation member has no exact principal');
            }
            await tx
              .update(invitations)
              .set({ acceptedAt: sql`greatest(now(), ${now}::timestamptz)` })
              .where(eq(invitations.id, id));
            return {
              kind: 'already-member' as const,
              workspaceId: invitation.workspaceId,
              userId: user.id,
              principalId: existingPrincipal.principalId,
            };
          }

          const insertedPrincipal = await tx
            .insert(workspacePrincipals)
            .values({
              workspaceId: invitation.workspaceId,
              kind: 'membership',
              membershipId: membershipRow.id,
            })
            .returning({ principalId: workspacePrincipals.id });
          const principal = insertedPrincipal[0];
          if (principal === undefined) {
            throw new Error('membership principal insert returned no row');
          }

          await tx
            .update(invitations)
            .set({ acceptedAt: sql`greatest(now(), ${now}::timestamptz)` })
            .where(eq(invitations.id, id));

          return {
            kind: 'accepted' as const,
            workspaceId: invitation.workspaceId,
            workspaceSlug: invitation.workspaceSlug,
            user,
            membership: {
              ...membershipRow,
              principalId: principal.principalId,
              email,
              name: user.name,
            },
          };
        });
      } catch (error) {
        if (error instanceof InvitationIdentityConflict) return { kind: 'invalid' as const };
        throw error;
      }
    },
  };
}
