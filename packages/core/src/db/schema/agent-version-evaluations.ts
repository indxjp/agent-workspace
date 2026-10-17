/**
 * `agent_version_evaluations` — issue #618 (80-11): one scored run of an evaluation's cases against
 * one agent version. The server runs and scores the cases itself, which is what lets a promotion
 * gate trust the row.
 *
 * Append-only, with `created_at` and no `updated_at`. Both references are tenant-paired: the
 * version as `(version_id, workspace_id)`, cascading so a version's evaluations go with it, and the
 * author as `(workspace_id, created_by_principal_id)` → `workspace_principals` with no cascade, as
 * `agent_versions` names its author.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { agentVersions } from './agent-versions.js';
import { createdAt, primaryKeyId } from './columns.js';
import { workspacePrincipals } from './workspace-principals.js';
import { workspaces } from './workspaces.js';

export const agentVersionEvaluations = pgTable(
  'agent_version_evaluations',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_version_evaluations_version_workspace_fk`. */
    versionId: uuid('version_id').notNull(),
    /** `passed / total`, rounded to four places. Read back as a string by `pg`. */
    score: numeric('score', { precision: 5, scale: 4 }).notNull(),
    passed: integer('passed').notNull(),
    total: integer('total').notNull(),
    /**
     * The cases as they were sent, and each case's result. The server parses them with the
     * contracts' schemas when it reads them; core cannot import those, so both are `unknown` here.
     */
    casesSnapshot: jsonb('cases_snapshot').notNull(),
    results: jsonb('results').notNull(),
    /** Tenant-paired below as `agent_version_evaluations_created_by_principal_workspace_fk`. */
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: createdAt(),
    /**
     * `running` for an evaluation run (issue #799) that still has cases to run, `completed` for
     * every other row. Only a run changes after insert, and only until it completes.
     */
    status: text('status').notNull().default('completed'),
    /** A run's lease: the time before which no other request may advance it; `NULL` when free. */
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('agent_version_evaluations_workspace_version_idx').on(table.workspaceId, table.versionId),
    foreignKey({
      columns: [table.versionId, table.workspaceId],
      foreignColumns: [agentVersions.id, agentVersions.workspaceId],
      name: 'agent_version_evaluations_version_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.createdByPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'agent_version_evaluations_created_by_principal_workspace_fk',
    }),
    check(
      'agent_version_evaluations_counts',
      sql`${table.total} > 0 and ${table.passed} >= 0 and ${table.passed} <= ${table.total}`,
    ),
    check(
      'agent_version_evaluations_status_valid',
      sql`${table.status} in ('running', 'completed')`,
    ),
  ],
);

export type AgentVersionEvaluation = typeof agentVersionEvaluations.$inferSelect;
