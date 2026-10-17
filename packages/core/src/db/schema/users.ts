/**
 * `users` — an identity, not a tenant object (spec §21, §27).
 *
 * A user is deliberately NOT workspace-scoped. Spec §21 makes `memberships` the thing that
 * binds a person to a workspace and gives them a role there, which means one identity can sit
 * in more than one workspace; a `workspace_id` on this table would make that impossible and
 * would duplicate a person per workspace. This is the second and last of the two tables
 * exempt from the §25 tenant-scoping rule, and `tenancy.test.ts` names both exemptions
 * explicitly so that a third one cannot appear by accident.
 *
 * Nothing tenant-specific may be added here. Anything that differs per workspace — a role, a
 * preference, a quota — belongs on `memberships`.
 */
import { check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';

export const users = pgTable(
  'users',
  {
    id: primaryKeyId(),
    /**
     * Login identity. Stored lower-case, and the database enforces that rather than trusting
     * every future caller to remember: `users_email_lowercase` makes a mixed-case duplicate
     * impossible instead of merely unlikely.
     */
    email: text('email').notNull(),
    /** Display name. Free text. */
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('users_email_key').on(table.email),
    check('users_email_lowercase', sql`${table.email} = lower(${table.email})`),
    // Not an RFC 5322 parser — a shape check that rejects the inputs that actually cause
    // trouble: whitespace, a missing or repeated `@`, and a domain with no dot. Real
    // validation is Zod's, at the application boundary; this is the backstop for anything
    // that reaches the table another way.
    check(
      'users_email_shape',
      sql`${table.email} ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'`,
    ),
    check('users_name_not_blank', sql`length(btrim(${table.name})) > 0`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
