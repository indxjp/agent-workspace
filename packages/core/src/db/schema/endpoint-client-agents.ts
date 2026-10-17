import { foreignKey, index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { endpointClients } from './endpoint-clients.js';
import { workspaces } from './workspaces.js';

/** The agents an endpoint client may reach: exactly one for `a2a-agent`, 1-64 for `mcp-project`. */
export const endpointClientAgents = pgTable(
  'endpoint_client_agents',
  {
    clientId: uuid('client_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.agentId] }),
    index('endpoint_client_agents_workspace_idx').on(table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.clientId],
      foreignColumns: [endpointClients.workspaceId, endpointClients.id],
      name: 'endpoint_client_agents_client_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.agentId, table.workspaceId],
      foreignColumns: [agents.id, agents.workspaceId],
      name: 'endpoint_client_agents_agent_workspace_fk',
    }).onDelete('cascade'),
  ],
);
