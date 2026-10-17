import { and, desc, eq, gte, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import {
  RUN_FEEDBACK_COMMENT_MAX_LENGTH,
  RUN_FEEDBACK_RATINGS,
  runFeedback,
  type RunFeedbackRating,
} from '../schema/run-feedback.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export { RUN_FEEDBACK_COMMENT_MAX_LENGTH, RUN_FEEDBACK_RATINGS, type RunFeedbackRating };

interface RecordRunFeedbackInput {
  readonly runId: string;
  readonly rating: RunFeedbackRating;
  readonly comment: string | null;
}

export interface ListRunFeedbackInput {
  readonly agentId: string;
  readonly rating?: RunFeedbackRating;
  /** Ratings created at or after this instant. */
  readonly since?: Date;
  readonly runId?: string;
  /** Only ratings of runs in sessions this principal owns; omitted for a workspace-wide reader. */
  readonly ownerPrincipalId?: string;
  readonly limit: number;
}

/** One rating, with the prompt its run started with (`null` before migration 0042). */
interface RunFeedbackRow {
  readonly runId: string;
  readonly rating: RunFeedbackRating;
  readonly comment: string | null;
  readonly prompt: string | null;
  readonly createdAt: Date;
}

export interface RunFeedbackRepository {
  /** Append one rating of `runId` (issue #539, C19); every call is its own row. */
  record(input: RecordRunFeedbackInput): Promise<void>;
  /** The newest ratings of `agentId`'s runs, at most `limit` (issue #620). */
  listForAgent(input: ListRunFeedbackInput): Promise<readonly RunFeedbackRow[]>;
}

export interface RunFeedbackRepositoryProvider {
  forScope(scope: WorkspaceScope): RunFeedbackRepository;
}

export function createDatabaseRunFeedbackRepositoryProvider(
  db: Database,
): RunFeedbackRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'RunFeedbackRepositoryProvider');
      return {
        async record(input) {
          await db.insert(runFeedback).values({
            workspaceId: checked.workspaceId,
            runId: input.runId,
            rating: input.rating,
            comment: input.comment,
          });
        },
        async listForAgent(input) {
          // A run reaches its agent and owner through its session (`runs.ts`'s header); every
          // join is tenant-paired, so a row of another workspace can never match.
          const predicates: SQL[] = [
            eq(runFeedback.workspaceId, checked.workspaceId),
            eq(sessions.agentId, input.agentId),
          ];
          if (input.rating !== undefined) predicates.push(eq(runFeedback.rating, input.rating));
          if (input.since !== undefined) predicates.push(gte(runFeedback.createdAt, input.since));
          if (input.runId !== undefined) predicates.push(eq(runFeedback.runId, input.runId));
          if (input.ownerPrincipalId !== undefined) {
            predicates.push(eq(sessions.ownerPrincipalId, input.ownerPrincipalId));
          }
          return db
            .select({
              runId: runFeedback.runId,
              rating: runFeedback.rating,
              comment: runFeedback.comment,
              prompt: runs.prompt,
              createdAt: runFeedback.createdAt,
            })
            .from(runFeedback)
            .innerJoin(
              runs,
              and(eq(runs.id, runFeedback.runId), eq(runs.workspaceId, runFeedback.workspaceId)),
            )
            .innerJoin(
              sessions,
              and(eq(sessions.id, runs.sessionId), eq(sessions.workspaceId, runs.workspaceId)),
            )
            .where(and(...predicates))
            .orderBy(desc(runFeedback.createdAt), desc(runFeedback.id))
            .limit(input.limit);
        },
      };
    },
  };
}
