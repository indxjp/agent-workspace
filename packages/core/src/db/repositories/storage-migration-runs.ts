import { desc, eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { storageMigrationRuns, storageMigrationStages } from '../schema/storage-migration-runs.js';

/** What one verify pass of the move off the old object naming found. */
export interface StorageMigrationRunInput {
  /** Which pass this is; `finalize` when absent. */
  readonly stage?: StorageMigrationStage;
  readonly rowsChecked: number;
  /** Rows still without an object id. */
  readonly legacyRows: number;
  readonly mismatches: number;
  /** What the `adopt` pass skipped, by reason; 0 when absent. */
  readonly skippedOwnerless?: number;
  readonly skippedPathTaken?: number;
  readonly skippedFailed?: number;
  /** The `adopt` pass: no workspace failed. `null` when absent. */
  readonly clean?: boolean | null;
}

type StorageMigrationStage = (typeof storageMigrationStages)[number];

export interface StorageMigrationRun extends Required<StorageMigrationRunInput> {
  readonly finishedAt: Date;
}

/**
 * The pass log of the finalize stage (the storage design, §06). Deployment-wide: a pass covers
 * every workspace, so there is no scope.
 */
export interface StorageMigrationRunRepository {
  /** Append one pass. */
  record(run: StorageMigrationRunInput): Promise<void>;
  /** The most recent pass of `stage` (`finalize` by default), or `null` when none was recorded. */
  latest(stage?: StorageMigrationStage): Promise<StorageMigrationRun | null>;
}

export function createDatabaseStorageMigrationRunRepository(
  db: Database,
): StorageMigrationRunRepository {
  return {
    async record(run) {
      await db.insert(storageMigrationRuns).values(run);
    },
    async latest(stage = 'finalize') {
      const [row] = await db
        .select({
          stage: storageMigrationRuns.stage,
          finishedAt: storageMigrationRuns.finishedAt,
          rowsChecked: storageMigrationRuns.rowsChecked,
          legacyRows: storageMigrationRuns.legacyRows,
          mismatches: storageMigrationRuns.mismatches,
          skippedOwnerless: storageMigrationRuns.skippedOwnerless,
          skippedPathTaken: storageMigrationRuns.skippedPathTaken,
          skippedFailed: storageMigrationRuns.skippedFailed,
          clean: storageMigrationRuns.clean,
        })
        .from(storageMigrationRuns)
        .where(eq(storageMigrationRuns.stage, stage))
        .orderBy(desc(storageMigrationRuns.finishedAt), desc(storageMigrationRuns.id))
        .limit(1);
      return row ?? null;
    },
  };
}

/** The same log held in memory, for tests. */
export function createInMemoryStorageMigrationRuns(): StorageMigrationRunRepository {
  const runs: StorageMigrationRun[] = [];
  return {
    record: (run) => {
      runs.push({
        stage: 'finalize',
        skippedOwnerless: 0,
        skippedPathTaken: 0,
        skippedFailed: 0,
        clean: null,
        ...run,
        finishedAt: new Date(),
      });
      return Promise.resolve();
    },
    latest: (stage = 'finalize') =>
      Promise.resolve(runs.findLast((run) => run.stage === stage) ?? null),
  };
}
