import { eq, ne, sql } from 'drizzle-orm';

import { mcpServers } from '../../schema/mcp-servers.js';

import { runs } from '../../schema/runs.js';

import type { RunContext } from './context.js';
import { UUID_PATTERN, every, sameIdSet } from './rows.js';
import type {
  RecordRunToolSandboxOutcome,
  RunRepository,
  SnapshotRunModelInput,
  SnapshotRunModelOutcome,
  SnapshotRunToolsOutcome,
} from './types.js';

export function createRunSnapshots({
  db,
  checked,
  tenant,
  read,
}: RunContext): Pick<
  RunRepository,
  'snapshotModel' | 'snapshotTools' | 'recordToolSandbox' | 'snapshotFileGrants'
> {
  return {
    async snapshotModel(
      runId: string,
      input: SnapshotRunModelInput,
    ): Promise<SnapshotRunModelOutcome> {
      const rows = await db
        .update(runs)
        .set({
          model: input.model,
          provider: input.provider,
          modelConnectionId: input.connectionId,
        })
        .where(every(tenant, eq(runs.id, runId)))
        .returning({ id: runs.id });
      return rows.length > 0 ? { kind: 'updated' } : { kind: 'not-found' };
    },
    async snapshotTools(
      runId: string,
      connectorIds: readonly string[],
    ): Promise<SnapshotRunToolsOutcome> {
      // A string that is not a UUID names no run and no connector, so it is answered here as
      // `not-found` / `unknown-connectors` rather than reaching the database as a 22P02.
      if (!UUID_PATTERN.test(runId)) return { kind: 'not-found' };
      const malformed = connectorIds.filter((id) => !UUID_PATTERN.test(id));
      if (malformed.length > 0) {
        return { kind: 'unknown-connectors', connectorIds: [...new Set(malformed)].sort() };
      }
      // The canonical set: lower-case (PostgreSQL's own rendering), distinct, sorted.
      const wanted = [...new Set(connectorIds.map((id) => id.toLowerCase()))].sort();
      return db.transaction(async (tx): Promise<SnapshotRunToolsOutcome> => {
        // Lock the run row so the decision below and the write are one step: two concurrent
        // calls serialise here instead of both deciding on the same stale row.
        const locked = await tx
          .select({ status: runs.status, toolConnectorIds: runs.toolConnectorIds })
          .from(runs)
          .where(every(tenant, eq(runs.id, runId)))
          .limit(1)
          .for('update');
        const run = locked[0];
        if (run === undefined) return { kind: 'not-found' };
        // The run already carries exactly this set: answer before re-validating, so a retry
        // after launch (or after a connector in the set was deleted) still succeeds.
        if (sameIdSet(run.toolConnectorIds, wanted)) {
          return { kind: 'snapshotted', toolConnectorIds: wanted };
        }
        if (run.status !== 'queued') return { kind: 'not-queued' };
        if (wanted.length > 0) {
          // One `uuid[]` parameter, not one parameter per id, so no set size can overflow the
          // protocol's bind-parameter count.
          const found = await tx
            .select({ id: mcpServers.id })
            .from(mcpServers)
            .where(
              every(
                eq(mcpServers.workspaceId, checked.workspaceId),
                sql`${mcpServers.id} = ANY(${sql.param(wanted)}::uuid[])`,
                ne(mcpServers.kind, 'mcp'),
              ),
            );
          const known = new Set(found.map((row) => row.id));
          const unknown = wanted.filter((id) => !known.has(id));
          if (unknown.length > 0) return { kind: 'unknown-connectors', connectorIds: unknown };
        }
        await tx
          .update(runs)
          .set({ toolConnectorIds: wanted })
          .where(every(tenant, eq(runs.id, runId)));
        return { kind: 'snapshotted', toolConnectorIds: wanted };
      });
    },
    async recordToolSandbox(runId: string, origin: string): Promise<RecordRunToolSandboxOutcome> {
      if (!UUID_PATTERN.test(runId)) return { kind: 'not-found' };
      const moved = await db
        .update(runs)
        .set({ toolSandboxOrigin: origin })
        .where(every(tenant, eq(runs.id, runId), eq(runs.status, 'queued')))
        .returning({ id: runs.id });
      if (moved.length > 0) return { kind: 'recorded' };
      const existing = await read(runId);
      if (existing === null) return { kind: 'not-found' };
      return existing.toolSandboxOrigin === origin ? { kind: 'recorded' } : { kind: 'not-queued' };
    },
    async snapshotFileGrants(runId: string, paths: readonly string[]): Promise<boolean> {
      if (!UUID_PATTERN.test(runId)) return false;
      const wanted = [...new Set(paths)].sort();
      const moved = await db
        .update(runs)
        .set({ fileGrants: wanted })
        .where(every(tenant, eq(runs.id, runId), eq(runs.status, 'queued')))
        .returning({ id: runs.id });
      if (moved.length > 0) return true;
      // A retry after launch records nothing new; it succeeds only if the set is unchanged.
      const existing = await read(runId);
      return existing !== null && sameIdSet(existing.fileGrants ?? [], wanted);
    },
  };
}
