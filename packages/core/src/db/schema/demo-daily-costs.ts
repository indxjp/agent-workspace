/**
 * `demo_daily_costs` — the model cost of Agent Store demo workspaces already deleted, per UTC day
 * (internal spec, "Abuse controls"). The expiry sweep adds a workspace's spend here before it
 * deletes the workspace, so the site-wide daily cost cap still counts spend whose usage rows went
 * with the workspace.
 *
 * Not tenant-scoped: one row is the whole site's day. `tenancy-readers.test-support.ts` records the
 * exemption. `updated_at` is written by the caller from its `Clock`.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, numeric, pgTable, timestamp } from 'drizzle-orm/pg-core';

export const demoDailyCosts = pgTable(
  'demo_daily_costs',
  {
    /** The UTC day the spend happened on. */
    day: date('day', { mode: 'string' }).primaryKey(),
    /** USD, the same precision `run_usage_records.cost_usd` has. */
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
    /** Some of the carried spend had no price, so the day's sum is a floor, not a total. */
    unpricedUsage: boolean('unpriced_usage').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [check('demo_daily_costs_cost_not_negative', sql`${table.costUsd} >= 0`)],
);

export type DemoDailyCost = typeof demoDailyCosts.$inferSelect;
