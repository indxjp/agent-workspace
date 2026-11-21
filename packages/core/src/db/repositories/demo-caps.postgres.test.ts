import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { demoDailyCosts } from '../schema/demo-daily-costs.js';
import { demoRunAdmissions } from '../schema/demo-run-admissions.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseDemoCapsRepository } from './demo-caps.js';
import { insertDemoWorkspace } from './demo-workspace.test-support.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/demo-caps.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

const T0 = new Date('2026-11-16T10:00:00.000Z');
const DAY_START = new Date('2026-11-16T00:00:00.000Z');
const DAY_END = new Date('2026-11-17T00:00:00.000Z');
const WINDOW_START = new Date(T0.getTime() - 24 * 60 * 60 * 1000);

describe.skipIf(!hasDatabase)('migration 0107: the demo run caps repository', () => {
  let isolated: IsolatedTestDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_demo_caps');
  }, 180_000);
  afterAll(async () => isolated.close());

  const admit = (userId: string, clientKey: string, personLimit: number, clientLimit: number) =>
    createDatabaseDemoCapsRepository(isolated.db).admit({
      userId,
      clientKey,
      now: T0,
      since: WINDOW_START,
      personLimit,
      clientLimit,
    });

  it('keeps demo writes in a demo workspace and a verification workspace, and in no other (ADR-0169)', async () => {
    const caps = createDatabaseDemoCapsRepository(isolated.db);
    const demo = await insertDemoWorkspace(isolated, {
      createdAt: T0,
      demoExpiresAt: new Date(T0.getTime() + 60_000),
    });
    const ordinary = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
    const verification = await insertDemoWorkspace(isolated, {
      createdAt: T0,
      demoExpiresAt: null,
    });
    expect(await caps.keepsDemoWrites(demo.workspaceId)).toBe(true);
    expect(await caps.keepsDemoWrites(ordinary.workspaceId)).toBe(false);
    expect(await caps.keepsDemoWrites(verification.workspaceId)).toBe(false);
    expect(await caps.keepsDemoWrites(crypto.randomUUID())).toBe(false);

    await caps.markVerificationWorkspace(verification.workspaceId, T0);
    expect(await caps.keepsDemoWrites(verification.workspaceId)).toBe(true);
    expect(await caps.keepsDemoWrites(ordinary.workspaceId)).toBe(false);
    // A later fill leaves the first mark as it is.
    await caps.markVerificationWorkspace(verification.workspaceId, new Date(T0.getTime() + 1_000));
    const [row] = await isolated.db
      .select({ at: workspaces.demoVerificationAt })
      .from(workspaces)
      .where(eq(workspaces.id, verification.workspaceId));
    expect(row?.at?.toISOString()).toBe(T0.toISOString());
    // Marking is not a demo: nothing sweeps the workspace.
    expect(await caps.demoExpiresAt(verification.workspaceId)).toBeNull();
  });

  it('admits at the last place and refuses past it, per person', async () => {
    const { userId } = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      outcomes.push(await admit(userId, 'client-person-test', 3, 100));
    }
    expect(outcomes).toEqual(['admitted', 'admitted', 'admitted', 'person_limit']);
  });

  it('counts a person across workspaces: a new workspace does not reset the count', async () => {
    const first = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
    expect(await admit(first.userId, 'client-reset-test', 1, 100)).toBe('admitted');
    // The same person's admissions are keyed by user, not by workspace.
    expect(await admit(first.userId, 'client-reset-test', 1, 100)).toBe('person_limit');
  });

  it('counts a client address across accounts', async () => {
    const a = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
    const b = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
    expect(await admit(a.userId, 'client-shared', 100, 2)).toBe('admitted');
    expect(await admit(b.userId, 'client-shared', 100, 2)).toBe('admitted');
    expect(await admit(a.userId, 'client-shared', 100, 2)).toBe('client_limit');
  });

  it('does not count an admission older than the window', async () => {
    const { userId } = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
    await isolated.db.insert(demoRunAdmissions).values({
      userId,
      clientKey: 'client-old',
      createdAt: new Date(WINDOW_START.getTime() - 1),
    });
    expect(await admit(userId, 'client-old', 1, 100)).toBe('admitted');
  });

  it('admits exactly one of many concurrent calls at the last place', async () => {
    const { userId } = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => admit(userId, 'client-race', 1, 100)),
    );
    expect(outcomes.filter((outcome) => outcome === 'admitted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'person_limit')).toHaveLength(7);
  });

  it('admits at most the client limit of concurrent calls from many accounts', async () => {
    const users = await Promise.all(
      Array.from({ length: 6 }, () =>
        insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null }),
      ),
    );
    const outcomes = await Promise.all(
      users.map(({ userId }) => admit(userId, 'client-race-shared', 100, 2)),
    );
    expect(outcomes.filter((outcome) => outcome === 'admitted')).toHaveLength(2);
  });

  it('answers a demo workspace its end and a real one null', async () => {
    const end = new Date(T0.getTime() + 24 * 60 * 60 * 1000);
    const demo = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: end });
    const real = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
    const repository = createDatabaseDemoCapsRepository(isolated.db);
    expect(await repository.demoExpiresAt(demo.workspaceId)).toEqual(end);
    expect(await repository.demoExpiresAt(real.workspaceId)).toBeNull();
  });

  describe('the site spend of a UTC day', () => {
    it('sums the live demo workspaces and the carried day, and leaves real workspaces out', async () => {
      await isolated.db.delete(demoDailyCosts);
      const end = new Date(T0.getTime() + 24 * 60 * 60 * 1000);
      const demo = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: end });
      const real = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
      await demo.addUsage({ costUsd: '1.250000', at: T0 });
      await real.addUsage({ costUsd: '99.000000', at: T0 });
      await demo.addUsage({ costUsd: '7.000000', at: new Date(DAY_START.getTime() - 1) });
      await isolated.db
        .insert(demoDailyCosts)
        .values({ day: '2026-11-16', costUsd: '0.750000', updatedAt: T0 });
      const spent = await createDatabaseDemoCapsRepository(isolated.db).spentOn(DAY_START, DAY_END);
      expect(Number(spent.costUsd)).toBeCloseTo(2, 6);
      expect(spent.unpricedUsage).toBe(false);
    });

    it('is unpriced when a demo run has an unpriced or failed settlement', async () => {
      await isolated.db.delete(demoDailyCosts);
      const end = new Date(T0.getTime() + 24 * 60 * 60 * 1000);
      const demo = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: end });
      await demo.addUsage({ costUsd: '0', at: T0, accounting: 'failed' });
      const spent = await createDatabaseDemoCapsRepository(isolated.db).spentOn(DAY_START, DAY_END);
      expect(spent.unpricedUsage).toBe(true);
    });

    it('is unpriced when the carried day was', async () => {
      await isolated.db.delete(demoDailyCosts);
      await isolated.db.insert(demoDailyCosts).values({
        day: '2026-11-16',
        costUsd: '0',
        unpricedUsage: true,
        updatedAt: T0,
      });
      const spent = await createDatabaseDemoCapsRepository(isolated.db).spentOn(DAY_START, DAY_END);
      expect(spent.unpricedUsage).toBe(true);
    });
  });
});
