/**
 * `agent_grants` — an explicit Viewer "permitted agent" grant (spec §21, §27; issue #117).
 *
 * §21's Viewer clause is "Run **permitted** agents and view their own sessions", and until this
 * table existed nothing in the schema could populate that word — `decide.ts`'s `permitted` grant
 * denied unconditionally, by design, because there was no mechanism (ADR-0031,
 * `docs/adr/W2-CP-06-the-four-roles-and-their-permission-split.md`). This table is that mechanism,
 * and it grants exactly one capability: a named user may run a named agent. It is not a general
 * ACL — there is no `access` column, because "permitted" is binary in §21's own sentence.
 *
 * Membership revocation is enforced by the composite foreign key to `memberships`, not by a
 * background job: `agent_grants_member_workspace_fk` is `ON DELETE CASCADE`, so removing a
 * membership removes every grant it held in the same statement, atomically. Deleting the agent
 * cascades the same way, because a grant on a row that no longer exists is not a fact about
 * anything.
 */
import { foreignKey, index, pgTable, unique, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { createdAt, primaryKeyId } from './columns.js';
import { memberships } from './memberships.js';
import { workspaces } from './workspaces.js';

export const agentGrants = pgTable(
  'agent_grants',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_grants_agent_workspace_fk`; no reference of its own. */
    agentId: uuid('agent_id').notNull(),
    /** Tenant-paired below as `agent_grants_member_workspace_fk`; no reference of its own. */
    userId: uuid('user_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // The natural key: granting the same agent to the same user twice is not a second grant.
    unique('agent_grants_workspace_agent_user_key').on(
      table.workspaceId,
      table.agentId,
      table.userId,
    ),
    // "Who can run this agent" — an agent's detail panel reads this direction.
    index('agent_grants_agent_idx').on(table.agentId),
    // "What can this person run" — the Viewer's own run-permission check reads this direction.
    index('agent_grants_user_idx').on(table.userId),
    // Deleting the agent takes its grants with it: a grant on a row that no longer exists is not
    // a fact about anything.
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'agent_grants_agent_workspace_fk',
    }).onDelete('cascade'),
    // Revocation is this constraint, not a background job (this file's header, and the issue's
    // "removing a membership immediately removes ... permitted access").
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'agent_grants_member_workspace_fk',
    }).onDelete('cascade'),
  ],
);

export type AgentGrant = typeof agentGrants.$inferSelect;
export type NewAgentGrant = typeof agentGrants.$inferInsert;
