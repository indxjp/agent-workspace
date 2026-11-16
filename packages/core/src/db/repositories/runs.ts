/** Workspace-scoped run persistence. Event logs and session primitives retain their public exports. */
import { eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentVersions } from '../schema/agent-versions.js';
import { engineIds, type EngineId } from '../schema/agents.js';

import { runs, runStatuses, terminalRunStatuses, type RunStatus } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { every, RUN_COLUMNS, toRunRecord } from './runs/rows.js';
import type { RunRecord, RunRepository, RunRepositoryProvider } from './runs/types.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export { runStatuses, terminalRunStatuses };
export type { RunStatus };

// ADR-0065's engine vocabulary, re-exported from the schema the same way `runStatuses` is:
// `runs.engine` and `sessions.engine` both carry it, and a caller outside `packages/core` can
// only reach the schema through this layer.
export { engineIds };
export type { EngineId };

export { createDatabaseRunEventRepositoryProvider } from './runs/events.js';
export {
  isWorkspaceMember,
  listExpiredApprovalRunIds,
  listRunsNeedingAccountingReconciliation,
  listStaleRunIds,
} from './runs/queries.js';
export { isTerminalRunStatus } from './runs/rows.js';
export { createDatabaseSessionRepositoryProvider } from './runs/sessions.js';
export type {
  EnsureSessionInput,
  EnsureSessionOutcome,
  SessionMutationOutcome,
  SessionRepository,
  SessionRepositoryProvider,
  SessionVisibility,
  UpdateSessionInput,
} from './runs/sessions.js';
export type {
  CreateRunInput,
  CreateRunOutcome,
  RecordRunToolSandboxOutcome,
  RecordRunUsageInput,
  RecordRunUsageOutcome,
  RunEventRepository,
  RunEventRepositoryProvider,
  RunOutput,
  RunRecord,
  RunRepository,
  RunRepositoryProvider,
  RunTransitionOutcome,
  SessionRecord,
  SnapshotRunToolsOutcome,
  StoredRunEvent,
} from './runs/types.js';

import { createRunAccounting } from './runs/accounting.js';
import { createRunCreation } from './runs/creation.js';
import { createRunLifecycle } from './runs/lifecycle.js';
import { createRunListing } from './runs/listing.js';
import { createRunSnapshots } from './runs/snapshots.js';
/** The PostgreSQL {@link RunRepositoryProvider}. */
export function createDatabaseRunRepositoryProvider(db: Database): RunRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): RunRepository {
      const checked = requireWorkspaceScope(scope, 'RunRepositoryProvider');
      const tenant = eq(runs.workspaceId, checked.workspaceId);
      /** One run by id, tenant-filtered, with its agent joined in. */
      const read = async (runId: string): Promise<RunRecord | null> => {
        const rows = await db
          .select({
            ...RUN_COLUMNS,
            outputSchema: runs.outputSchema,
            prompt: runs.prompt,
            subject: runs.subject,
            limitsOverride: runs.limitsOverride,
            agentTeamVersionId: runs.agentTeamVersionId,
          })
          .from(runs)
          // The join is tenant-paired as well as id-paired. `runs_session_workspace_fk` already
          // guarantees the two workspaces agree, so this cannot change which row is found; it is
          // written out so the query says the invariant rather than relying on it.
          .innerJoin(
            sessions,
            every(eq(sessions.id, runs.sessionId), eq(sessions.workspaceId, runs.workspaceId)),
          )
          .leftJoin(
            agentVersions,
            every(
              eq(agentVersions.id, sessions.agentVersionId),
              eq(agentVersions.workspaceId, sessions.workspaceId),
            ),
          )
          .where(every(tenant, eq(runs.id, runId)))
          .limit(1);
        const row = rows[0];
        return row === undefined ? null : toRunRecord(row);
      };

      const context = { db, checked, tenant, read };
      const lifecycle = createRunLifecycle(context);
      return {
        get: read,
        ...createRunCreation(context, lifecycle.stopIn),
        ...lifecycle.transitions,
        ...createRunSnapshots(context),
        ...createRunAccounting(context),
        ...createRunListing(context),
      };
    },
  };
}
/**
 * Resolve only a workspace id for the legacy run-id-only store port (ADR W2-DB-02).
 * Callers must build a scoped repository before reading run data; an unknown id returns null.
 */
export async function findRunWorkspace(db: Database, runId: string): Promise<string | null> {
  const rows = await db
    .select({ workspaceId: runs.workspaceId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : row.workspaceId;
}
