/** The read half of the agent version store; see `./agent-versions.ts`. */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../client.js';
import { agentPointerMoves } from '../schema/agent-pointer-moves.js';
import { agentVersionPointers } from '../schema/agent-version-pointers.js';
import { agentVersions } from '../schema/agent-versions.js';
import { agents } from '../schema/agents.js';
import type {
  AgentPointerMoveRecord,
  AgentVersionListing,
  AgentVersionRecord,
  AgentVersionRepository,
  PointedSurface,
} from './agent-versions.js';
import { surfacesOf, VERSION_COLUMNS } from './agent-versions-shared.js';

const PointedSurfaceRow = z.object({
  agent_id: z.string(),
  version_id: z.string(),
  number: z.number().int(),
  surface: z.unknown(),
});

export function agentVersionReads(
  db: Database,
  workspaceId: string,
): Pick<
  AgentVersionRepository,
  'list' | 'find' | 'findById' | 'listMoves' | 'findPointedSurface' | 'listPointedSurfaceNames'
> {
  const readVersions = async (
    agentId: string,
    number?: number,
  ): Promise<readonly AgentVersionRecord[]> => {
    const predicate = and(
      eq(agentVersions.workspaceId, workspaceId),
      eq(agentVersions.agentId, agentId),
      number === undefined ? undefined : eq(agentVersions.number, number),
    );
    return db
      .select(VERSION_COLUMNS)
      .from(agentVersions)
      .where(predicate)
      .orderBy(asc(agentVersions.number));
  };

  return {
    async list(agentId): Promise<AgentVersionListing | null> {
      const agent = await db
        .select({ materialisedVersionId: agents.materialisedVersionId })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
        .limit(1);
      if (agent[0] === undefined) return null;
      const [versions, pointers] = await Promise.all([
        readVersions(agentId),
        db
          .select({
            agentId: agentVersionPointers.agentId,
            environment: agentVersionPointers.environment,
            versionId: agentVersionPointers.versionId,
            number: agentVersions.number,
            updatedAt: agentVersionPointers.updatedAt,
          })
          .from(agentVersionPointers)
          .innerJoin(
            agentVersions,
            and(
              eq(agentVersions.id, agentVersionPointers.versionId),
              eq(agentVersions.workspaceId, workspaceId),
            ),
          )
          .where(
            and(
              eq(agentVersionPointers.workspaceId, workspaceId),
              eq(agentVersionPointers.agentId, agentId),
            ),
          )
          .orderBy(asc(agentVersionPointers.environment)),
      ]);
      return { versions, pointers, materialisedVersionId: agent[0].materialisedVersionId };
    },

    async find(agentId, number): Promise<AgentVersionRecord | null> {
      const rows = await readVersions(agentId, number);
      return rows[0] ?? null;
    },

    async findById(versionId): Promise<AgentVersionRecord | null> {
      const rows = await db
        .select(VERSION_COLUMNS)
        .from(agentVersions)
        .where(and(eq(agentVersions.workspaceId, workspaceId), eq(agentVersions.id, versionId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async listMoves(agentId, environment, limit): Promise<readonly AgentPointerMoveRecord[]> {
      return db
        .select({
          environment: agentPointerMoves.environment,
          number: agentVersions.number,
          reason: agentPointerMoves.reason,
          movedByPrincipalId: agentPointerMoves.movedBy,
          movedAt: agentPointerMoves.movedAt,
        })
        .from(agentPointerMoves)
        .innerJoin(
          agentVersions,
          and(
            eq(agentVersions.id, agentPointerMoves.versionId),
            eq(agentVersions.workspaceId, workspaceId),
          ),
        )
        .where(
          and(
            eq(agentPointerMoves.workspaceId, workspaceId),
            eq(agentPointerMoves.agentId, agentId),
            environment === null ? undefined : eq(agentPointerMoves.environment, environment),
          ),
        )
        .orderBy(desc(agentPointerMoves.movedAt))
        .limit(limit);
    },

    async findPointedSurface(environment, name): Promise<PointedSurface | null> {
      const result = await db.execute(sql`
        select p.agent_id, p.version_id, v.number, s.elem as surface
        from agent_version_pointers p
        join agent_versions v
          on v.id = p.version_id
         and v.workspace_id = ${workspaceId}
        cross join lateral jsonb_array_elements(${surfacesOf('v')}) as s(elem)
        where p.workspace_id = ${workspaceId}
          and p.environment = ${environment}
          and s.elem->>'name' = ${name}
        order by p.updated_at, p.agent_id
        limit 1`);
      const row = result.rows[0];
      if (row === undefined) return null;
      const parsed = PointedSurfaceRow.parse(row);
      return {
        agentId: parsed.agent_id,
        versionId: parsed.version_id,
        number: parsed.number,
        surface: parsed.surface,
      };
    },

    async listPointedSurfaceNames(): Promise<readonly string[]> {
      const result = await db.execute(sql`
        select distinct s.elem->>'name' as name
        from agent_version_pointers p
        join agent_versions v
          on v.id = p.version_id
         and v.workspace_id = ${workspaceId}
        cross join lateral jsonb_array_elements(${surfacesOf('v')}) as s(elem)
        where p.workspace_id = ${workspaceId}
          and jsonb_typeof(s.elem->'name') = 'string'
        order by name`);
      return z
        .array(z.object({ name: z.string() }))
        .parse(result.rows)
        .map((row) => row.name);
    },
  };
}
