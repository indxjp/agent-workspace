import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { storeLeads } from '../schema/store-leads.js';
import { createDatabaseStoreLeadRepository } from './store-leads.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const T0 = new Date('2026-11-16T10:00:00.000Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

describe.skipIf(!hasDatabase)('migration 0107: store_leads and its repository', () => {
  let isolated: IsolatedTestDatabase;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_store_leads');
  });
  afterAll(async () => {
    await isolated.close();
  });
  beforeEach(async () => {
    await isolated.db.delete(storeLeads);
  });

  const leads = async () =>
    isolated.db
      .select({
        email: storeLeads.email,
        entries: storeLeads.entries,
        createdAt: storeLeads.createdAt,
        lastContactAt: storeLeads.lastContactAt,
      })
      .from(storeLeads)
      .orderBy(storeLeads.email);

  it('makes one lead per address and keeps each entry once, in the order first opened', async () => {
    const repository = createDatabaseStoreLeadRepository(isolated.db);
    await repository.recordContact({ email: 'v@example.test', entry: 'ringi-review', now: T0 });
    await repository.recordContact({ email: 'v@example.test', entry: 'crm-sales', now: days(1) });
    await repository.recordContact({
      email: 'v@example.test',
      entry: 'ringi-review',
      now: days(2),
    });
    await repository.recordContact({ email: 'v@example.test', entry: null, now: days(3) });
    expect(await leads()).toEqual([
      {
        email: 'v@example.test',
        entries: ['ringi-review', 'crm-sales'],
        createdAt: T0,
        lastContactAt: days(3),
      },
    ]);
  });

  it('never moves the last contact back', async () => {
    const repository = createDatabaseStoreLeadRepository(isolated.db);
    await repository.recordContact({ email: 'v@example.test', entry: null, now: days(5) });
    await repository.recordContact({ email: 'v@example.test', entry: null, now: days(1) });
    expect((await leads())[0]?.lastContactAt).toEqual(days(5));
  });

  it('deletes the leads last contacted before the cutoff and keeps the rest', async () => {
    const repository = createDatabaseStoreLeadRepository(isolated.db);
    await repository.recordContact({ email: 'old@example.test', entry: null, now: T0 });
    await repository.recordContact({ email: 'edge@example.test', entry: null, now: days(10) });
    await repository.recordContact({ email: 'new@example.test', entry: null, now: days(20) });
    expect(await repository.deleteLastContactBefore(days(10))).toBe(1);
    expect((await leads()).map((lead) => lead.email)).toEqual([
      'edge@example.test',
      'new@example.test',
    ]);
  });

  it('refuses an address that is not lower-cased', async () => {
    await expect(
      isolated.db
        .insert(storeLeads)
        .values({ email: 'V@example.test', createdAt: T0, lastContactAt: T0 }),
    ).rejects.toThrow();
  });
});
