/**
 * `cli_sessions` — issue #242 (SDK-10, S-22): an `aw login`'s approval, token and revocation.
 * ADR-0083.
 *
 * Every lookup here is by a globally-unique value — the user code the person typed, or the hash of
 * a presented token — before the caller knows which workspace the row belongs to, the same
 * declared exception `findActiveBrowserTokenByHash` is. No method returns the token or its hash.
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { cliSessions } from '../schema/cli-sessions.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';
import { postgresViolations } from './violations.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

export interface RecordCliApprovalInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly userCode: string;
  readonly decision: 'approved' | 'denied';
  readonly approvalExpiresAt: Date;
}

/** `code-taken`: another approval already answered this user code. */
export type RecordCliApprovalOutcome = 'recorded' | 'code-taken';

/** What polling with a device code found. `issued` is the only one that produced a token. */
export type CliTokenExchangeOutcome =
  | { readonly kind: 'issued'; readonly workspaceId: string; readonly userId: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'spent' };

/** An active CLI token's identity: who, and in which workspace. Never the token itself. */
export interface ActiveCliSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly expiresAt: Date;
}

export interface CliSessionRepository {
  /** Record the person's answer to a user code. A code is answered at most once. */
  recordApproval(input: RecordCliApprovalInput): Promise<RecordCliApprovalOutcome>;
  /**
   * Spend an approval: in one statement, an `approved`, unexpired row for `userCode` becomes
   * `active` with `tokenHash`. A second exchange of the same code finds `spent`.
   */
  exchange(
    userCode: string,
    tokenHash: string,
    expiresAt: Date,
    now?: Date,
  ): Promise<CliTokenExchangeOutcome>;
  /** The active (unrevoked, unexpired) session for a token hash, or `null`. */
  findActiveByHash(tokenHash: string, now?: Date): Promise<ActiveCliSession | null>;
  /** Revoke the active session for a token hash. `false` when there was none to revoke. */
  revokeByHash(tokenHash: string, now?: Date): Promise<boolean>;
  /**
   * Move the active session for a token hash to `workspaceId`. `false` when there is no active
   * session, or the person holds no membership there (`cli_sessions_member_workspace_fk`).
   */
  moveToWorkspace(tokenHash: string, workspaceId: string, now?: Date): Promise<boolean>;
}

function violates(error: unknown, code: string, constraint: string): boolean {
  for (const failure of postgresViolations(error)) {
    if (failure.code === code && failure.constraint === constraint) return true;
  }
  return false;
}

async function classifyUnspent(
  db: Database,
  userCode: string,
  now: Date,
): Promise<CliTokenExchangeOutcome> {
  const rows = await db
    .select({ status: cliSessions.status, approvalExpiresAt: cliSessions.approvalExpiresAt })
    .from(cliSessions)
    .where(eq(cliSessions.userCode, userCode))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { kind: 'pending' };
  switch (row.status) {
    case 'denied':
      return { kind: 'denied' };
    case 'approved':
      return row.approvalExpiresAt.getTime() <= now.getTime()
        ? { kind: 'expired' }
        : { kind: 'pending' };
    case 'active':
    case 'revoked':
      return { kind: 'spent' };
    default: {
      const unreachable: never = row.status;
      throw new Error(`unclassified cli_sessions status ${JSON.stringify(unreachable)}`);
    }
  }
}

const activeByHash = (tokenHash: string, now: Date) =>
  and(
    eq(cliSessions.tokenHash, tokenHash),
    eq(cliSessions.status, 'active'),
    isNull(cliSessions.revokedAt),
    gt(cliSessions.expiresAt, now),
  );

export function createDatabaseCliSessionRepository(db: Database): CliSessionRepository {
  return {
    async recordApproval(input) {
      try {
        await db.insert(cliSessions).values({
          workspaceId: input.workspaceId,
          userId: input.userId,
          userCode: input.userCode,
          status: input.decision,
          approvalExpiresAt: input.approvalExpiresAt,
        });
        return 'recorded';
      } catch (error) {
        if (violates(error, UNIQUE_VIOLATION, 'cli_sessions_user_code_key')) return 'code-taken';
        throw error;
      }
    },

    async exchange(userCode, tokenHash, expiresAt, now = new Date()) {
      const issued = await db
        .update(cliSessions)
        .set({ status: 'active', tokenHash, expiresAt })
        .where(
          and(
            eq(cliSessions.userCode, userCode),
            eq(cliSessions.status, 'approved'),
            gt(cliSessions.approvalExpiresAt, now),
          ),
        )
        .returning({ workspaceId: cliSessions.workspaceId, userId: cliSessions.userId });
      const row = issued[0];
      if (row !== undefined) return { kind: 'issued', ...row };
      return classifyUnspent(db, userCode, now);
    },

    async findActiveByHash(tokenHash, now = new Date()) {
      const rows = await db
        .select({
          id: cliSessions.id,
          workspaceId: cliSessions.workspaceId,
          workspaceSlug: workspaces.slug,
          userId: cliSessions.userId,
          userEmail: users.email,
          expiresAt: cliSessions.expiresAt,
        })
        .from(cliSessions)
        .innerJoin(workspaces, eq(workspaces.id, cliSessions.workspaceId))
        .innerJoin(users, eq(users.id, cliSessions.userId))
        .where(activeByHash(tokenHash, now))
        .limit(1);
      const row = rows[0];
      if (row === undefined || row.expiresAt === null) return null;
      return { ...row, expiresAt: row.expiresAt };
    },

    async revokeByHash(tokenHash, now = new Date()) {
      const revoked = await db
        .update(cliSessions)
        .set({ status: 'revoked', revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
        .where(activeByHash(tokenHash, now))
        .returning({ id: cliSessions.id });
      return revoked.length > 0;
    },

    async moveToWorkspace(tokenHash, workspaceId, now = new Date()) {
      try {
        const moved = await db
          .update(cliSessions)
          .set({ workspaceId })
          .where(activeByHash(tokenHash, now))
          .returning({ id: cliSessions.id });
        return moved.length > 0;
      } catch (error) {
        if (
          violates(error, FOREIGN_KEY_VIOLATION, 'cli_sessions_member_workspace_fk') ||
          violates(error, FOREIGN_KEY_VIOLATION, 'cli_sessions_workspace_id_workspaces_id_fk')
        ) {
          return false;
        }
        throw error;
      }
    },
  };
}
