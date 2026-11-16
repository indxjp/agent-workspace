import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { memberships } from '../../schema/memberships.js';
import { users } from '../../schema/users.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import { workspaces } from '../../schema/workspaces.js';
import type { BindGuestWorkspaceInput, DatabaseDirectoryRoot } from '../directory.js';
import { normaliseEmail, USER_COLUMNS } from './queries.js';

/** The only role this file ever writes. A literal, so no caller can choose another. */
const GUEST_ROLE = 'guest' as const;

/** A display name for a user an email link creates: the local part, or the whole address. */
function displayName(email: string): string {
  const local = email.split('@')[0]?.trim();
  return local !== undefined && local !== '' ? local : email;
}

/**
 * Bind an address, whose email link was just consumed, to a demo workspace: one transaction that
 * finds or creates the user, returns the guest's existing demo workspace while its `demo_expires_at` has not
 * passed, and otherwise makes a workspace marked to end `lifetimeSeconds` later and a `guest` membership in it. It touches no
 * other membership of the user and writes no role but `guest`. A user who holds a current
 * membership with any other role is bound to nothing and the answer is `null`.
 *
 * The user row is locked for the transaction, so two links opened at once for one address make one
 * workspace, not two.
 */
export function createGuestBinder(db: Database): Pick<DatabaseDirectoryRoot, 'bindGuestWorkspace'> {
  return {
    bindGuestWorkspace(input: BindGuestWorkspaceInput) {
      const email = normaliseEmail(input.email);
      return db.transaction(async (tx) => {
        await tx
          .insert(users)
          .values({ email, name: displayName(email) })
          .onConflictDoNothing({ target: users.email });
        const found = await tx
          .select(USER_COLUMNS)
          .from(users)
          .where(eq(users.email, email))
          .for('update')
          .limit(1);
        const user = found[0];
        if (user === undefined) throw new Error('guest binding found no user row');

        // An address that holds any other role is a real account: its identity provider, not an
        // inbox, signs it in. The link answers nothing for it and binds nothing.
        const real = await tx
          .select({ id: memberships.id })
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
          .where(and(eq(memberships.userId, user.id), ne(memberships.role, GUEST_ROLE)))
          .limit(1);
        if (real[0] !== undefined) return null;

        const recent = await tx
          .select({ id: workspaces.id, slug: workspaces.slug })
          .from(memberships)
          .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
          .where(
            and(
              eq(memberships.userId, user.id),
              eq(memberships.role, GUEST_ROLE),
              isNull(workspaces.archivedAt),
              // Only a marked demo workspace not yet at its end is returned to its guest.
              gt(workspaces.demoExpiresAt, input.now),
            ),
          )
          .orderBy(desc(workspaces.createdAt), desc(workspaces.id))
          .limit(1);
        const existing = recent[0];
        if (existing !== undefined) {
          return {
            userId: user.id,
            workspaceId: existing.id,
            workspaceSlug: existing.slug,
            created: false,
          };
        }

        await tx.insert(workspaces).values({
          id: input.workspaceId,
          slug: input.slug,
          name: `Demo ${input.slug}`,
          createdAt: input.now,
          // Set once, here, and never moved: the workspace's 24 hours end at this moment.
          demoExpiresAt: new Date(input.now.getTime() + input.lifetimeSeconds * 1000),
        });
        const insertedMembership = await tx
          .insert(memberships)
          .values({
            workspaceId: input.workspaceId,
            userId: user.id,
            role: GUEST_ROLE,
            createdAt: input.now,
          })
          .returning({ id: memberships.id });
        const membership = insertedMembership[0];
        if (membership === undefined) throw new Error('guest membership insert returned no row');
        await tx.insert(workspacePrincipals).values({
          workspaceId: input.workspaceId,
          kind: 'membership',
          membershipId: membership.id,
        });
        return {
          userId: user.id,
          workspaceId: input.workspaceId,
          workspaceSlug: input.slug,
          created: true,
        };
      });
    },
  };
}
