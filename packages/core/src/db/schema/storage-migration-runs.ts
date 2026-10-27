/**
 * `storage_migration_runs` — one row per verify pass of the move off the old object naming (the
 * storage design, §06 "Moving existing files safely"). The finalize stage appends a row after it has
 * checked every object; old copies are deleted only while the latest row shows no legacy rows and no
 * mismatches. The table is deployment-wide, not tenant-scoped: a pass covers every workspace.
 */
import { bigint, boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { primaryKeyId } from './columns.js';
import { oneOf } from './one-of.js';

/**
 * `finalize` verifies files and blobs; `skills` is the skills adopt pass (`legacyRows` = legacy skill
 * objects left); `adopt` is the file adopt pass (`rowsChecked` = objects adopted, `legacyRows` =
 * objects skipped, `mismatches` = failed workspaces, and the skip reasons and `clean` below).
 */
export const storageMigrationStages = ['finalize', 'skills', 'adopt'] as const;

export const storageMigrationRuns = pgTable(
  'storage_migration_runs',
  {
    id: primaryKeyId(),
    /** When the pass ended. */
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Objects whose size and checksum were checked. */
    rowsChecked: bigint('rows_checked', { mode: 'number' }).notNull(),
    /** Rows still without an object id (`object_id IS NULL`) when the pass ended. */
    legacyRows: bigint('legacy_rows', { mode: 'number' }).notNull(),
    /** Objects missing, of another size, or of another checksum than their row. */
    mismatches: bigint('mismatches', { mode: 'number' }).notNull(),
    stage: text('stage', { enum: storageMigrationStages }).notNull().default('finalize'),
    /** `adopt`: objects skipped because their workspace has no owner. */
    skippedOwnerless: bigint('skipped_ownerless', { mode: 'number' }).notNull().default(0),
    /** `adopt`: objects skipped because another row holds their path. */
    skippedPathTaken: bigint('skipped_path_taken', { mode: 'number' }).notNull().default(0),
    /** `adopt`: objects skipped because their workspace failed (gone, or a store call failed). */
    skippedFailed: bigint('skipped_failed', { mode: 'number' }).notNull().default(0),
    /** `adopt`: no workspace failed. `null` for the stages that do not record it. */
    clean: boolean('clean'),
  },
  (table) => [
    index('storage_migration_runs_finished_idx').on(table.finishedAt),
    oneOf('storage_migration_runs_stage_valid', table.stage, storageMigrationStages),
  ],
);
