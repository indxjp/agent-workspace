import { and, asc, eq, inArray, not, sql } from 'drizzle-orm';

import { agentFiles, type FileAccessMode } from '../schema/agent-files.js';
import { agentMcpServers } from '../schema/agent-mcp-servers.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agentStorageGrants } from '../schema/agent-storage-grants.js';
import { agents, parseAgentPermissions } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { skillRevisions } from '../schema/skill-revisions.js';
import { skills } from '../schema/skills.js';
import { narrowStorageGrants, type StorageGrantRef } from './agent-versions-resolution.js';
import type { Executor } from './agent-versions-shared.js';
import { underAttachmentsPrefix } from './project-files.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export interface AgentResourceAssignments {
  readonly files: readonly { readonly fileId: string; readonly access: FileAccessMode }[];
  readonly skillIds: readonly string[];
  /** Published revision each pinned skill follows, by skill id; absent skills follow `latest`. */
  readonly skillRevisions?: Readonly<Record<string, number>> | undefined;
  readonly connectorIds: readonly string[];
  /** Written only by a materialised version; {@link AgentResourceRepository.replace} keeps them. */
  readonly storageGrants: readonly StorageGrantRef[];
}

/** What a writer of assignments sends: the storage grants are not its to set. */
export type AgentResourceAssignmentsInput = Omit<AgentResourceAssignments, 'storageGrants'> & {
  readonly storageGrants?: readonly StorageGrantRef[] | undefined;
};

export type ReplaceAgentResourcesOutcome =
  | { readonly kind: 'updated'; readonly assignments: AgentResourceAssignments }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unknown-file'; readonly id: string }
  | { readonly kind: 'unknown-skill'; readonly id: string }
  /** A delete of the skill is under way: it cannot be assigned any more (the mark is never undone). */
  | { readonly kind: 'skill-deleting'; readonly id: string }
  | { readonly kind: 'unknown-skill-revision'; readonly id: string; readonly revision: number }
  | { readonly kind: 'unknown-connector'; readonly id: string };

export interface AgentResourceRepository {
  get(agentId: string): Promise<AgentResourceAssignments | null>;
  replace(
    agentId: string,
    assignments: AgentResourceAssignmentsInput,
  ): Promise<ReplaceAgentResourcesOutcome>;
}

export interface AgentResourceRepositoryProvider {
  forScope(scope: WorkspaceScope): AgentResourceRepository;
}

export function createDatabaseAgentResourceRepositoryProvider(
  db: Executor,
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
        const [fileRows, skillRows, connectorRows, storageRows] = await Promise.all([
          db
            .select({ fileId: agentFiles.fileId, access: agentFiles.access })
            .from(agentFiles)
            .innerJoin(
              files,
              and(eq(files.id, agentFiles.fileId), eq(files.workspaceId, agentFiles.workspaceId)),
            )
            // A grant on a row that is not ready (removed, awaiting cleanup) is not a grant.
            .where(
              and(
                eq(agentFiles.workspaceId, workspaceId),
                eq(agentFiles.agentId, agentId),
                eq(files.status, 'ready'),
              ),
            )
            .orderBy(asc(agentFiles.fileId)),
          db
            .select({ id: agentSkills.skillId, revision: agentSkills.revision })
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
          db
            .select({
              connectionId: agentStorageGrants.connectionId,
              prefix: agentStorageGrants.prefix,
              access: agentStorageGrants.access,
            })
            .from(agentStorageGrants)
            .where(
              and(
                eq(agentStorageGrants.workspaceId, workspaceId),
                eq(agentStorageGrants.agentId, agentId),
              ),
            )
            .orderBy(asc(agentStorageGrants.connectionId), asc(agentStorageGrants.prefix)),
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
        const granted = permissions.writeFiles
          ? fileRows
          : fileRows.map((row) =>
              row.access === 'read-write' ? { ...row, access: 'read' as const } : row,
            );
        const pins = skillRows.flatMap((row) =>
          row.revision === null ? [] : [[row.id, row.revision] as const],
        );
        return {
          files: granted,
          skillIds: skillRows.map((row) => row.id),
          ...(pins.length > 0 ? { skillRevisions: Object.fromEntries(pins) } : {}),
          connectorIds: connectorRows.map((row) => row.id),
          // The same read-time ceiling as files: a stale `read-write` row is never read as one.
          storageGrants: narrowStorageGrants(storageRows, permissions),
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
          const assignments: AgentResourceAssignmentsInput = permissions.writeFiles
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
                  .where(
                    and(
                      eq(files.workspaceId, workspaceId),
                      inArray(files.id, fileIds),
                      // ADR-0146 D6: a visitor upload under `.attachments/` is not assignable; it
                      // answers as an unknown file, so the refusal does not confirm it exists.
                      not(underAttachmentsPrefix),
                      // A pending upload is not a file yet (the storage design, §04).
                      eq(files.status, 'ready'),
                    ),
                  );
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
          // A pin on a skill that is not being assigned is never written, so it is not checked.
          const pins = Object.entries(assignments.skillRevisions ?? {}).filter(([id]) =>
            foundSkills.has(id),
          );
          if (pins.length > 0) {
            const published = await db
              .select({ skillId: skillRevisions.skillId, number: skillRevisions.number })
              .from(skillRevisions)
              .where(
                and(
                  eq(skillRevisions.workspaceId, workspaceId),
                  eq(skillRevisions.pending, false),
                  inArray(
                    skillRevisions.skillId,
                    pins.map(([skillId]) => skillId),
                  ),
                ),
              );
            const found = new Set(published.map((row) => `${row.skillId}@${String(row.number)}`));
            const missing = pins.find(([skillId, n]) => !found.has(`${skillId}@${String(n)}`));
            if (missing !== undefined)
              return { kind: 'unknown-skill-revision', id: missing[0], revision: missing[1] };
          }
          const unknownConnector = connectorIds.find((id) => !foundConnectors.has(id));
          if (unknownConnector !== undefined)
            return { kind: 'unknown-connector', id: unknownConnector };

          // C21 (plan §4, S2-07a): replacing an agent's assignments is an edit, so `updated_at`
          // moves and `materialised_version_id` clears in the same transaction, on every
          // successful replace (a save that changes nothing is still a save). Updating the agent
          // row first also takes its row lock, which serialises concurrent replaces of one agent.
          // `aw dev`'s sync guard (S2-07b) reads `materialised_version_id` as the edit marker.
          const replaced = await db.transaction(async (tx) => {
            // Under a share lock on the skill rows, so a delete marking one either lands first
            // (and is seen here) or waits for this assignment and then finds it in use.
            if (skillIds.length > 0) {
              const locked = await tx
                .select({ id: skills.id, pendingDelete: skills.pendingDelete })
                .from(skills)
                .where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, skillIds)))
                .orderBy(asc(skills.id))
                .for('share');
              const deleting = locked.find((row) => row.pendingDelete !== null);
              if (deleting !== undefined)
                return { kind: 'skill-deleting', id: deleting.id } as const;
            }
            const bumped = await tx
              .update(agents)
              .set({ updatedAt: sql`now()`, materialisedVersionId: null })
              .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
              .returning({ id: agents.id });
            // Deleted between the pre-check and this transaction: write nothing.
            if (bumped.length === 0) return { kind: 'not-found' } as const;
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
              await tx.insert(agentSkills).values(
                skillIds.map((skillId) => ({
                  workspaceId,
                  agentId,
                  skillId,
                  revision: assignments.skillRevisions?.[skillId] ?? null,
                })),
              );
            if (connectorIds.length > 0)
              await tx
                .insert(agentMcpServers)
                .values(connectorIds.map((mcpServerId) => ({ workspaceId, agentId, mcpServerId })));
            return { kind: 'replaced' } as const;
          });
          if (replaced.kind !== 'replaced') return replaced;
          const updated = await read(agentId);
          if (updated === null) return { kind: 'not-found' };
          return { kind: 'updated', assignments: updated };
        },
      };
    },
  };
}
