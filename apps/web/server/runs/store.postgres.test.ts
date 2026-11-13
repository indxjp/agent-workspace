/**
 * The run store over a real PostgreSQL and in memory, against the shared conformance suite
 * (`store.conformance.test-support.ts`). The event log suites are in `store.postgres-events.test.ts`
 * and `store.postgres-legacy.test.ts`; the `listRuns` suites are in `store.postgres-list*.test.ts`
 * and `store.postgres-differential.test.ts`.
 *
 * Runs whenever `TEST_DATABASE_URL` names a database; skipped as a block otherwise.
 */
import { describe, expect, it } from 'vitest';

import { InMemoryRunStore } from './memory-store';
import type { CreateRunInput } from './store';
import { describeRunStoreConformance } from './store.conformance.test-support';
import { runInput } from './store.postgres-events.test-support';
import { databaseConfigured, useRunDatabase } from './store.postgres.test-support';
import type { MakeRunStoreFixture } from './store.test-support';

const hasDatabase = databaseConfigured(process.env);

if (!hasDatabase) {
  console.warn(
    '[runs/store.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half ' +
      'of this conformance suite did NOT run. A green result without it says nothing about ' +
      'whether run records reach the database at all.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL run store', () => {
  const database = useRunDatabase();

  it('refuses by name when the workspace a run names does not exist', async () => {
    const store = database.makeStore();
    // A create against a workspace with no row is a named failure, not a run that quietly exists
    // nowhere. `get` on an id nothing has ever used stays `null`, because that one really is
    // "not found" and the route turns it into a 404.
    const missingChain = {
      workspaceId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      principalId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    };
    await expect(store.create(runInput(missingChain, crypto.randomUUID()))).rejects.toThrow(
      /no workspace has id/u,
    );
    expect(await store.get(crypto.randomUUID())).toBeNull();
  });

  const postgresFixture: MakeRunStoreFixture = async ({ maxEventsPerRun }) => {
    // The whole referential chain a `runs` row needs: workspace → user → membership → agent →
    // session. Fresh every time, so this fixture collides with nothing else on the server.
    const chain = await database.seedChain({
      workspace: 'Runs',
      user: 'Runner',
      agent: 'General',
    });
    const modelConnectionId = crypto.randomUUID();
    await database.db.insert(database.core.modelConnections).values({
      id: modelConnectionId,
      workspaceId: chain.workspaceId,
      name: 'Snapshot fixture connection',
      provider: 'anthropic',
      config: {},
    });

    return {
      store: database.makeStore(maxEventsPerRun === undefined ? {} : { maxEventsPerRun }),
      nextRun: (): CreateRunInput => runInput(chain, crypto.randomUUID()),
      modelConnectionId,
    };
  };

  describeRunStoreConformance('over a real PostgreSQL, against the same suite', postgresFixture);
});

// Both implementations run the same suite from this one file, which is what
// tests/store-conformance.test.ts checks for every memory store (F-13).
// ── The in-memory implementation ─────────────────────────────────────────────────────────────

const memoryFixture: MakeRunStoreFixture = ({ maxEventsPerRun }) => {
  const chain = {
    workspaceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
  };
  return Promise.resolve({
    store:
      maxEventsPerRun === undefined
        ? new InMemoryRunStore()
        : new InMemoryRunStore({ maxEventsPerRun }),
    nextRun: (): CreateRunInput => runInput(chain, crypto.randomUUID()),
    // No referential integrity in this implementation, so any id will do.
    modelConnectionId: crypto.randomUUID(),
  });
};

describeRunStoreConformance('the in-memory run store', memoryFixture);
