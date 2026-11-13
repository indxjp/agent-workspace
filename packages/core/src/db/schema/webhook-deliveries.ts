/**
 * `webhook_deliveries` — the outbox of run-outcome webhooks (N-3, issue #250, ADR-SDK-18-N3-250
 * D3, D4). The run's stop writes one `pending` row per subscribed webhook in the same transaction
 * as the status update (`runs.ts` `stopIn`), so a committed terminal run always has its deliveries
 * and a rolled-back stop has none.
 *
 * The unique `(workspace_id, webhook_id, run_id)` is the dedup by run: at most one delivery per
 * webhook and run. A webhook id already fixes its workspace, so this is the ADR's
 * `unique (webhook_id, run_id)` with the tenant column leading, as `trigger_deliveries` does.
 *
 * A worker claims due rows across tenants with `FOR UPDATE SKIP LOCKED`; the claim bumps
 * `attempts` and moves `next_attempt_at` past the attempt timeout, so a replica that dies
 * mid-attempt leaves a row that becomes due again by itself. `attempts` doubles as the claim token
 * a result is recorded against. `last_error` is a code, never a receiver's body.
 */
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';
import { runs } from './runs.js';
import { webhookEventTypeArray, webhooks, type WebhookEventType } from './webhooks.js';
import { workspaces } from './workspaces.js';

export const webhookDeliveryStates = ['pending', 'delivered', 'failed'] as const;
export type WebhookDeliveryState = (typeof webhookDeliveryStates)[number];

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    /** The event id a receiver sees as `webhook-id`, stable across retries (ADR D3). */
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `webhook_deliveries_webhook_workspace_fk`; no reference of its own. */
    webhookId: uuid('webhook_id').notNull(),
    /** Tenant-paired below as `webhook_deliveries_run_workspace_fk`; no reference of its own. */
    runId: uuid('run_id').notNull(),
    eventType: text('event_type').notNull().$type<WebhookEventType>(),
    state: text('state', { enum: webhookDeliveryStates }).notNull().default('pending'),
    /** Attempts claimed so far, the one in flight included. */
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_webhook_run_key').on(
      table.workspaceId,
      table.webhookId,
      table.runId,
    ),
    // The worker's claim scan: due pending rows, oldest due first, across tenants.
    index('webhook_deliveries_pending_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.state} = 'pending'`),
    // The retention pass deletes settled rows by age (ADR D4).
    index('webhook_deliveries_settled_created_idx')
      .on(table.createdAt)
      .where(sql`${table.state} <> 'pending'`),
    foreignKey({
      columns: [table.workspaceId, table.webhookId],
      foreignColumns: [webhooks.workspaceId, webhooks.id],
      name: 'webhook_deliveries_webhook_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
      name: 'webhook_deliveries_run_workspace_fk',
    }).onDelete('cascade'),
    oneOf('webhook_deliveries_state_valid', table.state, webhookDeliveryStates),
    check(
      'webhook_deliveries_event_type_valid',
      sql`${table.eventType} = any(${webhookEventTypeArray()})`,
    ),
    check(
      'webhook_deliveries_delivered_shape',
      sql`(${table.state} = 'delivered') = (${table.deliveredAt} is not null)`,
    ),
  ],
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
