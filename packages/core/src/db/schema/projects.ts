import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { modelConnections } from './model-connections.js';
import { oneOf } from './one-of.js';
import { users } from './users.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

export const projectVisibilities = ['private', 'workspace', 'public'] as const;
export type ProjectVisibility = (typeof projectVisibilities)[number];

export const projects = pgTable(
  'projects',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    instructions: text('instructions'),
    defaultAgentId: uuid('default_agent_id'),
    visibility: text('visibility', { enum: projectVisibilities }).notNull().default('private'),
    /**
     * The project-level model default (issue #129): second rung of the resolution ladder, above
     * the workspace default and below an agent's own override. See `workspaces.ts`'s
     * `defaultModelConnectionId` for the shape this mirrors, including why `SET NULL` here never
     * needs to touch {@link defaultModel} on its own — the repository nulls both together.
     */
    defaultModelConnectionId: uuid('default_model_connection_id').references(
      () => modelConnections.id,
      { onDelete: 'set null' },
    ),
    /** The provider-side model id paired with {@link defaultModelConnectionId}. NULL together. */
    defaultModel: text('default_model'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    /**
     * Issue #182: the durable archived state. NULL means active — the same shape and semantics as
     * `workspaces.ts`'s own `archivedAt`, including no CHECK constraint, because
     * `ProjectRepository.archive`'s `coalesce(archived_at, now())` cannot produce a timestamp
     * before `created_at`. Only `archive`/`restore` write this column; it is deliberately absent
     * from `UpdateProjectPatch`, so no PATCH route can set or clear it.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('projects_id_workspace_key').on(table.id, table.workspaceId),
    uniqueIndex('projects_workspace_name_key').on(table.workspaceId, table.name),
    index('projects_default_agent_idx').on(table.defaultAgentId),
    index('projects_owner_principal_idx').on(table.ownerPrincipalId),
    oneOf('projects_visibility_valid', table.visibility, projectVisibilities),
    check('projects_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    // #129, mirroring `workspaces_default_model_pair`.
    check(
      'projects_default_model_pair',
      sql`(${table.defaultModelConnectionId} is null) = (${table.defaultModel} is null)`,
    ),
    foreignKey({
      columns: [table.defaultAgentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'projects_default_agent_workspace_fk',
    }).onDelete('set null'),
    // §25: a project must not be able to default to another workspace's connection.
    foreignKey({
      columns: [table.defaultModelConnectionId, table.workspaceId],
      foreignColumns: [modelConnections.id, modelConnections.workspaceId],
      name: 'projects_default_model_connection_workspace_fk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.ownerPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'projects_owner_principal_workspace_fk',
    }),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
