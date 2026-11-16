import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseDemoEntryStatesRepository } from './demo-entry-states.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn(
    '[repositories/demo-entry-states.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set.',
  );
}

const T0 = new Date('2026-11-16T10:00:00.000Z');
const T1 = new Date('2026-11-17T10:00:00.000Z');

describe.skipIf(!hasDatabase)('migration 0109: the demo entry states repository', () => {
  let isolated: IsolatedTestDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_demo_entry_states');
  }, 180_000);
  afterAll(async () => isolated.close());

  it('lists the entries under maintenance, and a later verdict replaces an earlier one', async () => {
    const states = createDatabaseDemoEntryStatesRepository(isolated.db);
    expect(await states.underMaintenance()).toEqual([]);
    await states.set({
      entry: 'b-entry',
      state: 'maintenance',
      reason: 'a tool did not run',
      now: T0,
    });
    await states.set({ entry: 'a-entry', state: 'maintenance', reason: 'no reply', now: T0 });
    await states.set({
      entry: 'c-entry',
      state: 'available',
      reason: 'the moment happened',
      now: T0,
    });
    expect(await states.underMaintenance()).toEqual(['a-entry', 'b-entry']);

    await states.set({
      entry: 'b-entry',
      state: 'available',
      reason: 'the moment happened',
      now: T1,
    });
    expect(await states.underMaintenance()).toEqual(['a-entry']);
  });

  it('refuses a state the daily test does not use', async () => {
    const states = createDatabaseDemoEntryStatesRepository(isolated.db);
    await expect(
      states.set({
        entry: 'x-entry',
        state: 'broken' as unknown as 'available',
        reason: 'no',
        now: T0,
      }),
    ).rejects.toThrow();
  });
});
