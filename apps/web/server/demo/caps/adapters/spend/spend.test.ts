import { afterAll, beforeAll } from 'vitest';
import {
  createDatabaseDemoCapsRepository,
  createIsolatedTestDatabase,
  demoDailyCosts,
  runUsageRecords,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { insertWorkspaceWithUsage } from '../../pg-fixtures.test-support';
import { MemoryDemoSpend } from './memory';
import { describeDemoSpendConformance } from './spend.contract';
import { createDemoSpend } from './store';

const DAY_MS = 24 * 60 * 60 * 1000;
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describeDemoSpendConformance('the memory adapter', () => {
  const spend = new MemoryDemoSpend();
  return Promise.resolve({
    spend,
    addLive: (at, costUsd) => Promise.resolve(spend.addLive(at, costUsd)),
    addLiveUnpriced: (at) => Promise.resolve(spend.addLive(at, 0, true)),
    addReal: () => Promise.resolve(),
    carry: (day, costUsd, unpriced) => Promise.resolve(spend.carry(day, costUsd, unpriced)),
  });
});

if (hasDatabase) {
  let isolated: IsolatedTestDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_demo_spend_store');
  }, 180_000);
  afterAll(async () => {
    await isolated.close();
  });

  describeDemoSpendConformance('the PostgreSQL adapter', async () => {
    // The usage, runs, workspaces and carried days of the previous test are removed.
    await isolated.db.delete(runUsageRecords);
    await isolated.db.delete(workspaces);
    await isolated.db.delete(demoDailyCosts);
    return {
      spend: createDemoSpend(createDatabaseDemoCapsRepository(isolated.db)),
      addLive: async (at, costUsd) => {
        await insertWorkspaceWithUsage(isolated, {
          createdAt: new Date(at.getTime() - 60_000),
          demoExpiresAt: new Date(at.getTime() + DAY_MS),
          usage: [{ at, costUsd }],
        });
      },
      addLiveUnpriced: async (at) => {
        await insertWorkspaceWithUsage(isolated, {
          createdAt: new Date(at.getTime() - 60_000),
          demoExpiresAt: new Date(at.getTime() + DAY_MS),
          usage: [{ at, costUsd: 0, accounting: 'pending' }],
        });
      },
      addReal: async (at, costUsd) => {
        await insertWorkspaceWithUsage(isolated, {
          createdAt: new Date(at.getTime() - 60_000),
          demoExpiresAt: null,
          usage: [{ at, costUsd }],
        });
      },
      carry: async (day, costUsd, unpriced) => {
        await isolated.db.insert(demoDailyCosts).values({
          day,
          costUsd: costUsd.toFixed(6),
          unpricedUsage: unpriced,
          updatedAt: new Date(),
        });
      },
    };
  });
}
