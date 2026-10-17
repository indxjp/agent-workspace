/**
 * `runtime_verifications` — the last passing Test Runtime of one runtime driver, per workspace.
 *
 * A run is refused unless its driver has passed Test Runtime (spec §961). The pass used to live
 * only in a per-process file, so on serverless hosts the instance that ran the test was the only
 * one that knew about it. Keeping it here lets any instance serving the workspace see it. It is
 * scoped to the workspace that ran the test because the test used that workspace's runtime
 * connection credential. `configuration_key` is the digest of the deployment configuration the
 * test ran against; a pass for another key, or past `expires_at`, never counts.
 */
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { primaryKeyId } from './columns.js';
import { workspaces } from './workspaces.js';

export const runtimeVerifications = pgTable(
  'runtime_verifications',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    driverId: text('driver_id').notNull(),
    configurationKey: text('configuration_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('runtime_verifications_workspace_driver_key').on(table.workspaceId, table.driverId),
  ],
);
