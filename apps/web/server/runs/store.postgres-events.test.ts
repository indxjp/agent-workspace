/**
 * The run store's event log over a real PostgreSQL: restart replay, text the database cannot
 * store, and the terminal tail. Runs whenever `TEST_DATABASE_URL` names a database; skipped as a
 * block otherwise (`store.postgres.test.ts` warns about it).
 */
import { describe, expect, it } from 'vitest';

import {
  injectingTerminalTail,
  readStream,
  startRunningRun,
} from './store.postgres-events.test-support';
import type { RunStore } from './store';
import { databaseConfigured, useRunDatabase } from './store.postgres.test-support';

describe.skipIf(!databaseConfigured(process.env))('the PostgreSQL run store: event log', () => {
  const database = useRunDatabase();

  it('replays durable events through a newly constructed store instance', async () => {
    const firstProcess = database.makeStore();
    const runId = await startRunningRun(database, firstProcess, 'Restart replay', 'Restart agent');
    await firstProcess.append(runId, { type: 'assistant', data: { text: 'before restart' } });
    await firstProcess.finish(runId, 'completed', null);

    const afterRestart = database.makeStore();
    const seen = await readStream(afterRestart, runId, null);
    expect(seen).toMatchObject([{ id: 1n, type: 'assistant', data: { text: 'before restart' } }]);
    expect(seen[0]?.at).toBeInstanceOf(Date);

    // `runs.engine` round-trips through PostgreSQL (ADR-0065): the store that created the run is
    // gone, so this value can only have come from the row.
    const reread = await afterRestart.get(runId);
    expect(reread?.engine).toBe('claude-agent-sdk');
    expect(reread?.engineVersion ?? null).toBeNull();
  });

  it('appends an event holding NUL and lone surrogates instead of failing the run (#2283)', async () => {
    const store = database.makeStore();
    const runId = await startRunningRun(database, store, 'Unstorable text', 'Binary reader');
    const appended = await store.append(runId, {
      type: 'assistant',
      data: { text: 'PNG\u0000data \uD83D' },
    });
    expect(appended.kind).toBe('appended');
    await store.finish(runId, 'completed', null);
    const seen = await readStream(database.makeStore(), runId, null);
    expect(seen).toMatchObject([{ data: { text: 'PNG�data �' } }]);
  });

  it('delivers the terminal tail committed between event listing and the status read', async () => {
    const storeRef: { current?: RunStore } = {};
    const baseEvents = database.core.createDatabaseRunEventRepositoryProvider(database.db);
    const store = database.makeStore({ events: injectingTerminalTail(baseEvents, storeRef) });
    storeRef.current = store;
    const runId = await startRunningRun(database, store, 'Terminal tail', 'Terminal tail agent');

    const delivered = (await readStream(store, runId, null)).map((event) => event.id);
    expect(delivered).toEqual([1n]);
    expect((await store.get(runId))?.status).toBe('completed');
  });
});
