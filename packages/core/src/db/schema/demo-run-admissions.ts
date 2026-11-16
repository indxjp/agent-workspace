/**
 * `demo_run_admissions` — one row per Agent Store demo run start the caps let through (internal
 * spec, "Abuse controls"): who started it and from which client address. The per-person and
 * per-client counts of the last 24 hours are read from it, so they hold across replicas and
 * restarts and survive the 24-hour demo workspace's deletion.
 *
 * Not tenant-scoped: it counts across every demo workspace a person or an address has had.
 * `tenancy-readers.test-support.ts` records the exemption. `created_at` is written by the caller
 * from its `Clock`.
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { primaryKeyId } from './columns.js';
import { users } from './users.js';

export const demoRunAdmissions = pgTable(
  'demo_run_admissions',
  {
    id: primaryKeyId(),
    /** The person who started the run. Their admissions go when the user does. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The client address the run was started from, as `http/rate-limit.ts`'s `clientBucket` keys
     * it: an HMAC of the proxy-authenticated address, or the one shared bucket. Never the address.
     */
    clientKey: text('client_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('demo_run_admissions_user_created_idx').on(table.userId, table.createdAt),
    index('demo_run_admissions_client_created_idx').on(table.clientKey, table.createdAt),
    check(
      'demo_run_admissions_client_key_shape',
      sql`length(${table.clientKey}) between 1 and 256`,
    ),
  ],
);

export type DemoRunAdmission = typeof demoRunAdmissions.$inferSelect;
