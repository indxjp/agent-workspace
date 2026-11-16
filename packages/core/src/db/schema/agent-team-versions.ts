/**
 * `agent_team_versions` — the immutable, numbered versions of an agent team (ADR-0104 acceptance
 * decision 11; issue #1516). A version pins the lead's `(agent_id, agent_version_id)` here and each
 * member's in `agent_team_version_members`, so a team run is reproducible. Written once with its
 * members and never edited, so it has `created_at` and no `updated_at`. The lead pin has the shape
 * of `sessions_agent_version_fk` and is `NO ACTION` for the reason `agent-teams.ts` gives.
 */
import { AGENT_TEAM_MODES } from '@indx-workspace/contracts/agent-teams';
import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { agentTeams } from './agent-teams.js';
import { agentVersions } from './agent-versions.js';
import { createdAt, primaryKeyId } from './columns.js';
import { memberships } from './memberships.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';

export const agentTeamVersions = pgTable(
  'agent_team_versions',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_team_versions_team_workspace_fk`. */
    teamId: uuid('team_id').notNull(),
    /** 1, 2, 3, … per team, allocated while the team row is locked. */
    number: integer('number').notNull(),
    mode: text('mode', { enum: AGENT_TEAM_MODES }).notNull(),
    /** The lead's pin, tenant-paired below as `agent_team_versions_lead_version_fk`. */
    leadAgentId: uuid('lead_agent_id').notNull(),
    leadAgentVersionId: uuid('lead_agent_version_id').notNull(),
    /** The user who saved the version, or NULL for an API-key principal, as on the team. */
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (table) => [
    // The plan's unique (team_id, number), led by `workspace_id` so it is the tenant index; the
    // team fixes the workspace through the paired FK below, so the two are equivalent.
    unique('agent_team_versions_workspace_team_number_key').on(
      table.workspaceId,
      table.teamId,
      table.number,
    ),
    unique('agent_team_versions_id_workspace_key').on(table.id, table.workspaceId),
    // A team's versions go with it. A team is soft-deleted, so only a workspace's cascade does this.
    foreignKey({
      columns: [table.teamId, table.workspaceId],
      foreignColumns: [agentTeams.id, agentTeams.workspaceId],
      name: 'agent_team_versions_team_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.leadAgentVersionId, table.leadAgentId, table.workspaceId],
      foreignColumns: [agentVersions.id, agentVersions.agentId, agentVersions.workspaceId],
      name: 'agent_team_versions_lead_version_fk',
    }).onDelete('no action'),
    foreignKey({
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'agent_team_versions_created_by_workspace_fk',
    }),
    oneOf('agent_team_versions_mode_valid', table.mode, AGENT_TEAM_MODES),
    check('agent_team_versions_number_positive', sql`${table.number} > 0`),
  ],
);

export type AgentTeamVersionRow = typeof agentTeamVersions.$inferSelect;
