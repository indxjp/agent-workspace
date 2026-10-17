/**
 * `agent_version_pointers` — issue #442 (S1-04): which version of an agent is live in an
 * environment. ADR-0101 (the platform owns agent versions) and ADR-0108.
 *
 * One row per (agent, environment). Applying a version moves the pointer in place, which is why the
 * table has an `updated_at`. The pointed version's surfaces are what is reachable by name in that
 * environment, and the repository checks surface names across pointers (C9) inside the same
 * transaction that moves one.
 *
 * Deliberate deviation from the plan, which names the FK as (version_id, agent_id): `tenancy.test.ts`
 * bucket 3 refuses any tenant-scoped reference that is not tenant-paired. So the pointer → version
 * key also carries `workspace_id`. That one constraint refuses both a cross-workspace pointer and a
 * pointer to another agent's version.
 */
import { foreignKey, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { agentVersions } from './agent-versions.js';
import { agents } from './agents.js';
import { createdAt, updatedAt } from './columns.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';

/**
 * The environments a version can be pointed at (issue #612). `local` is the agent row's working
 * copy; `production` is what public surfaces serve, and moving it touches only its pointer.
 *
 * This is the database's copy of `@indx-workspace/contracts`' `AGENT_ENVIRONMENTS`, in the same
 * order, restated here by hand.
 */
export const agentVersionEnvironments = ['local', 'production'] as const;
export type AgentVersionEnvironment = (typeof agentVersionEnvironments)[number];

export const agentVersionPointers = pgTable(
  'agent_version_pointers',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_version_pointers_agent_workspace_fk`. */
    agentId: uuid('agent_id').notNull(),
    environment: text('environment', { enum: agentVersionEnvironments }).notNull(),
    /** Tenant-paired, and agent-paired, below as `agent_version_pointers_version_fk`. */
    versionId: uuid('version_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.agentId, table.environment],
      name: 'agent_version_pointers_pkey',
    }),
    // The tenant index (tenancy rule 1). It also serves C9's "every pointer in this workspace and
    // environment" lookup.
    index('agent_version_pointers_workspace_environment_idx').on(
      table.workspaceId,
      table.environment,
    ),
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'agent_version_pointers_agent_workspace_fk',
    }).onDelete('cascade'),
    // This refuses both a cross-workspace pointer and a pointer to another agent's version.
    foreignKey({
      columns: [table.versionId, table.agentId, table.workspaceId],
      foreignColumns: [agentVersions.id, agentVersions.agentId, agentVersions.workspaceId],
      name: 'agent_version_pointers_version_fk',
    }).onDelete('cascade'),
    oneOf('agent_version_pointers_environment_valid', table.environment, agentVersionEnvironments),
  ],
);

export type AgentVersionPointer = typeof agentVersionPointers.$inferSelect;
export type NewAgentVersionPointer = typeof agentVersionPointers.$inferInsert;
