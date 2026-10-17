import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryKeyId } from './columns.js';
import { memberships } from './memberships.js';
import { oneOf } from './one-of.js';
import { users } from './users.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

export const shareSubjectTypes = ['agent', 'session', 'project', 'skill'] as const;
export const shareVisibilities = ['private', 'workspace', 'public'] as const;
export const shareModes = ['definition', 'runnable'] as const;
export type ShareSubjectType = (typeof shareSubjectTypes)[number];
export type ShareVisibility = (typeof shareVisibilities)[number];
export type ShareMode = (typeof shareModes)[number];

export const shares = pgTable(
  'shares',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    subjectType: text('subject_type', { enum: shareSubjectTypes }).notNull(),
    subjectId: text('subject_id').notNull(),
    subjectLabel: text('subject_label').notNull(),
    visibility: text('visibility', { enum: shareVisibilities }).notNull(),
    mode: text('mode', { enum: shareModes }),
    snapshot: jsonb('snapshot'),
    include: jsonb('include').$type<Record<string, boolean>>().notNull().default({}),
    budgetCapUsd: numeric('budget_cap_usd', { precision: 12, scale: 4 }),
    spentUsd: numeric('spent_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    stopped: boolean('stopped').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    passphraseHash: text('passphrase_hash'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    publisherPrincipalId: uuid('publisher_principal_id').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('shares_id_workspace_key').on(table.id, table.workspaceId),
    unique('shares_token_key').on(table.token),
    index('shares_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('shares_publisher_principal_idx').on(table.publisherPrincipalId),
    oneOf('shares_subject_type_valid', table.subjectType, shareSubjectTypes),
    oneOf('shares_visibility_valid', table.visibility, shareVisibilities),
    check(
      'shares_mode_valid',
      sql`${table.mode} is null or ${table.mode} in ('definition', 'runnable')`,
    ),
    check('shares_agent_mode_only', sql`${table.mode} is null or ${table.subjectType} = 'agent'`),
    check(
      'shares_budget_nonnegative',
      sql`${table.budgetCapUsd} is null or ${table.budgetCapUsd} >= 0`,
    ),
    check('shares_spend_nonnegative', sql`${table.spentUsd} >= 0`),
    check('shares_subject_id_not_blank', sql`length(btrim(${table.subjectId})) > 0`),
    foreignKey({
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'shares_creator_workspace_fk',
    }).onDelete('no action'),
    foreignKey({
      columns: [table.workspaceId, table.publisherPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'shares_publisher_principal_workspace_fk',
    }).onDelete('no action'),
  ],
);

export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
