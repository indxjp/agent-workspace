/**
 * `invitations` — the secure workspace invitation and acceptance lifecycle (issue #121).
 *
 * §21 makes `memberships` the whole of a person's authorization inside a workspace, and gives no
 * mechanism for adding someone who does not already hold a `users` row this deployment recognises.
 * `POST /api/users` and `POST /api/memberships` are the direct provisioning routes W2-CP-06 built
 * for that (kept for controlled internal use, `apps/web/app/api/users/route.ts`'s own header).
 * This table is the other path: an Owner or Admin names an email and a role, this deployment mints
 * a single-use, expiring, workspace-bound secret, and the invitee redeems it themselves.
 *
 * ## The columns are exactly the card's list, plus the conventions every table here carries
 *
 * `workspace_id, email, role, invited_by, token_hash, expires_at, accepted_at, revoked_at` is the
 * card's own list, verbatim. `id`, `created_at` and `updated_at` are `columns.ts`'s standard three,
 * the same as every other table in this schema.
 *
 * ## The token is never a column here
 *
 * `token_hash` is SHA-256 of the random secret, lower-case hex — `apps/web/server/invitations/
 * token.ts` mints it and hashes it, the same primitive `apps/web/server/rbac/api-key.ts` uses and
 * for the same reason (one cryptographic surface, Web Crypto, available in every runtime this
 * application runs in). There is no column a plaintext token could be written to, which is half of
 * "never logged and never written to an audit row" — the other half is that no code path ever
 * builds a log line or an audit event from it (`apps/web/server/invitations/handlers.ts`).
 *
 * ## The partial unique index is the card's concurrency guarantee, not an afterthought
 *
 * `invitations_workspace_email_pending_key` is a **partial** unique index on
 * `(workspace_id, email)`, active only where neither `accepted_at` nor `revoked_at` is set. Two
 * concurrent `POST /api/invitations` for the same address race PostgreSQL's own uniqueness check,
 * not application code: the loser's `INSERT` raises `23505`, which
 * `packages/core/src/db/repositories/directory.ts` catches and turns into the
 * `already-invited` outcome, the same shape `memberships_workspace_user_key` already gives
 * `createMembership`'s `already-a-member`. The index is partial rather than plain so that a
 * terminal invitation — accepted or revoked — never blocks re-inviting the same address. An
 * expired row is still pending until it is resent or revoked, so it continues to block a duplicate;
 * that makes expiry deterministic instead of silently creating two histories for one address.
 *
 * ## `invited_by` references `users`, not `memberships`
 *
 * A membership can be removed after the invitation is sent (issue #117's ownership problem, one
 * layer up: "who invited this person" should keep reading after the inviter leaves the workspace,
 * the same reasoning `audit_events.actor_user_id` and `agents.created_by` both carry). `ON DELETE
 * SET NULL`: the row survives its inviter's account being deleted, unattributed rather than
 * impossible — `users` is one of `tenancy.test.ts`'s two tenant-exempt tables, so this single-column
 * reference is the same shape `memberships.user_id` and `audit_events.actor_user_id` already use to
 * point at it.
 */
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { membershipRoles } from './memberships.js';
import { oneOf } from './one-of.js';
import { users } from './users.js';
import { workspaces } from './workspaces.js';

export const invitations = pgTable(
  'invitations',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Lower-case, the same shape `users.email` enforces — checked below rather than assumed. */
    email: text('email').notNull(),
    /** The role acceptance will confer, one of §21's four. Never wider than the inviter conferred. */
    role: text('role', { enum: membershipRoles }).notNull(),
    /** Who sent it. `SET NULL` on deletion: see this file's header. */
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    /** SHA-256 of the random secret, lower-case hex. The secret itself lives nowhere in this row. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** NULL until redeemed. Stamped in the same transaction that creates the membership. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    /** NULL until an Owner/Admin revokes it. A revoked invitation is never accepted afterwards. */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The tenant index, and the card's own concurrency guarantee: see this file's header.
    uniqueIndex('invitations_workspace_email_pending_key')
      .on(table.workspaceId, table.email)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    // "Every invitation this workspace has ever sent", the query the admin list runs; the partial
    // index above cannot serve it because a resolved invitation falls outside its predicate.
    index('invitations_workspace_idx').on(table.workspaceId, table.createdAt),
    // Resend and revoke both take the row by id and must not cross a tenant boundary while doing
    // it; workspace_id leads the lookup the same way it leads every other table's.
    index('invitations_invited_by_idx').on(table.invitedBy),
    oneOf('invitations_role_valid', table.role, membershipRoles),
    check('invitations_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check(
      'invitations_email_shape',
      sql`${table.email} ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'`,
    ),
    check('invitations_token_hash_not_blank', sql`length(btrim(${table.tokenHash})) > 0`),
    check('invitations_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'invitations_accepted_after_created',
      sql`${table.acceptedAt} is null or ${table.acceptedAt} >= ${table.createdAt}`,
    ),
    check(
      'invitations_revoked_after_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    // An invitation is redeemed once, by exactly one identity. Accepted-then-revoked would be a row
    // whose two terminal timestamps disagree about how it ended; the handler never sets both, and
    // this check makes that a database fact rather than an application convention.
    check(
      'invitations_not_accepted_and_revoked',
      sql`${table.acceptedAt} is null or ${table.revokedAt} is null`,
    ),
  ],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
