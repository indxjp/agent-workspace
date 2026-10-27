/**
 * `agent_version_storage_grants` — the folders of storage connections one agent version grants,
 * with the connection id its own validated deploy resolved (the storage design, §05). Rows are
 * written once, in the transaction that inserts the version, and never updated; a run reads its
 * version's rows by version id, so any version (a production pointer behind `local`, an older
 * pinned session) keeps the connections it was deployed with.
 *
 * The connection foreign key cascades: deleting a connection removes every version's grant on it,
 * and a version whose `storage://` folder then has no row fails closed at run time. The delete
 * itself is refused only while the agent's *current* grants (`agent_storage_grants`) name the
 * connection, so history never blocks it. A connection recreated under the same name has a new
 * id and is never bound to an old version.
 */
import { foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { fileAccessModes } from './agent-files.js';
import { agentVersions } from './agent-versions.js';
import { createdAt, primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';
import { storageConnections } from './storage-connections.js';
import { workspaces } from './workspaces.js';

export const agentVersionStorageGrants = pgTable(
  'agent_version_storage_grants',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_version_storage_grants_version_workspace_fk`. */
    versionId: uuid('version_id').notNull(),
    /** Tenant-paired below as `agent_version_storage_grants_connection_workspace_fk`. */
    connectionId: uuid('connection_id').notNull(),
    prefix: text('prefix').notNull(),
    access: text('access', { enum: fileAccessModes }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('agent_version_storage_grants_workspace_version_folder_key').on(
      table.workspaceId,
      table.versionId,
      table.connectionId,
      table.prefix,
    ),
    index('agent_version_storage_grants_connection_idx').on(table.connectionId),
    foreignKey({
      columns: [table.versionId, table.workspaceId],
      foreignColumns: [agentVersions.id, agentVersions.workspaceId],
      name: 'agent_version_storage_grants_version_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.connectionId, table.workspaceId],
      foreignColumns: [storageConnections.id, storageConnections.workspaceId],
      name: 'agent_version_storage_grants_connection_workspace_fk',
    }).onDelete('cascade'),
    oneOf('agent_version_storage_grants_access_valid', table.access, fileAccessModes),
  ],
);

export type AgentVersionStorageGrant = typeof agentVersionStorageGrants.$inferSelect;
export type NewAgentVersionStorageGrant = typeof agentVersionStorageGrants.$inferInsert;
