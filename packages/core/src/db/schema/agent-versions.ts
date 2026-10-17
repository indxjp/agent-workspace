/**
 * `agent_versions` — issue #442 (S1-04): the immutable, numbered history of one agent's definition.
 * ADR-0101 (the platform owns agent versions) and ADR-0108.
 *
 * A version is written once and never edited, so the table has `created_at` and no `updated_at`.
 * `number` counts from 1 per agent. The repository allocates it as `max(number) + 1` while it holds
 * the agent row locked, and the unique key below is the backstop if two writers race anyway.
 *
 * Both references are tenant-paired (W1-DB-01 decision 14). The agent is referenced as
 * `(agent_id, workspace_id)`, and the author as `(workspace_id, created_by_principal_id)` →
 * `workspace_principals`, the same as `agents.owner_principal_id`. `tenancy.test.ts` holds that
 * for this table as for every other.
 */
import { AGENT_VERSION_VIAS, type AgentVersionVia } from '@indx-workspace/contracts/agent-versions';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { createdAt, primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';
import { workspacePrincipals } from './workspace-principals.js';
import { workspaces } from './workspaces.js';

/** How a version was written: from the web UI, by `aw push`, or through the public API. */
export { AGENT_VERSION_VIAS as agentVersionVias, type AgentVersionVia };

export const agentVersions = pgTable(
  'agent_versions',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_versions_agent_workspace_fk`; no reference of its own. */
    agentId: uuid('agent_id').notNull(),
    /** 1, 2, 3, … per agent. Never reused, because a version is never deleted on its own. */
    number: integer('number').notNull(),
    /** The author's one-line description of what changed. */
    summary: text('summary').notNull(),
    via: text('via', { enum: AGENT_VERSION_VIAS }).notNull(),
    /**
     * The agent definition as it was written. The server parses it with the contracts'
     * `AgentVersionBodySchema` when it reads it (R-15 §4). Core does not parse it, so the
     * column is typed `unknown` here.
     */
    body: jsonb('body').notNull(),
    /** Tenant-paired below as `agent_versions_created_by_principal_workspace_fk`. */
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // The plan's unique (agent_id, number). It is equivalent, because agent_id fixes workspace_id
    // through the paired FK below, and `workspace_id` leads it so it is this table's tenant index
    // (tenancy rule 1).
    unique('agent_versions_workspace_agent_number_key').on(
      table.workspaceId,
      table.agentId,
      table.number,
    ),
    unique('agent_versions_id_workspace_key').on(table.id, table.workspaceId),
    // The target of `agent_version_pointers_version_fk`. It carries `workspace_id` because
    // `tenancy.test.ts` bucket 3 requires every tenant-scoped reference to be tenant-paired.
    unique('agent_versions_id_agent_workspace_key').on(table.id, table.agentId, table.workspaceId),
    // Deleting an agent takes its history with it: a version has no meaning without its agent.
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'agent_versions_agent_workspace_fk',
    }).onDelete('cascade'),
    // No cascade and no SET NULL. A version is immutable and the contracts' resource always names
    // its author, so the author is never cleared or erased. Removing a member who authored any
    // version is therefore refused by this FK, as removing an owner is by
    // `agents_owner_principal_workspace_fk` and its siblings, until RF-202 defines offboarding.
    foreignKey({
      columns: [table.workspaceId, table.createdByPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'agent_versions_created_by_principal_workspace_fk',
    }),
    oneOf('agent_versions_via_valid', table.via, AGENT_VERSION_VIAS),
    check('agent_versions_number_positive', sql`${table.number} > 0`),
  ],
);

export type AgentVersion = typeof agentVersions.$inferSelect;
export type NewAgentVersion = typeof agentVersions.$inferInsert;
