/** The environment pointers and their history, as the version writes move them. */
import { and, eq, sql } from 'drizzle-orm';

import { agentPointerMoves, type AgentPointerMoveReason } from '../schema/agent-pointer-moves.js';
import {
  agentVersionPointers,
  type AgentVersionEnvironment,
} from '../schema/agent-version-pointers.js';
import { agentVersions } from '../schema/agent-versions.js';
import type { AgentVersionPointerRecord } from './agent-versions.js';
import {
  ConflictRow,
  lockPointerWrites,
  surfacesOf,
  type Transaction,
} from './agent-versions-shared.js';
import { Rollback } from './agent-versions-write-failures.js';

/** One environment of one agent. */
interface PointerTarget {
  readonly agentId: string;
  readonly environment: AgentVersionEnvironment;
}

/** The version a pointer is moved to. */
interface PointedVersion {
  readonly id: string;
  readonly number: number;
}

/** Why and by whom a pointer is moved, as its history row records. */
interface PointerMove {
  readonly reason: AgentPointerMoveReason;
  readonly movedBy: string;
}

export interface PointerWrites {
  readonly lockPointers: (tx: Transaction, environment: AgentVersionEnvironment) => Promise<void>;
  readonly pointedNumber: (tx: Transaction, target: PointerTarget) => Promise<number | null>;
  readonly pointAndCheckSurface: (
    tx: Transaction,
    target: PointerTarget,
    version: PointedVersion,
    move: PointerMove,
  ) => Promise<AgentVersionPointerRecord>;
}

/**
 * Point `environment` of `agentId` at `version`, inserting or moving the pointer, and append
 * the move to its history. The only writer of either table; runs under the pointer lock.
 */
async function movePointer(
  tx: Transaction,
  { workspaceId, agentId, environment }: PointerTarget & { readonly workspaceId: string },
  version: PointedVersion,
  move: PointerMove,
): Promise<AgentVersionPointerRecord> {
  const rows = await tx
    .insert(agentVersionPointers)
    .values({ workspaceId, agentId, environment, versionId: version.id })
    .onConflictDoUpdate({
      target: [agentVersionPointers.agentId, agentVersionPointers.environment],
      set: { versionId: version.id, updatedAt: sql`now()` },
    })
    .returning({
      agentId: agentVersionPointers.agentId,
      environment: agentVersionPointers.environment,
      versionId: agentVersionPointers.versionId,
      updatedAt: agentVersionPointers.updatedAt,
    });
  const row = rows[0];
  if (row === undefined) throw new Error('the pointer upsert returned no row');
  await tx.insert(agentPointerMoves).values({
    workspaceId,
    agentId,
    environment,
    versionId: version.id,
    movedBy: move.movedBy,
    reason: move.reason,
  });
  return { ...row, number: version.number };
}

/**
 * C9: the first surface name of `versionId` that a version pointed by another agent in this
 * workspace and environment also serves, or `null`. Runs under the pointer lock.
 */
async function takenSurfaceName(
  tx: Transaction,
  { workspaceId, agentId, environment }: PointerTarget & { readonly workspaceId: string },
  versionId: string,
): Promise<string | null> {
  const result = await tx.execute(sql`
    select mine.elem->>'name' as name
    from agent_versions v
    cross join lateral jsonb_array_elements(${surfacesOf('v')}) as mine(elem)
    join agent_version_pointers p
      on p.workspace_id = ${workspaceId}
     and p.environment = ${environment}
     and p.agent_id <> ${agentId}
    join agent_versions ov
      on ov.id = p.version_id
     and ov.workspace_id = ${workspaceId}
    cross join lateral jsonb_array_elements(${surfacesOf('ov')}) as theirs(elem)
    where v.workspace_id = ${workspaceId}
      and v.id = ${versionId}
      and mine.elem->>'name' is not null
      and theirs.elem->>'name' = mine.elem->>'name'
    order by 1
    limit 1`);
  const row = result.rows[0];
  return row === undefined ? null : ConflictRow.parse(row).name;
}

export function pointerWrites(workspaceId: string): PointerWrites {
  return {
    lockPointers: (tx, environment) => lockPointerWrites(tx, workspaceId, environment),

    /** The version number the target points at, or `null` when it points at none. */
    async pointedNumber(tx, { agentId, environment }) {
      const rows = await tx
        .select({ number: agentVersions.number })
        .from(agentVersionPointers)
        .innerJoin(agentVersions, eq(agentVersions.id, agentVersionPointers.versionId))
        .where(
          and(
            eq(agentVersionPointers.workspaceId, workspaceId),
            eq(agentVersionPointers.agentId, agentId),
            eq(agentVersionPointers.environment, environment),
          ),
        );
      return rows[0]?.number ?? null;
    },

    /**
     * {@link movePointer}, then roll back with `surface-name-taken` when another agent's version
     * pointed in the same environment serves one of the version's surface names (C9).
     */
    async pointAndCheckSurface(tx, target, version, move) {
      const scoped = { ...target, workspaceId };
      const pointer = await movePointer(tx, scoped, version, move);
      const taken = await takenSurfaceName(tx, scoped, version.id);
      if (taken !== null) throw new Rollback({ kind: 'surface-name-taken', name: taken });
      return pointer;
    },
  };
}
