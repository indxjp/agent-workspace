import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentVersionEvaluations } from '../schema/agent-version-evaluations.js';
import { agentVersions } from '../schema/agent-versions.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

interface RecordAgentVersionEvaluationInput {
  readonly versionId: string;
  readonly passed: number;
  readonly total: number;
  readonly casesSnapshot: unknown;
  readonly results: unknown;
  readonly createdByPrincipalId: string;
}

/** The stored row's id and time, which the evaluation resource carries. */
export interface RecordedAgentVersionEvaluation {
  readonly id: string;
  readonly createdAt: Date;
}

/** A stored evaluation as the promotion gate reads it (issue #619). */
interface LatestAgentVersionEvaluation {
  /** `passed / total` rounded to four places, as `pg` reads `numeric`: a string. */
  readonly score: string;
  readonly passed: number;
  readonly total: number;
  /** The case results as stored; the server parses them with the contracts' schema. */
  readonly results: unknown;
  readonly createdAt: Date;
}

interface StartAgentVersionEvaluationRunInput {
  readonly versionId: string;
  readonly total: number;
  readonly casesSnapshot: unknown;
  readonly createdByPrincipalId: string;
}

/** An evaluation row with the agent and version number of the version it scores (issue #799). */
export interface StoredAgentVersionEvaluation extends RecordedAgentVersionEvaluation {
  readonly agentId: string;
  readonly versionId: string;
  readonly version: number;
  readonly status: 'running' | 'completed';
  /** `passed / total` rounded to four places, as `pg` reads `numeric`: a string. */
  readonly score: string;
  readonly passed: number;
  readonly total: number;
  /** The cases as sent and each finished case's result; the server parses both. */
  readonly casesSnapshot: unknown;
  readonly results: unknown;
}

interface AgentVersionEvaluationRunProgress {
  readonly results: unknown;
  readonly passed: number;
  /** Every case has a result: the run becomes `completed` and its lease is freed. */
  readonly completed: boolean;
  /** Free the lease without completing the run. */
  readonly release: boolean;
}

export interface AgentVersionEvaluationRepository {
  /** Store one evaluation of `versionId` (issue #618); `score` is derived from the counts here. */
  record(input: RecordAgentVersionEvaluationInput): Promise<RecordedAgentVersionEvaluation>;
  /**
   * The newest completed evaluation of `versionId` in this workspace, or `null` when it has none
   * (issue #619). Another workspace's version id has none, and a run still `running` is not one.
   */
  latest(versionId: string): Promise<LatestAgentVersionEvaluation | null>;
  /** Store a `running` evaluation run with no case run yet (issue #799). */
  start(input: StartAgentVersionEvaluationRunInput): Promise<RecordedAgentVersionEvaluation>;
  /** The evaluation `id` of this workspace, or `null`: another workspace's id has none. */
  find(id: string): Promise<StoredAgentVersionEvaluation | null>;
  /**
   * Take the lease of the `running` run `id` for `leaseMs`, atomically: `null` when there is no such
   * run, it is completed, or another request holds an unexpired lease.
   */
  claim(id: string, leaseMs: number): Promise<StoredAgentVersionEvaluation | null>;
  /**
   * Store a `running` run's results and passed count, derive its score, and complete it and/or free
   * its lease. A run that is completed is not changed.
   */
  progress(id: string, progress: AgentVersionEvaluationRunProgress): Promise<void>;
}

export interface AgentVersionEvaluationRepositoryProvider {
  forScope(scope: WorkspaceScope): AgentVersionEvaluationRepository;
}

export function createDatabaseAgentVersionEvaluationRepositoryProvider(
  db: Database,
): AgentVersionEvaluationRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'AgentVersionEvaluationRepositoryProvider');
      const inWorkspace = eq(agentVersionEvaluations.workspaceId, checked.workspaceId);

      async function find(id: string): Promise<StoredAgentVersionEvaluation | null> {
        const [row] = await db
          .select({
            id: agentVersionEvaluations.id,
            createdAt: agentVersionEvaluations.createdAt,
            agentId: agentVersions.agentId,
            versionId: agentVersionEvaluations.versionId,
            version: agentVersions.number,
            status: agentVersionEvaluations.status,
            score: agentVersionEvaluations.score,
            passed: agentVersionEvaluations.passed,
            total: agentVersionEvaluations.total,
            casesSnapshot: agentVersionEvaluations.casesSnapshot,
            results: agentVersionEvaluations.results,
          })
          .from(agentVersionEvaluations)
          .innerJoin(
            agentVersions,
            and(
              eq(agentVersions.id, agentVersionEvaluations.versionId),
              eq(agentVersions.workspaceId, agentVersionEvaluations.workspaceId),
            ),
          )
          .where(and(inWorkspace, eq(agentVersionEvaluations.id, id)));
        if (row === undefined) return null;
        // A check constraint holds the column to these two values.
        return { ...row, status: row.status === 'running' ? 'running' : 'completed' };
      }

      return {
        async record(input) {
          const [row] = await db
            .insert(agentVersionEvaluations)
            .values({
              workspaceId: checked.workspaceId,
              versionId: input.versionId,
              // The same rounding as the web's `score()`, so the 201 body and the row agree.
              score: String(Math.round((input.passed / input.total) * 10_000) / 10_000),
              passed: input.passed,
              total: input.total,
              casesSnapshot: input.casesSnapshot,
              results: input.results,
              createdByPrincipalId: input.createdByPrincipalId,
            })
            .returning({
              id: agentVersionEvaluations.id,
              createdAt: agentVersionEvaluations.createdAt,
            });
          if (row === undefined) throw new Error('the evaluation insert returned no row');
          return row;
        },
        async latest(versionId) {
          const [row] = await db
            .select({
              score: agentVersionEvaluations.score,
              passed: agentVersionEvaluations.passed,
              total: agentVersionEvaluations.total,
              results: agentVersionEvaluations.results,
              createdAt: agentVersionEvaluations.createdAt,
            })
            .from(agentVersionEvaluations)
            .where(
              and(
                inWorkspace,
                eq(agentVersionEvaluations.versionId, versionId),
                eq(agentVersionEvaluations.status, 'completed'),
              ),
            )
            .orderBy(desc(agentVersionEvaluations.createdAt), desc(agentVersionEvaluations.id))
            .limit(1);
          return row ?? null;
        },
        async start(input) {
          const [row] = await db
            .insert(agentVersionEvaluations)
            .values({
              workspaceId: checked.workspaceId,
              versionId: input.versionId,
              score: '0',
              passed: 0,
              total: input.total,
              casesSnapshot: input.casesSnapshot,
              results: [],
              createdByPrincipalId: input.createdByPrincipalId,
              status: 'running',
            })
            .returning({
              id: agentVersionEvaluations.id,
              createdAt: agentVersionEvaluations.createdAt,
            });
          if (row === undefined) throw new Error('the evaluation run insert returned no row');
          return row;
        },
        find,
        async claim(id, leaseMs) {
          const claimed = await db
            .update(agentVersionEvaluations)
            .set({ leaseUntil: sql`now() + ${leaseMs} * interval '1 millisecond'` })
            .where(
              and(
                inWorkspace,
                eq(agentVersionEvaluations.id, id),
                eq(agentVersionEvaluations.status, 'running'),
                or(
                  isNull(agentVersionEvaluations.leaseUntil),
                  lt(agentVersionEvaluations.leaseUntil, sql`now()`),
                ),
              ),
            )
            .returning({ id: agentVersionEvaluations.id });
          return claimed.length === 0 ? null : find(id);
        },
        async progress(id, progress) {
          await db
            .update(agentVersionEvaluations)
            .set({
              results: progress.results,
              passed: progress.passed,
              score: sql`round(${progress.passed}::numeric / ${agentVersionEvaluations.total}, 4)`,
              ...(progress.completed ? { status: 'completed' } : {}),
              ...(progress.completed || progress.release ? { leaseUntil: null } : {}),
            })
            .where(
              and(
                inWorkspace,
                eq(agentVersionEvaluations.id, id),
                eq(agentVersionEvaluations.status, 'running'),
              ),
            );
        },
      };
    },
  };
}
