/**
 * Pre-ENG-03 `run_events` rows, read back out of a real PostgreSQL log. Runs whenever
 * `TEST_DATABASE_URL` names a database; skipped as a block otherwise (`store.postgres.test.ts`
 * warns about it).
 */
import { describe, expect, it } from 'vitest';

import { AgentFrameSchema } from '@indx-workspace/contracts/run-events';
import { classifySdkEvent, toAgentFrames } from '@agent-workspace/run-protocol';

import { upgradeEventStream } from './agent-frames';
import type { SseWireEvent } from './sse';
import {
  LEGACY_MESSAGES,
  appendLegacyRows,
  startRunningRun,
} from './store.postgres-events.test-support';
import { databaseConfigured, useRunDatabase } from './store.postgres.test-support';

/** Every event `upgradeEventStream` serves from `events`, resuming after `resumeAfter`. */
async function serve(
  events: Parameters<typeof upgradeEventStream>[0],
  resumeAfter: Parameters<typeof upgradeEventStream>[1],
): Promise<SseWireEvent[]> {
  const served: SseWireEvent[] = [];
  for await (const event of upgradeEventStream(events, resumeAfter)) served.push(event);
  return served;
}

describe.skipIf(!databaseConfigured(process.env))('the PostgreSQL run store: legacy log', () => {
  const database = useRunDatabase();

  it('upgrades pre-ENG-03 run_events rows on read, out of a real PostgreSQL log', async () => {
    const store = database.makeStore();
    const runId = await startRunningRun(database, store, 'Legacy upgrade', 'Legacy upgrade agent');
    await appendLegacyRows(store, runId);
    await store.finish(runId, 'completed', null);

    const handle = await store.openStream(runId, null);
    if (handle === null) throw new Error('the durable run was not found');
    const served = await serve(handle.events, null);

    // A legacy log serves only `agent.*` frames, and exactly the frames a fresh run of the same
    // messages produces — the replay refinement of `docs/formal/domains/d1-runs.md`, over rows that
    // really went through PostgreSQL rather than through an in-memory map.
    const fresh = LEGACY_MESSAGES.flatMap((message) => [
      ...toAgentFrames(classifySdkEvent(message)),
    ]);
    expect(served.map((event) => event.type)).toEqual(fresh.map((frame) => frame.frame));
    expect(served.map((event) => event.data)).toEqual(fresh);
    expect(served.map((event) => String(event.id))).toEqual(['1.0', '2.0', '2.1', '3.0']);
    for (const event of served) {
      expect(AgentFrameSchema.safeParse(event.data).success, event.type).toBe(true);
    }

    // And a resume that lands inside row 2 loses neither of its frames and repeats neither.
    const resumed = await store.openStream(runId, 1n);
    if (resumed === null) throw new Error('the durable run was not found on resume');
    const tail = await serve(resumed.events, { sequence: 2n, subIndex: 0 });
    expect(tail.map((event) => String(event.id))).toEqual(['2.1', '3.0']);
  });
});
