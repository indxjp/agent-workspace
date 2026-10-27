/**
 * `agent_storage_grants` — the folders of storage connections an agent may reach (the storage
 * design, §05). Written only by a materialised version, with the connection id the deploy
 * resolved by name; the table sits beside `agent_files` and is replaced with it. These are the
 * agent's *current* grants (what a connection delete is refused on); each version's own
 * grants, which a run reads, are `agent_version_storage_grants`.
 *
 * The connection foreign key has no `ON DELETE` action on purpose: deleting a connection that a
 * version still grants is refused by the database (`NO ACTION`), so a grant never dangles even if
 * a caller forgets the `isConnectionGranted` check.
 */
import { foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { fileAccessModes } from './agent-files.js';
import { agents } from './agents.js';
import { createdAt, primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';
import { storageConnections } from './storage-connections.js';
import { workspaces } from './workspaces.js';

export const agentStorageGrants = pgTable(
  'agent_storage_grants',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `agent_storage_grants_agent_workspace_fk`. */
    agentId: uuid('agent_id').notNull(),
    /** Tenant-paired below as `agent_storage_grants_connection_workspace_fk`. */
    connectionId: uuid('connection_id').notNull(),
    prefix: text('prefix').notNull(),
    access: text('access', { enum: fileAccessModes }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('agent_storage_grants_workspace_agent_folder_key').on(
      table.workspaceId,
      table.agentId,
      table.connectionId,
      table.prefix,
    ),
    // "Is this connection granted to any agent" — what a connection delete asks.
    index('agent_storage_grants_connection_idx').on(table.connectionId),
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'agent_storage_grants_agent_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.connectionId, table.workspaceId],
      foreignColumns: [storageConnections.id, storageConnections.workspaceId],
      name: 'agent_storage_grants_connection_workspace_fk',
    }),
    oneOf('agent_storage_grants_access_valid', table.access, fileAccessModes),
  ],
);

export type AgentStorageGrant = typeof agentStorageGrants.$inferSelect;
export type NewAgentStorageGrant = typeof agentStorageGrants.$inferInsert;
