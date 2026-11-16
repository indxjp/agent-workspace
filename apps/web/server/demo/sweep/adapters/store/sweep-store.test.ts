import {
  createDatabaseDemoSweepRepository,
  createIsolatedTestDatabase,
  demoDailyCosts,
  demoRunAdmissions,
  loginTokens,
  memberships,
  storeLeads,
  users,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';

import { insertWorkspaceWithUsage } from '../../../caps/pg-fixtures.test-support';
import { MemoryDemoSweepStore } from './memory';
import { describeDemoSweepStoreConformance } from './sweep-store.contract';
import { createDemoSweepStore } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
const DAY_MS = 24 * 60 * 60 * 1000;
const T_FAR = Date.UTC(2100, 0, 1);

describeDemoSweepStoreConformance('the memory adapter', () => {
  const store = new MemoryDemoSweepStore();
  return Promise.resolve({
    store,
    addWorkspace: ({ demoExpiresAt, usage = [] }) => {
      const id = crypto.randomUUID();
      store.addWorkspace(id, {
        demoExpiresAt,
        usage: usage.map((row) => ({ ...row, unpriced: row.unpriced ?? false })),
      });
      return Promise.resolve(id);
    },
    hasWorkspace: (id) => Promise.resolve(store.hasWorkspace(id)),
    carried: () =>
      Promise.resolve(
        [...store.carried].sort().map(([day, row]) => [day, row.costUsd, row.unpriced] as const),
      ),
    addLoginToken: (expiresAt, usedAt) => Promise.resolve(store.addLoginToken(expiresAt, usedAt)),
    loginTokenCount: () => Promise.resolve(store.loginTokenCount),
    addAdmission: (at) => Promise.resolve(store.addAdmission(at)),
    admissionCount: () => Promise.resolve(store.admissionCount),
    addGuestUser: ({ createdAt, holds, lead = true }) => {
      const id = crypto.randomUUID();
      store.addUser(id, { createdAt, held: holds === 'membership', lead });
      if (typeof holds === 'object') store.addAdmission(holds.admittedAt, id);
      return Promise.resolve(id);
    },
    hasUser: (id) => Promise.resolve(store.hasUser(id)),
  });
});

if (hasDatabase) {
  let isolated: IsolatedTestDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_demo_sweep_store');
  }, 180_000);
  afterAll(async () => {
    await isolated.close();
  });

  describeDemoSweepStoreConformance('the PostgreSQL adapter', async () => {
    await isolated.db.delete(workspaces);
    await isolated.db.delete(users);
    await isolated.db.delete(loginTokens);
    await isolated.db.delete(demoRunAdmissions);
    await isolated.db.delete(demoDailyCosts);
    await isolated.db.delete(storeLeads);
    let sequence = 0;
    const hex = (n: number) => n.toString(16).padStart(64, '0');
    const guest = crypto.randomUUID();
    await isolated.db.insert(users).values({
      id: guest,
      email: `${guest}@example.test`,
      name: 'Admitted guest',
      // Far ahead of any cutoff a test uses, so the user sweep never reaches this one.
      createdAt: new Date(T_FAR),
    });
    const tableCount = async (table: typeof loginTokens | typeof demoRunAdmissions) =>
      (await isolated.db.select({ n: count() }).from(table))[0]?.n ?? 0;
    return {
      store: createDemoSweepStore(createDatabaseDemoSweepRepository(isolated.db)),
      addWorkspace: async ({ demoExpiresAt, usage = [] }) => {
        const createdAt = new Date(
          Math.min(
            (demoExpiresAt?.getTime() ?? Date.now()) - DAY_MS,
            ...usage.map((row) => row.at.getTime() - 1000),
          ),
        );
        const { workspaceId } = await insertWorkspaceWithUsage(isolated, {
          createdAt,
          demoExpiresAt,
          usage: usage.map((row) => ({
            at: row.at,
            costUsd: row.costUsd,
            accounting: row.unpriced === true ? 'pending' : 'complete',
          })),
        });
        return workspaceId;
      },
      hasWorkspace: async (id) =>
        (
          await isolated.db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, id))
        ).length === 1,
      carried: async () =>
        (await isolated.db.select().from(demoDailyCosts).orderBy(demoDailyCosts.day)).map(
          (row) => [row.day, Number(row.costUsd), row.unpricedUsage] as const,
        ),
      addLoginToken: async (expiresAt, usedAt) => {
        sequence += 1;
        await isolated.db.insert(loginTokens).values({
          tokenHash: hex(sequence),
          emailHash: hex(sequence + 1_000_000),
          // Made before it was used and before it expired, as the table's checks require.
          createdAt: new Date(
            Math.min(expiresAt.getTime(), usedAt?.getTime() ?? Infinity) - 60_000,
          ),
          expiresAt,
          ...(usedAt === undefined ? {} : { usedAt }),
        });
      },
      loginTokenCount: () => tableCount(loginTokens),
      addAdmission: async (at) => {
        await isolated.db
          .insert(demoRunAdmissions)
          .values({ userId: guest, clientKey: 'client', createdAt: at });
      },
      admissionCount: () => tableCount(demoRunAdmissions),
      addGuestUser: async ({ createdAt, holds, lead = true }) => {
        const id = crypto.randomUUID();
        const email = `${id}@example.test`;
        await isolated.db.insert(users).values({ id, email, name: 'Guest', createdAt });
        if (lead) {
          await isolated.db
            .insert(storeLeads)
            .values({ email, createdAt, lastContactAt: createdAt });
        }
        if (holds === 'membership') {
          const { workspaceId } = await insertWorkspaceWithUsage(isolated, {
            createdAt,
            demoExpiresAt: new Date(createdAt.getTime() + DAY_MS),
            usage: [],
          });
          await isolated.db.insert(memberships).values({ workspaceId, userId: id, role: 'guest' });
        } else if (holds !== undefined) {
          await isolated.db
            .insert(demoRunAdmissions)
            .values({ userId: id, clientKey: 'client', createdAt: holds.admittedAt });
        }
        return id;
      },
      hasUser: async (id) =>
        (await isolated.db.select({ id: users.id }).from(users).where(eq(users.id, id))).length ===
        1,
    };
  });
}
