import { foreignKey, index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';

import { mcpServers } from './mcp-servers.js';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

export const projectMcpServers = pgTable(
  'project_mcp_servers',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    mcpServerId: uuid('mcp_server_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.mcpServerId] }),
    index('project_mcp_servers_workspace_idx').on(table.workspaceId),
    foreignKey({
      columns: [table.projectId, table.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'project_mcp_servers_project_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.mcpServerId, table.workspaceId],
      foreignColumns: [mcpServers.id, mcpServers.workspaceId],
      name: 'project_mcp_servers_server_workspace_fk',
    }).onDelete('cascade'),
  ],
);
