/**
 * `storage_connections` — a bucket or folder an admin connected (the storage design, §05 and §06
 * Phase 5). The row holds the non-secret half only: the credential lives in the secret store under
 * `STORAGE_CONNECTION_<ID>`, so this table has no column that could carry one.
 */
import { STORAGE_CONNECTION_PROVIDERS } from '@indx-workspace/contracts/storage-connections';
import { boolean, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';

export const storageConnections = pgTable(
  'storage_connections',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider', { enum: STORAGE_CONNECTION_PROVIDERS }).notNull(),
    url: text('url').notNull(),
    allowedPrefixes: text('allowed_prefixes').array().notNull(),
    writeAllowed: boolean('write_allowed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('storage_connections_workspace_name_key').on(table.workspaceId, table.name),
    // The target a grant's composite foreign key will need; `id` is already the primary key.
    unique('storage_connections_id_workspace_key').on(table.id, table.workspaceId),
    oneOf('storage_connections_provider_valid', table.provider, STORAGE_CONNECTION_PROVIDERS),
  ],
);

export type StorageConnection = typeof storageConnections.$inferSelect;
export type NewStorageConnection = typeof storageConnections.$inferInsert;
