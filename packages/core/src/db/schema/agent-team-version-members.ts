/**
 * `agent_team_version_members` — the members one agent-team version pins (ADR-0104 acceptance
 * decisions 3 and 11; issue #1516): one row per member agent, with the version of it that runs and
 * the team-local name the lead calls it by (`agent__<name>`). Written with its version and never
 * edited. That the lead is not also a member, and that a version has 1–8 members, are held by the
 * one writer (`AgentTeamRepository.createVersion`), which a CHECK on one row cannot see.
 */
import { AGENT_TEAM_MEMBER_NAME_MAX_LENGTH } from '@indx-workspace/contracts/agent-teams';
import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';

import { agentTeamVersions } from './agent-team-versions.js';
import { agentVersions } from './agent-versions.js';
import { workspaces } from './workspaces.js';

export const agentTeamVersionMembers = pgTable(
  'agent_team_version_members',
  {
    /** Tenant-paired below as `agent_team_version_members_version_workspace_fk`. */
    teamVersionId: uuid('team_version_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The member's pin, tenant-paired below as `agent_team_version_members_agent_version_fk`. */
    agentId: uuid('agent_id').notNull(),
    agentVersionId: uuid('agent_version_id').notNull(),
    /** The team-local member name: the lead calls this member as `agent__<name>`. */
    name: text('name').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.teamVersionId, table.agentId],
      name: 'agent_team_version_members_pkey',
    }),
    // The tenant index, and a member name once per version.
    unique('agent_team_version_members_workspace_version_name_key').on(
      table.workspaceId,
      table.teamVersionId,
      table.name,
    ),
    foreignKey({
      columns: [table.teamVersionId, table.workspaceId],
      foreignColumns: [agentTeamVersions.id, agentTeamVersions.workspaceId],
      name: 'agent_team_version_members_version_workspace_fk',
    }).onDelete('cascade'),
    // `sessions_agent_version_fk`'s shape: a version of this member's own agent in this workspace.
    foreignKey({
      columns: [table.agentVersionId, table.agentId, table.workspaceId],
      foreignColumns: [agentVersions.id, agentVersions.agentId, agentVersions.workspaceId],
      name: 'agent_team_version_members_agent_version_fk',
    }).onDelete('no action'),
    // A slug that keeps `mcp__agent__<name>` within the 64-character tool-name budget (ADR-0104
    // acceptance decision 3).
    check(
      'agent_team_version_members_name_valid',
      sql`${table.name} ~ '^[a-z0-9][a-z0-9_-]*$' and char_length(${table.name}) <= ${sql.raw(String(AGENT_TEAM_MEMBER_NAME_MAX_LENGTH))}`,
    ),
  ],
);

export type AgentTeamVersionMemberRow = typeof agentTeamVersionMembers.$inferSelect;
