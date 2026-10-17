/**
 * `memberships` — a user's role inside one workspace (spec §21, §27).
 *
 * The four roles are §21's, verbatim and in its order of decreasing authority. §21 adds no
 * fifth role for sharing ("Sharing rights follow the same four roles and add nothing new"),
 * so this list is the whole of the project's authorization vocabulary.
 */
import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { oneOf } from './one-of.js';
import { users } from './users.js';
import { workspaces } from './workspaces.js';

/** Spec §21, in descending order of authority. */
export const membershipRoles = ['owner', 'admin', 'builder', 'viewer'] as const;
export type MembershipRole = (typeof membershipRoles)[number];

export const memberships = pgTable(
  'memberships',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: membershipRoles }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Also the tenant index: `workspace_id` leads the index PostgreSQL builds for it, so
    // "every member of this workspace" is an index scan. A person holds at most one role per
    // workspace.
    //
    // A table CONSTRAINT rather than a unique INDEX, because `sessions_member_workspace_fk`
    // points at this pair and drizzle-kit emits every foreign key before any
    // `CREATE UNIQUE INDEX`; a constraint is emitted inside CREATE TABLE, which is early enough.
    unique('memberships_workspace_user_key').on(table.workspaceId, table.userId),
    unique('memberships_workspace_id_key').on(table.workspaceId, table.id),
    // "Which workspaces am I in", the other direction, which the unique index above cannot serve.
    index('memberships_user_idx').on(table.userId),
    oneOf('memberships_role_valid', table.role, membershipRoles),
  ],
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
