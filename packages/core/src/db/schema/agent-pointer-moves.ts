/**
 * `agent_pointer_moves` — issue #615 (80-08): the history of `agent_version_pointers`.
 */
import { sql } from 'drizzle-orm';
import { foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { agentVersionEnvironments } from './agent-version-pointers.js';
import { agentVersions } from './agent-versions.js';
import { agents } from './agents.js';
import { primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';
import { workspacePrincipals } from './workspace-principals.js';
import { workspaces } from './workspaces.js';

/**
 * Why a pointer moved (issue #615, 80-08). `set` is a `PUT /pointers` (`aw push` among its callers)
 * and an agent's first version; `promote` and `rollback` are their own routes.
 */
export const agentPointerMoveReasons = ['set', 'promote', 'rollback'] as const;
export type AgentPointerMoveReason = (typeof agentPointerMoveReasons)[number];

/**
 * `agent_pointer_moves` — issue #615 (80-08): every version an environment has pointed at, one
 * append-only row per move, written in the transaction that moves the pointer. Newest first, the
 * head is the pointer, which is what makes a rollback one step (`Release.lean`'s history).
 *
 * `moved_at` defaults to `clock_timestamp()`, not `now()`: moves are written under the pointer
 * advisory lock, and a transaction that waited for the lock must not sort before the one it
 * waited for. `moved_by` is null only for the rows the migration backfilled from existing pointers.
 */
export const agentPointerMoves = pgTable(
  'agent_pointer_moves',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_pointer_moves_agent_workspace_fk`. */
    agentId: uuid('agent_id').notNull(),
    environment: text('environment', { enum: agentVersionEnvironments }).notNull(),
    /** Tenant-paired, and agent-paired, below as `agent_pointer_moves_version_fk`. */
    versionId: uuid('version_id').notNull(),
    /** Tenant-paired below as `agent_pointer_moves_moved_by_principal_workspace_fk`. */
    movedBy: uuid('moved_by'),
    movedAt: timestamp('moved_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    reason: text('reason', { enum: agentPointerMoveReasons }).notNull(),
  },
  (table) => [
    index('agent_pointer_moves_workspace_agent_environment_idx').on(
      table.workspaceId,
      table.agentId,
      table.environment,
      table.movedAt,
    ),
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'agent_pointer_moves_agent_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.versionId, table.agentId, table.workspaceId],
      foreignColumns: [agentVersions.id, agentVersions.agentId, agentVersions.workspaceId],
      name: 'agent_pointer_moves_version_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.movedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'agent_pointer_moves_moved_by_principal_workspace_fk',
    }),
    oneOf('agent_pointer_moves_environment_valid', table.environment, agentVersionEnvironments),
    oneOf('agent_pointer_moves_reason_valid', table.reason, agentPointerMoveReasons),
  ],
);

export type AgentPointerMove = typeof agentPointerMoves.$inferSelect;
