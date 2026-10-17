/**
 * `api_keys` — workspace API keys for programmatic access (spec §22, §27).
 *
 * §22 is one of the few places §27's tables come with a column list, and it is transcribed
 * rather than reinterpreted:
 *
 * ```text
 * name              -> name
 * workspace         -> workspace_id
 * permissions       -> role            (see below)
 * created_at        -> created_at
 * last_used_at      -> last_used_at
 * expires_at        -> expires_at
 * revoked_at        -> revoked_at
 * ```
 *
 * **`permissions` is `role`.** §21 says "Keep authorization simple", gives four roles, and adds
 * "Sharing rights follow the same four roles and add nothing new". A JSONB scope list here
 * would be a second authorization vocabulary that every route would then have to understand in
 * addition to the first, and §21 explicitly does not want an "enterprise IAM product". So a key
 * acts with one of §21's four roles, and the permission split W2-CP-06 implements for a member
 * is the same split a key gets. The alternative is recorded in
 * docs/adr/W2-DB-01-remaining-section-27-tables.md.
 *
 * **§22's "Show the raw secret only once. Store only a secure hash."** is why there is no
 * column a raw key fits. `key_hash` holds the hash and `key_prefix` holds the few leading
 * characters §22's list renders as `ak_live_********` — enough to tell two keys apart in a
 * list, and not enough to use. The hash *algorithm* is deliberately not pinned by this schema:
 * research note R-12 is deciding it and W2-CP-06 implements it, so a CHECK on the hash's shape
 * here would be this task pre-empting that decision with a constraint.
 */
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { membershipRoles } from './memberships.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';

export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** §22's "Production", "CI". Unique in the workspace so the list is unambiguous. */
    name: text('name').notNull(),
    /** §22's "permissions", as one of §21's four roles. */
    role: text('role', { enum: membershipRoles }).notNull(),
    /** The displayable head of the key, §22's `ak_live_` prefix. Never enough to authenticate. */
    keyPrefix: text('key_prefix').notNull(),
    /** §22: "Store only a secure hash." Globally unique, because presentation looks a key up by it. */
    keyHash: text('key_hash').notNull(),
    /** §22. NULL until the key is first used; the list renders "Last used: 2h ago" from it. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    /** §22. NULL means the key does not expire. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    /** §22. NULL means live. Revocation is a timestamp, not a delete: §36 audits it. */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('api_keys_workspace_id_key').on(table.workspaceId, table.id),
    // Also the tenant index: `workspace_id` leads it (§25).
    uniqueIndex('api_keys_workspace_name_key').on(table.workspaceId, table.name),
    // Authentication is a lookup by hash across the whole deployment, so the uniqueness has to
    // be global rather than per workspace: two workspaces holding the same hash would make the
    // presented key resolve to two identities.
    uniqueIndex('api_keys_key_hash_key').on(table.keyHash),
    // "Which keys are live", the query the admin screen and every request path run.
    index('api_keys_workspace_revoked_idx').on(table.workspaceId, table.revokedAt),
    oneOf('api_keys_role_valid', table.role, membershipRoles),
    check('api_keys_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('api_keys_key_prefix_not_blank', sql`length(btrim(${table.keyPrefix})) > 0`),
    check('api_keys_key_hash_not_blank', sql`length(btrim(${table.keyHash})) > 0`),
    // A key that expired before it existed, or was revoked before it existed, is a row that
    // makes every "is this key usable?" comparison answer a question nobody asked.
    check(
      'api_keys_expires_after_created',
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'api_keys_revoked_after_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
