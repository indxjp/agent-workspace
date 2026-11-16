import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  notExists,
  sql,
  type SQL,
} from 'drizzle-orm';

import { auditEvents } from '../../schema/audit-events.js';
import { agents } from '../../schema/agents.js';
import { runs } from '../../schema/runs.js';
import { sessions } from '../../schema/sessions.js';
import type { Executor } from '../agent-versions-shared.js';
import type { AgentRepository, AgentRestoreActor, RestoreAgentOutcome } from '../agents.js';
import { checkedAuditEvent } from '../audit-events.js';
import type { AgentContext } from './context.js';
import { AGENT_COLUMNS, toRecord } from './rows.js';

/** How long a restore keeps the auto-archive sweep away from an agent (the sweep's own 30 days). */
const RESTORE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True for an agent with no restore (`agent-changed`, `archived: false`) at or after `since`.
 *
 * Served by the partial index `audit_events_agent_restore_idx`, whose predicate is the two
 * conditions on `action` and `details` below: keep them in step with it.
 */
function notRestoredSince(workspaceId: string, since: Date): SQL {
  return notExists(
    sql`(select 1 from ${auditEvents} where ${and(
      eq(auditEvents.workspaceId, workspaceId),
      eq(auditEvents.action, 'agent-changed'),
      eq(auditEvents.subjectId, sql`${agents.id}::text`),
      sql`${auditEvents.details}->>'archived' = 'false'`,
      gte(auditEvents.createdAt, since),
    )})`,
  );
}

/** The auto-archive lifecycle of an agent made by an agent (issue #1851). */
export function createAgentArchive(
  context: AgentContext,
): Pick<AgentRepository, 'listArchiveCandidates' | 'archive' | 'restore'> {
  return {
    listArchiveCandidates: (query) => listArchiveCandidates(context, query),
    archive: (ids, at) => archiveAgents(context, ids, at),
    restore: (id, actor) => restoreAgent(context, id, actor),
  };
}

type ArchiveCandidateQuery = Parameters<AgentRepository['listArchiveCandidates']>[0];
type ArchiveCandidates = Awaited<ReturnType<AgentRepository['listArchiveCandidates']>>;

async function listArchiveCandidates(
  { db, checked, within }: AgentContext,
  query: ArchiveCandidateQuery,
): Promise<ArchiveCandidates> {
  const rows = await db
    .select({
      id: agents.id,
      createdAt: agents.createdAt,
      createdByAgentId: agents.createdByAgentId,
      createdByAgentVersion: agents.createdByAgentVersion,
      createdByRunId: agents.createdByRunId,
    })
    .from(agents)
    .where(
      // `within` first: the workspace predicate is the left-most term of the conjunction.
      and(
        within(isNull(agents.archivedAt)),
        isNotNull(agents.createdByAgentVersion),
        lt(agents.createdAt, query.createdBefore),
        notRestoredSince(checked.workspaceId, query.notRestoredSince),
        query.afterId === null ? undefined : gt(agents.id, query.afterId),
      ),
    )
    .orderBy(asc(agents.id))
    .limit(query.limit);
  const lastRunAt = await lastRunsOf(
    db,
    checked.workspaceId,
    rows.map((row) => row.id),
  );
  return rows.flatMap((row) =>
    // The lineage CHECK makes the version and the run both present or both absent.
    row.createdByAgentVersion === null || row.createdByRunId === null
      ? []
      : [
          {
            id: row.id,
            createdAt: row.createdAt,
            lastRunAt: lastRunAt.get(row.id) ?? null,
            createdByAgent: {
              agentId: row.createdByAgentId,
              version: row.createdByAgentVersion,
              runId: row.createdByRunId,
            },
          },
        ],
  );
}

/** The newest run of any session of each agent; an agent that never ran has no entry. */
async function lastRunsOf(
  db: Executor,
  workspaceId: string,
  agentIds: readonly string[],
): Promise<Map<string, Date | null>> {
  const ran =
    agentIds.length === 0
      ? []
      : await db
          .select({ agentId: sessions.agentId, lastRunAt: max(runs.createdAt) })
          .from(runs)
          .innerJoin(sessions, eq(sessions.id, runs.sessionId))
          .where(
            and(eq(sessions.workspaceId, workspaceId), inArray(sessions.agentId, [...agentIds])),
          )
          .groupBy(sessions.agentId);
  return new Map(ran.map((row) => [row.agentId, row.lastRunAt]));
}

/** Who an `agent-changed` audit row names: the restoring principal, or the sweep. */
const AUTO_ARCHIVE_ACTOR = { principalId: null, userId: null, label: 'Auto-archive' } as const;

interface ArchivedChange {
  readonly actor: AgentRestoreActor | typeof AUTO_ARCHIVE_ACTOR;
  readonly changed: readonly { readonly id: string; readonly name: string }[];
  readonly archived: boolean;
}

/** One `agent-changed` audit row per changed agent, recording its new `archived` state. */
async function auditArchivedChange(
  tx: Executor,
  workspaceId: string,
  { actor, changed, archived }: ArchivedChange,
): Promise<void> {
  await tx.insert(auditEvents).values(
    changed.map((agent) =>
      checkedAuditEvent({
        workspaceId,
        actorPrincipalId: actor.principalId,
        actorUserId: actor.userId,
        actorLabel: actor.label,
        action: 'agent-changed' as const,
        subjectId: agent.id,
        subjectLabel: agent.name,
        details: { archived },
      }),
    ),
  );
}

async function archiveAgents(
  { db, checked, within }: AgentContext,
  ids: readonly string[],
  at: Date,
): Promise<readonly string[]> {
  if (ids.length === 0) return [];
  return db.transaction(async (tx) => {
    const archived = await tx
      .update(agents)
      .set({ archivedAt: at })
      .where(
        and(
          within(inArray(agents.id, [...ids])),
          isNull(agents.archivedAt),
          // A restore committed after the sweep listed the agent keeps it active.
          notRestoredSince(
            checked.workspaceId,
            new Date(at.getTime() - RESTORE_WINDOW_DAYS * DAY_MS),
          ),
        ),
      )
      .returning({ id: agents.id, name: agents.name });
    if (archived.length > 0) {
      await auditArchivedChange(tx, checked.workspaceId, {
        actor: AUTO_ARCHIVE_ACTOR,
        changed: archived,
        archived: true,
      });
    }
    return archived.map((agent) => agent.id);
  });
}

async function restoreAgent(
  { db, checked, within }: AgentContext,
  id: string,
  actor: AgentRestoreActor,
): Promise<RestoreAgentOutcome> {
  return db.transaction(async (tx) => {
    const restored = await tx
      .update(agents)
      .set({ archivedAt: null })
      .where(and(within(eq(agents.id, id)), isNotNull(agents.archivedAt)))
      .returning(AGENT_COLUMNS);
    const row = restored[0];
    if (row !== undefined) {
      await auditArchivedChange(tx, checked.workspaceId, {
        actor,
        changed: [row],
        archived: false,
      });
      return { kind: 'restored', agent: toRecord(row) };
    }
    const [current] = await tx
      .select(AGENT_COLUMNS)
      .from(agents)
      .where(within(eq(agents.id, id)));
    return current === undefined
      ? { kind: 'not-found' }
      : { kind: 'not-archived', agent: toRecord(current) };
  });
}
