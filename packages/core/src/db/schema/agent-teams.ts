/**
 * `agent_teams` — the agent-team resource (ADR-0104, accepted for `handoff` mode; issue #1516;
 * spec 04 §5.18), with `agent_team_versions` and `agent_team_version_members` beside it.
 *
 * A team is a named, owned row. What it runs is its newest **version**: an immutable, numbered
 * snapshot that pins the lead's and every member's `(agent_id, agent_version_id)` (acceptance
 * decision 11), so a team run is reproducible however its agents change later.
 *
 * Every row of the three tables carries `workspace_id`, and every reference is tenant-paired
 * (W1-DB-01 decision 14): a pin is `(agent_version_id, agent_id, workspace_id) → agent_versions`,
 * the shape of `sessions_agent_version_fk`, so a team cannot pin another agent's or another
 * tenant's version.
 *
 * Deleting a team is a soft delete (`deleted_at`): its versions stay, because a run may later name
 * one, and its name is free again (`agent_teams_workspace_name_key` covers live teams only). The
 * pins are `NO ACTION`: an agent version is only deleted by its agent's cascade, so an agent that a
 * team version pins cannot be deleted while the pin exists; a workspace's own cascade removes both
 * in one statement, which `NO ACTION` allows (see `sessions_member_workspace_fk`).
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { memberships } from './memberships.js';
import { workspacePrincipals } from './workspace-principals.js';
import { workspaces } from './workspaces.js';

export const agentTeams = pgTable(
  'agent_teams',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Trimmed and bounded by the contract; unique among the workspace's live teams. */
    name: text('name').notNull(),
    description: text('description'),
    /** Tenant-paired below as `agent_teams_owner_principal_workspace_fk`, as on `agents`. */
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    /**
     * The user who created the team, or NULL when an API-key principal did — `agents.created_by`'s
     * meaning. Tenant-paired below against `memberships`, as `agents_created_by_workspace_fk` is.
     */
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** When the team was deleted; NULL while it is live. Nothing un-deletes it. */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    // The tenant index, and one live team per name in a workspace.
    uniqueIndex('agent_teams_workspace_name_key')
      .on(table.workspaceId, table.name)
      .where(sql`${table.deletedAt} is null`),
    // The target of the tenant-paired reference from `agent_team_versions`. A constraint, not an
    // index, for the reason `agents_id_workspace_key` gives.
    unique('agent_teams_id_workspace_key').on(table.id, table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.ownerPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'agent_teams_owner_principal_workspace_fk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'agent_teams_created_by_workspace_fk',
    }),
    check('agent_teams_name_not_blank', sql`length(btrim(${table.name})) > 0`),
  ],
);

export type AgentTeam = typeof agentTeams.$inferSelect;
export type NewAgentTeam = typeof agentTeams.$inferInsert;
