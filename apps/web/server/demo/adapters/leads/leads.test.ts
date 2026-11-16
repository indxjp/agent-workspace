import {
  createDatabaseStoreLeadRepository,
  createIsolatedTestDatabase,
  storeLeads,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll } from 'vitest';

import { describeLeadStoreConformance } from './leads.contract';
import { MemoryLeadStore } from './memory';
import { createLeadStore } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describeLeadStoreConformance('the memory adapter', () => {
  const store = new MemoryLeadStore();
  return Promise.resolve({
    store,
    read: () => Promise.resolve(store.leads),
  });
});

if (hasDatabase) {
  let isolated: IsolatedTestDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_store_leads_store');
  });
  afterAll(async () => {
    await isolated.close();
  });

  describeLeadStoreConformance('the PostgreSQL adapter', async () => {
    await isolated.db.delete(storeLeads);
    return {
      store: createLeadStore(createDatabaseStoreLeadRepository(isolated.db)),
      read: () =>
        isolated.db
          .select({
            email: storeLeads.email,
            entries: storeLeads.entries,
            enquiry: storeLeads.enquiry,
            enquirySetup: storeLeads.enquirySetup,
            launchNotices: storeLeads.launchNotices,
            lastContactAt: storeLeads.lastContactAt,
          })
          .from(storeLeads)
          .orderBy(storeLeads.email),
    };
  });
}
