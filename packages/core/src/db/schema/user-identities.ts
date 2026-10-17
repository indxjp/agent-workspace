/**
 * `user_identities` — an OIDC issuer+subject bound to one `users` row (spec §21, issue #118).
 *
 * §21 says "Use generic OIDC for enterprise SSO" and issue #118 makes the key explicit: email
 * alone is not stable enough to be the identity key (an IdP may change the email claim, and two
 * identity providers can legitimately claim the same address). `(issuer, subject)` is what OIDC
 * itself guarantees is stable, so it is the pair this table indexes uniquely.
 *
 * This table carries no `workspace_id`, for the same reason `users` does not: an identity binding
 * is not tenant-specific. It is the second satellite of the `users` exemption in
 * `tenancy.test.ts`, not a new kind of exemption — one user's OIDC binding is the same fact in
 * every workspace that user is a member of.
 */
import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { check } from 'drizzle-orm/pg-core';
import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { users } from './users.js';

export const userIdentities = pgTable(
  'user_identities',
  {
    id: primaryKeyId(),
    /** The OIDC issuer URL, exactly as the token named it. */
    issuer: text('issuer').notNull(),
    /** The OIDC `sub` claim. Stable per issuer; meaningless compared across issuers. */
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The identity key. One (issuer, subject) binds to exactly one user, forever.
    unique('user_identities_issuer_subject_key').on(table.issuer, table.subject),
    // "Which identities does this user have" — sign-out/re-link and audit both need this
    // direction, which the composite key above cannot serve.
    index('user_identities_user_idx').on(table.userId),
    check('user_identities_issuer_not_blank', sql`length(btrim(${table.issuer})) > 0`),
    check('user_identities_subject_not_blank', sql`length(btrim(${table.subject})) > 0`),
  ],
);

export type UserIdentity = typeof userIdentities.$inferSelect;
export type NewUserIdentity = typeof userIdentities.$inferInsert;
