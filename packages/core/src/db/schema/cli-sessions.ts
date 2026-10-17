/**
 * `cli_sessions` — issue #242 (SDK-10, S-22): one `aw login` of one person, from the moment they
 * approve the device code in a browser to the moment the token is revoked or expires. ADR-0083.
 *
 * The device authorization request itself is not a row: `POST /api/auth/cli-device` answers with
 * a device code the server signed, which carries the user code and its own expiry. A row exists
 * from approval onward, because only then is the workspace known, and a tenant-scoped table
 * cannot hold a row with no workspace (`tenancy.test.ts`).
 *
 * The person is referenced through their Membership — `(workspace_id, user_id)` →
 * `memberships` — rather than straight to `users`: removing the membership deletes the sign-in
 * with it, and switching the token to another workspace is refused by the database unless the
 * person is a member of that workspace too. The token itself is never stored, only a SHA-256 of its
 * secret half, the same as `browser_tokens` and `api_keys`.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryKeyId } from './columns.js';
import { memberships } from './memberships.js';
import { workspaces } from './workspaces.js';

/**
 * `approved` and `denied` are the answers to the device code; `active` is a token issued against
 * an approval; `revoked` is an `aw logout` (or any later revocation).
 */
export const cliSessionStatuses = ['approved', 'denied', 'active', 'revoked'] as const;
export type CliSessionStatus = (typeof cliSessionStatuses)[number];

export const cliSessions = pgTable(
  'cli_sessions',
  {
    id: primaryKeyId(),
    /** The workspace the token currently acts in. `aw workspaces select` moves it. */
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    /** The code the person typed, normalised to eight upper-case letters. */
    userCode: text('user_code').notNull(),
    status: text('status', { enum: cliSessionStatuses }).notNull(),
    /** Until when the device may exchange its code for a token. */
    approvalExpiresAt: timestamp('approval_expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    /** SHA-256 of the token's secret half, lower-case hex. Set when the token is issued. */
    tokenHash: text('token_hash'),
    /** The token's expiry. Set when the token is issued. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'cli_sessions_member_workspace_fk',
    }).onDelete('cascade'),
    uniqueIndex('cli_sessions_user_code_key').on(table.userCode),
    uniqueIndex('cli_sessions_token_hash_key').on(table.tokenHash),
    index('cli_sessions_workspace_user_idx').on(table.workspaceId, table.userId),
    check(
      'cli_sessions_status_valid',
      sql`${table.status} in ('approved', 'denied', 'active', 'revoked')`,
    ),
    check('cli_sessions_user_code_shape', sql`${table.userCode} ~ '^[A-Z]{8}$'`),
    // A token exists exactly from `active` on, and a revoked row records when.
    check(
      'cli_sessions_token_iff_issued',
      sql`(${table.status} in ('active', 'revoked')) = (${table.tokenHash} is not null and ${table.expiresAt} is not null)`,
    ),
    check(
      'cli_sessions_revoked_iff_status',
      sql`(${table.status} = 'revoked') = (${table.revokedAt} is not null)`,
    ),
    check(
      'cli_sessions_expiry_after_created',
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export type CliSession = typeof cliSessions.$inferSelect;
