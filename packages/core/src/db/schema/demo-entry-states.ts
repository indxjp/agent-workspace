/**
 * `demo_entry_states` — the daily production test's verdict on each live Agent Store entry
 * (internal spec, "The GCP deployment"): `available`, or `maintenance` with the reason in words.
 * The store's card and Try tab read the entries under maintenance to show their recording.
 *
 * Not tenant-scoped: one row is one catalog entry of the whole site, set by the deployment's
 * operator token. `tenancy-readers.test-support.ts` records the exemption. `updated_at` is written
 * by the caller from its `Clock`.
 */
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const demoEntryStates = pgTable(
  'demo_entry_states',
  {
    /** The catalog entry's slug. */
    entry: text('entry').primaryKey(),
    state: text('state').notNull(),
    /** Why, in words; never a secret or a model's raw output. */
    reason: text('reason').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    check('demo_entry_states_state_known', sql`${table.state} in ('available', 'maintenance')`),
  ],
);

export type DemoEntryStateRow = typeof demoEntryStates.$inferSelect;
