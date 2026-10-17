import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys.js';
import { createdAt, primaryKeyId } from './columns.js';
import { memberships } from './memberships.js';
import { workspaces } from './workspaces.js';

export const workspacePrincipalKinds = ['membership', 'api_key'] as const;
export type WorkspacePrincipalKind = (typeof workspacePrincipalKinds)[number];

/**
 * The exact authenticated actor or durable owner within a workspace. A principal has one source:
 * a human Membership or a machine API key. The source pair is tenant-paired so neither an
 * application bug nor a hand-written query can attach an identity from another workspace.
 */
export const workspacePrincipals = pgTable(
  'workspace_principals',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: workspacePrincipalKinds }).notNull(),
    membershipId: uuid('membership_id'),
    apiKeyId: uuid('api_key_id'),
    activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    /**
     * The membership principal an API-key principal acts for (issue #509, S1-24). Set only for the
     * per-run local runtime key `aw dev` mints (ADR-0109, S1-21): what that key writes is owned by
     * the bootstrap admin who issued it, not by the short-lived key, so a swept or expired key
     * never strands an agent, session or share. Null for every hosted key and every membership.
     *
     * The column lives here rather than on `api_keys`: a reference from `api_keys` to this table
     * would close a module and foreign-key cycle (this file already imports `api-keys.ts`), while a
     * self-reference inside one table is no cycle. "Acts for" is also a fact about the principal.
     * The pair FK is tenant-paired and NO ACTION, the same as every owner FK, so the acted-for
     * membership principal cannot be deleted while a key principal that acted for it remains.
     */
    actsForPrincipalId: uuid('acts_for_principal_id'),
    createdAt: createdAt(),
  },
  (table) => [
    unique('workspace_principals_workspace_id_key').on(table.workspaceId, table.id),
    unique('workspace_principals_workspace_membership_key').on(
      table.workspaceId,
      table.membershipId,
    ),
    unique('workspace_principals_workspace_api_key_key').on(table.workspaceId, table.apiKeyId),
    index('workspace_principals_workspace_revoked_idx').on(table.workspaceId, table.revokedAt),
    foreignKey({
      columns: [table.workspaceId, table.membershipId],
      foreignColumns: [memberships.workspaceId, memberships.id],
      name: 'workspace_principals_membership_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.apiKeyId],
      foreignColumns: [apiKeys.workspaceId, apiKeys.id],
      name: 'workspace_principals_api_key_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.actsForPrincipalId],
      foreignColumns: [table.workspaceId, table.id],
      name: 'workspace_principals_acts_for_workspace_fk',
    }),
    check('workspace_principals_kind_valid', sql`${table.kind} in ('membership', 'api_key')`),
    check(
      'workspace_principals_source_xor',
      sql`(${table.kind} = 'membership' and ${table.membershipId} is not null and ${table.apiKeyId} is null)
        or (${table.kind} = 'api_key' and ${table.apiKeyId} is not null and ${table.membershipId} is null)`,
    ),
    check(
      'workspace_principals_revoked_after_activation',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.activatedAt}`,
    ),
    check(
      'workspace_principals_acts_for_api_key_only',
      sql`${table.actsForPrincipalId} is null or ${table.kind} = 'api_key'`,
    ),
    check(
      'workspace_principals_acts_for_not_self',
      sql`${table.actsForPrincipalId} is null or ${table.actsForPrincipalId} <> ${table.id}`,
    ),
  ],
);

export type WorkspacePrincipal = typeof workspacePrincipals.$inferSelect;
export type NewWorkspacePrincipal = typeof workspacePrincipals.$inferInsert;
