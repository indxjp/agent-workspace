import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentFiles, type FileAccessMode } from '../schema/agent-files.js';
import { agentMcpServers } from '../schema/agent-mcp-servers.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agents, parseAgentPermissions } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { skills } from '../schema/skills.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export interface AgentResourceAssignments {
  readonly files: readonly { readonly fileId: string; readonly access: FileAccessMode }[];
  readonly skillIds: readonly string[];
  readonly connectorIds: readonly string[];
}

export type ReplaceAgentResourcesOutcome =
  | { readonly kind: 'updated'; readonly assignments: AgentResourceAssignments }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unknown-file'; readonly id: string }
  | { readonly kind: 'unknown-skill'; readonly id: string }
  | { readonly kind: 'unknown-connector'; readonly id: string };

export interface AgentResourceRepository {
  get(agentId: string): Promise<AgentResourceAssignments | null>;
  replace(
    agentId: string,
    assignments: AgentResourceAssignments,
  ): Promise<ReplaceAgentResourcesOutcome>;
}

export interface AgentResourceRepositoryProvider {
  forScope(scope: WorkspaceScope): AgentResourceRepository;
}

export function createDatabaseAgentResourceRepositoryProvider(
  db: Database,
): AgentResourceRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): AgentResourceRepository {
      const checked = requireWorkspaceScope(scope, 'AgentResourceRepositoryProvider');
      const workspaceId = checked.workspaceId;

      const read = async (agentId: string): Promise<AgentResourceAssignments | null> => {
        const agent = await db
          .select({ permissions: agents.permissions })
          .from(agents)
          .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
          .limit(1);
        const agentRow = agent[0];
        if (agentRow === undefined) return null;
        const [fileRows, skillRows, connectorRows] = await Promise.all([
          db
            .select({ fileId: agentFiles.fileId, access: agentFiles.access })
            .from(agentFiles)
            .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.agentId, agentId)))
            .orderBy(asc(agentFiles.fileId)),
          db
            .select({ id: agentSkills.skillId })
            .from(agentSkills)
            .where(and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.agentId, agentId)))
            .orderBy(asc(agentSkills.skillId)),
          db
            .select({ id: agentMcpServers.mcpServerId })
            .from(agentMcpServers)
            .where(
              and(
                eq(agentMcpServers.workspaceId, workspaceId),
                eq(agentMcpServers.agentId, agentId),
              ),
            )
            .orderBy(asc(agentMcpServers.mcpServerId)),
        ]);
        // Verification round 1, finding 1: `replace` below narrows a `'read-write'` grant to
        // `'read'` at write time, but a grant already sitting at `'read-write'` in the database
        // survives untouched if the agent's own `writeFiles` permission is turned off by some
        // *other* write (`PATCH /api/agents/:id`) that never got a matching resources `PUT` — the
        // exact partial-save shape this task's own `AgentDetailScreen.save()` produces on the
        // second request's failure. `replace`'s narrowing alone therefore cannot be the only
        // ceiling: it would leave a stale row readable as `'read-write'` by every caller of `get`,
        // including `createAgentRunResourceLoader` (`apps/web/server/compose/resource-loader.ts`),
        // which composes a run's file grants straight from this method with no narrowing of its
        // own. Re-deriving the ceiling here — from the agent's *current* `permissions`, not
        // whatever was true when the row was written — closes that gap for every reader at once,
        // the same "narrow, never widen, and never trust the stored value alone" rule
        // `docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md` already applies to a
        // project's contribution.
        const permissions = parseAgentPermissions(agentRow.permissions);
        const files = permissions.writeFiles
          ? fileRows
          : fileRows.map((row) =>
              row.access === 'read-write' ? { ...row, access: 'read' as const } : row,
            );
        return {
          files,
          skillIds: skillRows.map((row) => row.id),
          connectorIds: connectorRows.map((row) => row.id),
        };
      };

      return {
        get: read,
        async replace(agentId, requested): Promise<ReplaceAgentResourcesOutcome> {
          const agentRows = await db
            .select({ permissions: agents.permissions })
            .from(agents)
            .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
            .limit(1);
          const agentRow = agentRows[0];
          if (agentRow === undefined) return { kind: 'not-found' };

          // Issue #133: the agent's own `writeFiles` tool permission is a ceiling on every
          // `'read-write'` file grant this call persists — the same "narrow, never widen" rule
          // issue #125's project associations already apply to a project's own contribution
          // (docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md), read here as the
          // identical ceiling applied to an agent's own direct assignment instead. A grant is
          // narrowed to `'read'`, not refused: `writeFiles` lives on this very agent, so a caller
          // who flips it back on later should not have to re-grant every file it already assigned
          // read-write access to. Every writer of an assignment (`PUT /api/agents/:id/resources`
          // and `POST /api/agents`'s own create-with-assignments body) shares this one check by
          // calling through here, rather than each fetching the agent's permissions itself.
          // Narrowing here alone is not sufficient — see `read`'s own comment above for why a row
          // written while `writeFiles` was on must also be narrowed on every read, not just here.
          const permissions = parseAgentPermissions(agentRow.permissions);
          const assignments: AgentResourceAssignments = permissions.writeFiles
            ? requested
            : {
                ...requested,
                files: requested.files.map((grant) =>
                  grant.access === 'read-write' ? { ...grant, access: 'read' as const } : grant,
                ),
              };

          const fileIds = [...new Set(assignments.files.map((grant) => grant.fileId))];
          const skillIds = [...new Set(assignments.skillIds)];
          const connectorIds = [...new Set(assignments.connectorIds)];
          if (fileIds.length !== assignments.files.length) {
            const seen = new Set<string>();
            return {
              kind: 'unknown-file',
              id:
                assignments.files.find((grant) => {
                  if (seen.has(grant.fileId)) return true;
                  seen.add(grant.fileId);
                  return false;
                })?.fileId ?? '',
            };
          }

          const existingFiles =
            fileIds.length === 0
              ? []
              : await db
                  .select({ id: files.id })
                  .from(files)
                  .where(and(eq(files.workspaceId, workspaceId), inArray(files.id, fileIds)));
          const existingSkills =
            skillIds.length === 0
              ? []
              : await db
                  .select({ id: skills.id })
                  .from(skills)
                  .where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, skillIds)));
          const existingConnectors =
            connectorIds.length === 0
              ? []
              : await db
                  .select({ id: mcpServers.id })
                  .from(mcpServers)
                  .where(
                    and(
                      // Every kind: compose hands a tool connector (ADR-0113 C15) to the engine
                      // as a gateway MCP server (S2-02f, #531), so it is assignable here.
                      eq(mcpServers.workspaceId, workspaceId),
                      inArray(mcpServers.id, connectorIds),
                    ),
                  );

          const foundFiles = new Set(existingFiles.map((row) => row.id));
          const foundSkills = new Set(existingSkills.map((row) => row.id));
          const foundConnectors = new Set(existingConnectors.map((row) => row.id));
          const unknownFile = fileIds.find((id) => !foundFiles.has(id));
          if (unknownFile !== undefined) return { kind: 'unknown-file', id: unknownFile };
          const unknownSkill = skillIds.find((id) => !foundSkills.has(id));
          if (unknownSkill !== undefined) return { kind: 'unknown-skill', id: unknownSkill };
          const unknownConnector = connectorIds.find((id) => !foundConnectors.has(id));
          if (unknownConnector !== undefined)
            return { kind: 'unknown-connector', id: unknownConnector };

          // C21 (plan §4, S2-07a): replacing an agent's assignments is an edit, so `updated_at`
          // moves and `materialised_version_id` clears in the same transaction, on every
          // successful replace (a save that changes nothing is still a save). Updating the agent
          // row first also takes its row lock, which serialises concurrent replaces of one agent.
          // `aw dev`'s sync guard (S2-07b) reads `materialised_version_id` as the edit marker.
          const replaced = await db.transaction(async (tx) => {
            const bumped = await tx
              .update(agents)
              .set({ updatedAt: sql`now()`, materialisedVersionId: null })
              .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
              .returning({ id: agents.id });
            // Deleted between the pre-check and this transaction: write nothing.
            if (bumped.length === 0) return false;
            const ownAgent = (
              table: typeof agentFiles | typeof agentSkills | typeof agentMcpServers,
            ) => and(eq(table.workspaceId, workspaceId), eq(table.agentId, agentId));
            await tx.delete(agentFiles).where(ownAgent(agentFiles));
            await tx.delete(agentSkills).where(ownAgent(agentSkills));
            await tx.delete(agentMcpServers).where(ownAgent(agentMcpServers));
            if (assignments.files.length > 0)
              await tx
                .insert(agentFiles)
                .values(assignments.files.map((grant) => ({ workspaceId, agentId, ...grant })));
            if (skillIds.length > 0)
              await tx
                .insert(agentSkills)
                .values(skillIds.map((skillId) => ({ workspaceId, agentId, skillId })));
            if (connectorIds.length > 0)
              await tx
                .insert(agentMcpServers)
                .values(connectorIds.map((mcpServerId) => ({ workspaceId, agentId, mcpServerId })));
            return true;
          });
          if (!replaced) return { kind: 'not-found' };
          const updated = await read(agentId);
          if (updated === null) return { kind: 'not-found' };
          return { kind: 'updated', assignments: updated };
        },
      };
    },
  };
}
