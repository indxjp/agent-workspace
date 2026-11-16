import {
  createDatabaseDemoCapsRepository,
  createIsolatedTestDatabase,
  users,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll } from 'vitest';

import { describeDemoRunAdmissionsConformance } from './admissions.contract';
import { MemoryDemoRunAdmissions } from './memory';
import { createDemoRunAdmissions } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describeDemoRunAdmissionsConformance('the memory adapter', () =>
  Promise.resolve({
    admissions: new MemoryDemoRunAdmissions(),
    person: () => Promise.resolve(crypto.randomUUID()),
  }),
);

if (hasDatabase) {
  let isolated: IsolatedTestDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_demo_admissions_store');
  }, 180_000);
  afterAll(async () => {
    await isolated.close();
  });

  describeDemoRunAdmissionsConformance('the PostgreSQL adapter', () =>
    Promise.resolve({
      admissions: createDemoRunAdmissions(createDatabaseDemoCapsRepository(isolated.db)),
      person: async () => {
        const id = crypto.randomUUID();
        await isolated.db.insert(users).values({ id, email: `${id}@example.test`, name: 'Guest' });
        return id;
      },
    }),
  );
}
