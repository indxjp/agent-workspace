/**
 * `run_feedback` — issue #539 (S2-05c, C19, ADR-0105 "Feedback"): a thumbs up or down, with an
 * optional comment, on one run's answer. Slice 4's evaluation cases read it.
 *
 * Append-only: one row per `POST /api/runs/:id/feedback`, with no unique key and no rater column
 * (visitor identity is S-2). The run reference is tenant-paired and cascades, so feedback never
 * names a run of another workspace and goes with its run.
 */
import { check, foreignKey, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';
import { runs } from './runs.js';
import { workspaces } from './workspaces.js';

/**
 * The ratings a run may get. This is the database's copy of `@indx-workspace/contracts/feedback`'s
 * list, in the same order, restated here; `apps/web/server/sdk-conformance.test.ts` holds the two
 * equal.
 */
export const RUN_FEEDBACK_RATINGS = ['up', 'down'] as const;
export type RunFeedbackRating = (typeof RUN_FEEDBACK_RATINGS)[number];

/** The longest comment, in characters; the contract's cap, restated as {@link RUN_FEEDBACK_RATINGS}. */
export const RUN_FEEDBACK_COMMENT_MAX_LENGTH = 1000;

export const runFeedback = pgTable(
  'run_feedback',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tenant-paired below as `run_feedback_run_workspace_fk`. */
    runId: uuid('run_id').notNull(),
    rating: text('rating', { enum: RUN_FEEDBACK_RATINGS }).notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
      name: 'run_feedback_run_workspace_fk',
    }).onDelete('cascade'),
    index('run_feedback_workspace_run_idx').on(table.workspaceId, table.runId),
    oneOf('run_feedback_rating_valid', table.rating, RUN_FEEDBACK_RATINGS),
    // `char_length` counts code points, never more than JS `.length`, so the database never
    // refuses a comment the contract accepted.
    check(
      'run_feedback_comment_length',
      sql`${table.comment} is null or char_length(${table.comment}) <= ${sql.raw(
        String(RUN_FEEDBACK_COMMENT_MAX_LENGTH),
      )}`,
    ),
  ],
);

export type RunFeedback = typeof runFeedback.$inferSelect;
