import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { apiKeys } from '../../schema/api-keys.js';
import { memberships } from '../../schema/memberships.js';
import { userIdentities } from '../../schema/user-identities.js';
import { users } from '../../schema/users.js';
import { workspaces } from '../../schema/workspaces.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import type { DatabaseDirectoryRoot, DirectoryApiKeyRecord } from '../directory.js';
import {
  endpointBindings,
  isActiveMembershipPrincipal,
  isConstraint,
  KEY_COLUMNS,
  KEY_ROW_COLUMNS,
  normaliseEmail,
  type Transaction,
  USER_COLUMNS,
} from './queries.js';
import { acceptInvitationTransaction } from './root-invitation.js';
import { readPrincipalById } from './root-principal.js';

async function selectLiveKey(tx: Transaction, keyHash: string, now: Date) {
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
  return rows[0];
}

async function authenticateApiKey(
  db: Database,
  keyHash: string,
  now: Date,
): Promise<DirectoryApiKeyRecord | null> {
  return db.transaction(async (tx) => {
    const key = await selectLiveKey(tx, keyHash, now);
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
    if (updatedKey === undefined) return null;
    return {
      ...updatedKey,
      principalId: key.principalId,
      actsForPrincipalId: key.actsForPrincipalId,
      endpointScope: binding?.scope ?? null,
    };
  });
}

export function createDatabaseDirectoryRootQueries(
  db: Database,
): Omit<DatabaseDirectoryRoot, 'forWorkspace' | 'bindGuestWorkspace'> {
  return {
    authenticateApiKeyHash: (keyHash, now) => authenticateApiKey(db, keyHash, now),
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
    principalById: (workspaceId, principalId) => readPrincipalById(db, workspaceId, principalId),
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
    acceptInvitation: (id, tokenHash, identity, now) =>
      acceptInvitationTransaction(db, id, tokenHash, identity, now),
  };
}
