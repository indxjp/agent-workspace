/**
 * `agent_skills` — which skills an agent may use (spec §7, §17 Step 3, §27).
 *
 * §7's "assign it to agents" and §17 Step 3's "Capabilities" are the same fact seen from two
 * ends, and this is that fact. A link is created or removed; it is never edited, so the table
 * carries `created_at` and no `updated_at` — an `updated_at` that nothing can move is a column
 * that tells a reader something untrue.
 *
 * Both references are tenant-paired (W1-DB-01 decision 14): `(agent_id, workspace_id)` and
 * `(skill_id, workspace_id)` each have to resolve to one row, so an agent in one workspace
 * cannot be handed a skill from another. `tenancy.test.ts` is what holds that for every table,
 * this one included, without anybody remembering to check.
 */
import { foreignKey, index, integer, pgTable, unique, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { createdAt, primaryKeyId } from './columns.js';
import { skillRevisions } from './skill-revisions.js';
import { skills } from './skills.js';
import { workspaces } from './workspaces.js';

export const agentSkills = pgTable(
  'agent_skills',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_skills_agent_workspace_fk`; no reference of its own. */
    agentId: uuid('agent_id').notNull(),
    /** Tenant-paired below as `agent_skills_skill_workspace_fk`; no reference of its own. */
    skillId: uuid('skill_id').notNull(),
    /**
     * The published revision this agent is pinned to (SDK-19, N-1); `NULL` follows the skill's
     * current content. Tenant-paired below as `agent_skills_skill_revision_fk`, which a `NULL`
     * here does not check (MATCH SIMPLE).
     */
    revision: integer('revision'),
    createdAt: createdAt(),
  },
  (table) => [
    // The natural key, and the tenant index: `workspace_id` leads it. Assigning the same skill
    // twice is not a second assignment.
    unique('agent_skills_workspace_agent_skill_key').on(
      table.workspaceId,
      table.agentId,
      table.skillId,
    ),
    // §7's "Assigned Agents" reads this direction, which the unique key above cannot serve.
    index('agent_skills_skill_idx').on(table.skillId),
    // Deleting an agent takes its assignments: the link has no meaning without either end, and
    // §19.5 rule 3 requires an agent to stay deletable.
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'agent_skills_agent_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.skillId, table.workspaceId],
      foreignColumns: [skills.id, skills.workspaceId],
      name: 'agent_skills_skill_workspace_fk',
    }).onDelete('cascade'),
    // The target columns are in the order of `skill_revisions_workspace_skill_number_key`, so
    // the reference names that key column for column (the formal model's exact-key rule). It
    // cascades like every other link reference: a revision only goes with its skill, which takes
    // the assignment anyway.
    foreignKey({
      columns: [table.workspaceId, table.skillId, table.revision],
      foreignColumns: [skillRevisions.workspaceId, skillRevisions.skillId, skillRevisions.number],
      name: 'agent_skills_skill_revision_fk',
    }).onDelete('cascade'),
  ],
);

export type AgentSkill = typeof agentSkills.$inferSelect;
export type NewAgentSkill = typeof agentSkills.$inferInsert;
