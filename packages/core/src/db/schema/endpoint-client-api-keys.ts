import { foreignKey, index, pgTable, uuid } from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys.js';
import { endpointClients } from './endpoint-clients.js';
import { workspaces } from './workspaces.js';

/**
 * Binds an API key to the client it is the static bearer of. A key has at most one row here and a
 * bound key can only reach its client's resource; the row dies with the client or the key.
 *
 * This is a table rather than an `api_keys.endpoint_client_id` column: `api-keys.ts` is imported by
 * `workspace-principals.ts`, which this file imports for the acts-for foreign key, so a column on
 * `api_keys` would close a schema module cycle that `pnpm architecture:check` forbids.
 */
export const endpointClientApiKeys = pgTable(
  'endpoint_client_api_keys',
  {
    apiKeyId: uuid('api_key_id').primaryKey(),
    clientId: uuid('client_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('endpoint_client_api_keys_workspace_client_idx').on(table.workspaceId, table.clientId),
    foreignKey({
      columns: [table.workspaceId, table.clientId],
      foreignColumns: [endpointClients.workspaceId, endpointClients.id],
      name: 'endpoint_client_api_keys_client_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.apiKeyId],
      foreignColumns: [apiKeys.workspaceId, apiKeys.id],
      name: 'endpoint_client_api_keys_api_key_workspace_fk',
    }).onDelete('cascade'),
  ],
);
