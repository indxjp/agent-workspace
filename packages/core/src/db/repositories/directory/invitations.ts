import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { invitations } from '../../schema/invitations.js';
import type { DatabaseWorkspaceDirectory, DirectoryInvitationRecord } from '../directory.js';
import { INVITATION_COLUMNS, isConstraint, normaliseEmail } from './queries.js';

type Directory = DatabaseWorkspaceDirectory;

async function findInvitation(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<DirectoryInvitationRecord | null> {
  const rows = await db
    .select(INVITATION_COLUMNS)
    .from(invitations)
    .where(and(eq(invitations.workspaceId, workspaceId), eq(invitations.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Why a guarded invitation write updated no row, read only after the write refused: missing,
 * accepted, or revoked (reported as `terminal.revokedKind`). A pending invitation here is a bug and
 * throws `terminal.unexpected`.
 */
async function refusedInvitation<K extends 'revoked' | 'already-revoked'>(
  db: Database,
  workspaceId: string,
  id: string,
  terminal: { readonly revokedKind: K; readonly unexpected: string },
): Promise<
  | { kind: 'no-such-invitation'; id: string }
  | { kind: 'already-accepted'; invitation: DirectoryInvitationRecord }
  | { kind: K; invitation: DirectoryInvitationRecord }
> {
  const current = await findInvitation(db, workspaceId, id);
  if (current === null) return { kind: 'no-such-invitation', id };
  if (current.acceptedAt !== null) {
    return { kind: 'already-accepted', invitation: current };
  }
  if (current.revokedAt !== null) {
    return { kind: terminal.revokedKind, invitation: current };
  }
  throw new Error(terminal.unexpected);
}

async function createInvitation(
  db: Database,
  workspaceId: string,
  input: Parameters<Directory['createInvitation']>[0],
): ReturnType<Directory['createInvitation']> {
  const email = normaliseEmail(input.email);
  try {
    const rows = await db
      .insert(invitations)
      .values({
        workspaceId,
        email,
        role: input.role,
        invitedBy: input.invitedBy,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      })
      .returning(INVITATION_COLUMNS);
    const invitation = rows[0];
    if (invitation === undefined) throw new Error('invitation insert returned no row');
    return { kind: 'created', invitation };
  } catch (error) {
    if (isConstraint(error, 'invitations_workspace_email_pending_key')) {
      return { kind: 'already-invited', email };
    }
    throw error;
  }
}

async function revokeInvitation(
  db: Database,
  workspaceId: string,
  id: string,
  now: Date,
): ReturnType<Directory['revokeInvitation']> {
  const rows = await db
    .update(invitations)
    .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.id, id),
        isNull(invitations.revokedAt),
        isNull(invitations.acceptedAt),
      ),
    )
    .returning(INVITATION_COLUMNS);
  const revoked = rows[0];
  if (revoked !== undefined) return { kind: 'revoked' as const, invitation: revoked };

  // As with resend, the guarded write is the lifecycle decision. Only after it refuses do we
  // read the terminal state, so a concurrent acceptance cannot be mislabeled as revocation.
  return refusedInvitation(db, workspaceId, id, {
    revokedKind: 'already-revoked',
    unexpected: 'pending invitation revoke updated no row',
  });
}

/** The invitations of one workspace. */
export function createInvitationDirectory(
  db: Database,
  workspaceId: string,
): Pick<
  Directory,
  'listInvitations' | 'createInvitation' | 'resendInvitation' | 'revokeInvitation'
> {
  return {
    async listInvitations() {
      return db
        .select(INVITATION_COLUMNS)
        .from(invitations)
        .where(eq(invitations.workspaceId, workspaceId))
        .orderBy(desc(invitations.createdAt));
    },
    createInvitation: async (input) => createInvitation(db, workspaceId, input),
    async resendInvitation(id, tokenHash, expiresAt) {
      const rows = await db
        .update(invitations)
        .set({ tokenHash, expiresAt })
        .where(
          and(
            eq(invitations.workspaceId, workspaceId),
            eq(invitations.id, id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning(INVITATION_COLUMNS);
      const updated = rows[0];
      if (updated !== undefined) return { kind: 'resent' as const, invitation: updated };

      // The conditional UPDATE is the decision point. Reading state only after it returns no row
      // avoids a resend/accept race where an earlier SELECT saw "pending" and a later UPDATE
      // rotated the token after acceptance had already committed.
      return refusedInvitation(db, workspaceId, id, {
        revokedKind: 'revoked',
        unexpected: 'pending invitation resend updated no row',
      });
    },
    revokeInvitation: async (id, now) => revokeInvitation(db, workspaceId, id, now),
  };
}
