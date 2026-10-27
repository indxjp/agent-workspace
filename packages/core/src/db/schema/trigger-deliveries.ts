/**
 * `trigger_deliveries` — one row per `(trigger, delivery_key)` slot a firing has claimed
 * (ADR-0144 D4, D5). The unique index is the dedupe: a webhook's `Idempotency-Key` or a schedule's
 * `scheduled_at` is claimed before the run starts, so a retry, a second replica or a duplicate cron
 * delivery finds the slot taken and starts nothing.
 *
 * `run_id` is NULL between the claim and the run's start, then names the run so a repeat can answer
 * with the first firing's run id. PostgreSQL cannot express a 24-hour unique key, so the repository
 * reclaims an expired slot in place instead of the schema pruning it.
 */
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId } from './columns.js';
import { runs } from './runs.js';
import { triggers } from './triggers.js';
import { workspaces } from './workspaces.js';

export const triggerDeliveries = pgTable(
  'trigger_deliveries',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `trigger_deliveries_trigger_workspace_fk`; no reference of its own. */
    triggerId: uuid('trigger_id').notNull(),
    deliveryKey: text('delivery_key').notNull(),
    /** Tenant-paired below as `trigger_deliveries_run_workspace_fk`; NULL until the run starts. */
    runId: uuid('run_id'),
    createdAt: createdAt(),
  },
  (table) => [
    // `workspace_id` leads so the tenant scan is served; a trigger id already fixes its workspace,
    // so this is the issue's unique `(trigger_id, delivery_key)`.
    uniqueIndex('trigger_deliveries_trigger_key_key').on(
      table.workspaceId,
      table.triggerId,
      table.deliveryKey,
    ),
    // The rate limit counts a trigger's recent deliveries (ADR-0144 D2 limit 2).
    index('trigger_deliveries_trigger_created_idx').on(
      table.workspaceId,
      table.triggerId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.workspaceId, table.triggerId],
      foreignColumns: [triggers.workspaceId, triggers.id],
      name: 'trigger_deliveries_trigger_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
      name: 'trigger_deliveries_run_workspace_fk',
    }).onDelete('cascade'),
    check(
      'trigger_deliveries_key_length',
      sql`char_length(${table.deliveryKey}) between 1 and 255`,
    ),
  ],
);

export type TriggerDelivery = typeof triggerDeliveries.$inferSelect;
export type NewTriggerDelivery = typeof triggerDeliveries.$inferInsert;
