import { and, asc, count, eq, isNull, type SQL } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { memberships, type MembershipRole } from '../../schema/memberships.js';
import { users } from '../../schema/users.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import type { DatabaseWorkspaceDirectory } from '../directory.js';
import {
  isConstraint,
  lockWorkspace,
  normaliseEmail,
  type Transaction,
  USER_COLUMNS,
} from './queries.js';
import { UUID_PATTERN } from '../runs/rows.js';

type Directory = DatabaseWorkspaceDirectory;

function membershipColumns() {
  return {
    id: memberships.id,
    principalId: workspacePrincipals.id,
    userId: memberships.userId,
    email: users.email,
    name: users.name,
    role: memberships.role,
    createdAt: memberships.createdAt,
  } as const;
}

/** Memberships joined to their user and live membership principal: a revoked one matches nothing. */
function selectMemberships(executor: Database | Transaction, where: SQL | undefined) {
  return executor
    .select(membershipColumns())
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(
      workspacePrincipals,
      and(
        eq(workspacePrincipals.workspaceId, memberships.workspaceId),
        eq(workspacePrincipals.membershipId, memberships.id),
        eq(workspacePrincipals.kind, 'membership'),
        isNull(workspacePrincipals.revokedAt),
      ),
    )
    .where(where);
}

/** Insert one `memberships` row and its `workspace_principals` row. Runs inside the caller's transaction. */
async function insertMembershipWithPrincipal(
  tx: Transaction,
  workspaceId: string,
  membership: { readonly userId: string; readonly role: MembershipRole },
) {
  const rows = await tx
    .insert(memberships)
    .values({ workspaceId, userId: membership.userId, role: membership.role })
    .returning({
      id: memberships.id,
      userId: memberships.userId,
      role: memberships.role,
      createdAt: memberships.createdAt,
    });
  const row = rows[0];
  if (row === undefined) throw new Error('membership insert returned no row');
  const insertedPrincipal = await tx
    .insert(workspacePrincipals)
    .values({ workspaceId, kind: 'membership', membershipId: row.id })
    .returning({ principalId: workspacePrincipals.id });
  const principal = insertedPrincipal[0];
  if (principal === undefined) {
    throw new Error('membership principal insert returned no row');
  }
  return { ...row, principalId: principal.principalId };
}

/** Whether the workspace has at most one owner, so removing an owner would leave it with none. */
async function isLastOwner(tx: Transaction, workspaceId: string): Promise<boolean> {
  const owners = await tx
    .select({ total: count() })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')));
  return (owners[0]?.total ?? 0) <= 1;
}

async function createUser(
  db: Database,
  workspaceId: string,
  input: Parameters<Directory['createUser']>[0],
): ReturnType<Directory['createUser']> {
  const email = normaliseEmail(input.email);
  return db.transaction(async (tx) => {
    const existingUsers = await tx
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    let user = existingUsers[0];
    if (user !== undefined) {
      const member = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)))
        .limit(1);
      if (member[0] !== undefined) return { kind: 'email-taken' as const, email };
    } else {
      const inserted = await tx
        .insert(users)
        .values({ email, name: input.name.trim() })
        .returning(USER_COLUMNS);
      user = inserted[0];
    }
    if (user === undefined) throw new Error('user insert returned no row');
    const membership = await insertMembershipWithPrincipal(tx, workspaceId, {
      userId: user.id,
      role: input.role,
    });
    return {
      kind: 'created' as const,
      user,
      membership: { ...membership, email, name: user.name },
    };
  });
}

async function createMembership(
  db: Database,
  workspaceId: string,
  input: Parameters<Directory['createMembership']>[0],
): ReturnType<Directory['createMembership']> {
  const email = normaliseEmail(input.email);
  const found = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const user = found[0];
  if (user === undefined) return { kind: 'no-such-user', email };
  try {
    return await db.transaction(async (tx) => {
      const membership = await insertMembershipWithPrincipal(tx, workspaceId, {
        userId: user.id,
        role: input.role,
      });
      return { kind: 'created' as const, membership: { ...membership, email, name: user.name } };
    });
  } catch (error) {
    if (isConstraint(error, 'memberships_workspace_user_key'))
      return { kind: 'already-a-member', email };
    throw error;
  }
}

async function changeMembershipRole(
  db: Database,
  workspaceId: string,
  id: string,
  role: MembershipRole,
): ReturnType<Directory['changeMembershipRole']> {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const rows = await selectMemberships(
      tx,
      and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, id)),
    ).limit(1);
    const current = rows[0];
    if (current === undefined) return { kind: 'no-such-membership' as const, id };
    if (current.role === 'owner' && role !== 'owner' && (await isLastOwner(tx, workspaceId))) {
      return { kind: 'last-owner' as const, id };
    }
    await tx
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, id)));
    return { kind: 'changed' as const, membership: { ...current, role } };
  });
}

async function deleteMembership(
  db: Database,
  workspaceId: string,
  id: string,
): ReturnType<Directory['deleteMembership']> {
  try {
    return await db.transaction(async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const rows = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, id)))
        .limit(1);
      const current = rows[0];
      if (current === undefined) return { kind: 'no-such-membership' as const, id };
      if (current.role === 'owner' && (await isLastOwner(tx, workspaceId))) {
        return { kind: 'last-owner' as const, id };
      }
      await tx
        .delete(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, id)));
      return { kind: 'deleted' as const, id };
    });
  } catch (error) {
    // RF-101 makes project ownership exact and non-null. Until RF-202 defines an explicit
    // offboarding/reassignment policy, preserve both the membership and its projects and
    // translate the resulting constraint into an expected domain refusal.
    if (isConstraint(error, 'projects_owner_principal_workspace_fk')) {
      return { kind: 'membership-in-use' as const, id, dependency: 'projects' as const };
    }
    // Issue #509 (S1-24): a local runtime key principal records the membership principal it
    // acts for, and that NO ACTION reference keeps the member. Refused as a domain outcome,
    // never surfaced as a raw constraint failure.
    if (isConstraint(error, 'workspace_principals_acts_for_workspace_fk')) {
      return { kind: 'membership-in-use' as const, id, dependency: 'local-runtime-keys' as const };
    }
    throw error;
  }
}

/** The users and memberships of one workspace. */
export function createMembershipDirectory(
  db: Database,
  workspaceId: string,
): Pick<
  Directory,
  | 'listUsers'
  | 'createUser'
  | 'listMemberships'
  | 'findMembershipByPrincipal'
  | 'createMembership'
  | 'changeMembershipRole'
  | 'deleteMembership'
> {
  // One query for both reads, so a by-principal lookup can never see a different set of members
  // than the list: a membership whose principal is revoked is in neither.
  const membershipRows = (principalId?: string) =>
    selectMemberships(
      db,
      and(
        eq(memberships.workspaceId, workspaceId),
        principalId === undefined ? undefined : eq(workspacePrincipals.id, principalId),
      ),
    ).orderBy(asc(users.email));

  return {
    async listUsers() {
      return db
        .select(USER_COLUMNS)
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .where(eq(memberships.workspaceId, workspaceId))
        .orderBy(asc(users.email));
    },
    createUser: async (input) => createUser(db, workspaceId, input),
    listMemberships: async () => membershipRows(),
    findMembershipByPrincipal: async (principalId) =>
      // `workspace_principals.id` is a uuid column: a malformed id is no principal, not a driver error.
      UUID_PATTERN.test(principalId)
        ? ((await membershipRows(principalId).limit(1))[0] ?? null)
        : null,
    createMembership: async (input) => createMembership(db, workspaceId, input),
    changeMembershipRole: async (id, role) => changeMembershipRole(db, workspaceId, id, role),
    deleteMembership: async (id) => deleteMembership(db, workspaceId, id),
  };
}
