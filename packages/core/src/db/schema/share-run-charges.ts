import { sql } from 'drizzle-orm';
import { check, foreignKey, index, numeric, pgTable, uuid } from 'drizzle-orm/pg-core';

import { createdAt, updatedAt } from './columns.js';
import { runs } from './runs.js';
import { shares } from './shares.js';
import { workspaces } from './workspaces.js';

/**
 * Durable attribution from one public execution to the share that funded it.
 *
 * `run_id` is the primary key because a run may be funded by at most one share. The accumulated
 * charge mirrors the run's six-decimal usage ledger and is advanced in the same transaction as
 * `runs.cost_usd` and `shares.spent_usd`; it is therefore both an idempotency record and an audit
 * point for reconciliation.
 */
export const shareRunCharges = pgTable(
  'share_run_charges',
  {
    runId: uuid('run_id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    shareId: uuid('share_id').notNull(),
    chargedUsd: numeric('charged_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('share_run_charges_workspace_share_idx').on(table.workspaceId, table.shareId),
    foreignKey({
      columns: [table.shareId, table.workspaceId],
      foreignColumns: [shares.id, shares.workspaceId],
      name: 'share_run_charges_share_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
      name: 'share_run_charges_run_workspace_fk',
    }).onDelete('cascade'),
    check('share_run_charges_nonnegative', sql`${table.chargedUsd} >= 0`),
  ],
);
