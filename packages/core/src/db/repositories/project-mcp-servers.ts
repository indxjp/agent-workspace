import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { mcpServers, projectMcpServers } from '../schema/index.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

/**
 * Thrown when a project binding names a tool connector (#586). A project binds MCP connectors
 * only: a tool connector (ADR-0113 C15) reaches a run as the agent's own assignment, through the
 * gateway. The route answers it as `400 project_connector_not_mcp`, matching on `name`.
 */
class ProjectConnectorKindError extends Error {
  public override readonly name = 'ProjectConnectorKindError';
  public readonly connectorIds: readonly string[];

  public constructor(connectorIds: readonly string[]) {
    super(`a project binds MCP connectors only; ${connectorIds.join(', ')} are tool connectors`);
    this.connectorIds = connectorIds;
  }
}

/**
 * Refuse a binding that names a tool connector of this workspace. Compared as text, so an id that
 * is not a UUID reaches the insert (and its foreign key) exactly as before.
 */
export async function refuseToolConnectorBindings(
  db: Pick<Database, 'select'>,
  workspaceId: string,
  mcpServerIds: readonly string[],
): Promise<void> {
  if (mcpServerIds.length === 0) return;
  const tools = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.workspaceId, workspaceId),
        ne(mcpServers.kind, 'mcp'),
        sql`${mcpServers.id}::text = ANY(${sql.param([...mcpServerIds])}::text[])`,
      ),
    );
  if (tools.length > 0) throw new ProjectConnectorKindError(tools.map((row) => row.id).sort());
}

export interface ProjectMcpServerRepository {
  list(projectId: string): Promise<readonly string[]>;
  add(projectId: string, mcpServerId: string): Promise<void>;
  remove(projectId: string, mcpServerId: string): Promise<void>;
}
export interface ProjectMcpServerRepositoryProvider {
  forScope(scope: WorkspaceScope): ProjectMcpServerRepository;
}
export function createDatabaseProjectMcpServerRepositoryProvider(
  db: Database,
): ProjectMcpServerRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'ProjectMcpServerRepositoryProvider');
      return {
        async list(projectId) {
          return (
            await db
              .select({ id: projectMcpServers.mcpServerId })
              .from(projectMcpServers)
              .where(
                and(
                  eq(projectMcpServers.workspaceId, workspaceId),
                  eq(projectMcpServers.projectId, projectId),
                ),
              )
              .orderBy(asc(projectMcpServers.mcpServerId))
          ).map((row) => row.id);
        },
        async add(projectId, mcpServerId) {
          await refuseToolConnectorBindings(db, workspaceId, [mcpServerId]);
          await db
            .insert(projectMcpServers)
            .values({ workspaceId, projectId, mcpServerId })
            .onConflictDoNothing();
        },
        async remove(projectId, mcpServerId) {
          await db
            .delete(projectMcpServers)
            .where(
              and(
                eq(projectMcpServers.workspaceId, workspaceId),
                eq(projectMcpServers.projectId, projectId),
                eq(projectMcpServers.mcpServerId, mcpServerId),
              ),
            );
        },
      };
    },
  };
}
