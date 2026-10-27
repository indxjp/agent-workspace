import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseStorageMigrationRunRepository,
  createInMemoryStorageMigrationRuns,
  type StorageMigrationRunRepository,
} from './storage-migration-runs.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

function behavesAsAPerStageLog(open: () => StorageMigrationRunRepository): void {
  // @story US-STO-13
  it('[US-STO-13][api][cli] each stage reads back only its own latest pass', async () => {
    const runs = open();
    expect(await runs.latest()).toBeNull();
    expect(await runs.latest('skills')).toBeNull();

    await runs.record({ rowsChecked: 5, legacyRows: 0, mismatches: 0 });
    await runs.record({ stage: 'skills', rowsChecked: 2, legacyRows: 3, mismatches: 0 });

    // A skills pass must never stand in for the finalize pass that gates deleting old objects.
    expect(await runs.latest()).toMatchObject({ stage: 'finalize', rowsChecked: 5, legacyRows: 0 });
    expect(await runs.latest('skills')).toMatchObject({ stage: 'skills', legacyRows: 3 });

    await runs.record({ stage: 'skills', rowsChecked: 5, legacyRows: 0, mismatches: 0 });
    expect(await runs.latest('skills')).toMatchObject({ legacyRows: 0 });
    expect(await runs.latest()).toMatchObject({ rowsChecked: 5 });
  });

  // @story US-STO-13
  it('[US-STO-13][api][cli] an adopt pass keeps its skips by reason and whether it was clean', async () => {
    const runs = open();
    await runs.record({
      stage: 'adopt',
      rowsChecked: 4,
      legacyRows: 6,
      mismatches: 1,
      skippedOwnerless: 3,
      skippedPathTaken: 2,
      skippedFailed: 1,
      clean: false,
    });
    await runs.record({ rowsChecked: 1, legacyRows: 0, mismatches: 0 });

    expect(await runs.latest('adopt')).toMatchObject({
      stage: 'adopt',
      rowsChecked: 4,
      legacyRows: 6,
      mismatches: 1,
      skippedOwnerless: 3,
      skippedPathTaken: 2,
      skippedFailed: 1,
      clean: false,
    });
    // A stage that records no skips reads back none, and no clean flag.
    expect(await runs.latest()).toMatchObject({
      skippedOwnerless: 0,
      skippedPathTaken: 0,
      skippedFailed: 0,
      clean: null,
    });
  });
}

describe('storage migration runs, in memory', () => {
  behavesAsAPerStageLog(createInMemoryStorageMigrationRuns);
});

describe('storage migration runs, in the database', () => {
  let isolated: IsolatedTestDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_migration_runs');
  }, 180_000);
  afterAll(async () => {
    await isolated.close();
  });

  behavesAsAPerStageLog(() => createDatabaseStorageMigrationRunRepository(isolated.db));
});
