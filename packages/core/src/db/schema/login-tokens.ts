/**
 * `login_tokens` — the email-link (passwordless) sign-in of the Agent Store's guests
 * (spec §21, "Guest").
 *
 * One row is one link sent to one address. The row holds hashes only: `token_hash` is SHA-256 of
 * the random secret in the link and `email_hash` SHA-256 of the lower-cased address, both
 * lower-case hex, the same primitive `invitations.token_hash` uses. There is no column a plaintext
 * token or address could be written to, so an address typed by someone who never opens the link
 * is not kept in the clear.
 *
 * A token is single-use and short-lived: `used_at` is stamped by the one `UPDATE` that consumes it,
 * which matches only an unused, unexpired row with the same `email_hash`, so a reused, expired,
 * tampered or misaddressed token changes nothing. `created_at` and `expires_at` are written by the
 * caller from its `Clock`, never left to the database's own `now()`.
 *
 * Not tenant-scoped: a link is sent before any workspace exists, and the workspace it leads to is
 * made when the link is opened. `tenancy-readers.test-support.ts` records the exemption.
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { primaryKeyId } from './columns.js';

export const loginTokens = pgTable(
  'login_tokens',
  {
    id: primaryKeyId(),
    /** SHA-256 of the link's secret, lower-case hex. The secret itself lives nowhere in this row. */
    tokenHash: text('token_hash').notNull(),
    /** SHA-256 of the lower-cased address the link was sent to, lower-case hex. */
    emailHash: text('email_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** NULL until the link is opened. Set once; a second use finds no unused row. */
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('login_tokens_token_hash_key').on(table.tokenHash),
    // "How many links went to this address lately": the per-address issue limit.
    index('login_tokens_email_created_idx').on(table.emailHash, table.createdAt),
    check('login_tokens_token_hash_shape', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('login_tokens_email_hash_shape', sql`${table.emailHash} ~ '^[0-9a-f]{64}$'`),
    check('login_tokens_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'login_tokens_used_after_created',
      sql`${table.usedAt} is null or ${table.usedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type LoginToken = typeof loginTokens.$inferSelect;
export type NewLoginToken = typeof loginTokens.$inferInsert;
