/**
 * The `events`, `openStream` and `listRuns` topics of the run store conformance suite (see
 * `store.conformance.ts`).
 */
import { describe, expect, it } from 'vitest';

import type { RunStore } from './store';
import { PLATFORM_EVENT_NAMES, RUN_STATUS_EVENT } from './sse';
import type { PlatformEventName } from './sse';
import { take, type ConformanceHarness } from './store.test-support';

export function describeStreams(harness: ConformanceHarness): void {
  describeAppend(harness);
  describeAppendRefusals(harness);
  describeReplayAndFollow(harness);
  describeStreamEnding(harness);
  describeResets(harness);
  describeSubscribers(harness);
  describeListLimits(harness);
}

function describeAppend({ started, make }: ConformanceHarness): void {
  describe('events', () => {
    it('assigns monotonic ids from 1', async () => {
      const { store, run } = await started();
      const a = await store.append(run.id, { type: 'assistant', data: 1 });
      const b = await store.append(run.id, { type: 'assistant', data: 2 });
      expect(a).toMatchObject({
        kind: 'appended',
        event: { id: 1n, type: 'assistant', data: 1 },
      });
      expect(a.kind === 'appended' && a.event.at).toBeInstanceOf(Date);
      expect(b.kind === 'appended' && b.event.id).toBe(2n);
    });

    it('stamps each event with the time it was recorded, on append and when streamed', async () => {
      const { store, run } = await started();
      const before = Date.now() - 60_000;
      await store.append(run.id, { type: 'assistant', data: 'a' });
      await store.append(run.id, { type: 'assistant', data: 'b' });
      const handle = await store.openStream(run.id, null);
      if (handle === null) throw new Error('no handle');
      const streamed = await take(handle.events, 2);
      handle.close();
      const times = streamed.map((event) => event.at?.getTime() ?? Number.NaN);
      expect(times.every((time) => time >= before && time <= Date.now() + 60_000)).toBe(true);
      expect(times[1]).toBeGreaterThanOrEqual(times[0] ?? Number.POSITIVE_INFINITY);
    });

    it('rejects an unknown run by name rather than silently dropping the event', async () => {
      const fixture = await make({});
      const absent = fixture.nextRun().id;
      const result = await fixture.store.append(absent, { type: 'assistant', data: 1 });
      expect(result).toEqual({ kind: 'rejected', reason: `no run ${absent}` });
    });
  });
}

function describeAppendRefusals({ started }: ConformanceHarness): void {
  describe('events', () => {
    it('rejects an injectable event name and a reserved one at ingestion', async () => {
      const { store, run } = await started();
      const injected = await store.append(run.id, { type: 'x\ndata: forged', data: 1 });
      expect(injected.kind).toBe('rejected');
      const reserved = await store.append(run.id, { type: 'done', data: 1 });
      expect(reserved.kind).toBe('rejected');
    });

    it('refuses a relayed frame that names one of the platform lifecycle events', async () => {
      const { store, run } = await started();
      for (const name of PLATFORM_EVENT_NAMES) {
        const forged = await store.append(run.id, { type: name, data: { status: 'completed' } });
        expect(forged.kind).toBe('rejected');
      }
      // ...and the platform path, the only one that accepts them, still works.
      const written = await store.appendPlatformEvent(run.id, {
        type: RUN_STATUS_EVENT,
        data: { status: 'running', error: null },
      });
      expect(written.kind).toBe('appended');
    });

    it('accepts nothing but a platform event name on the platform path', async () => {
      const { store, run } = await started();
      // The cast is the point of the test: the compile-time narrowing is not the whole defence,
      // so the run-time check is exercised with values that got past it.
      for (const name of ['assistant', 'done', 'run.status ', '']) {
        const result = await store.appendPlatformEvent(run.id, {
          type: name as PlatformEventName,
          data: 1,
        });
        expect(result.kind).toBe('rejected');
      }
    });

    it('rejects an unserialisable payload at ingestion, not at render time', async () => {
      const { store, run } = await started();
      expect((await store.append(run.id, { type: 'assistant', data: 1n })).kind).toBe('rejected');
      expect((await store.append(run.id, { type: 'assistant', data: undefined })).kind).toBe(
        'rejected',
      );
    });

    it('closes the log once the run is terminal', async () => {
      const { store, run } = await started();
      await store.finish(run.id, 'completed', null);
      const result = await store.append(run.id, { type: 'assistant', data: 1 });
      expect(result.kind).toBe('rejected');
    });
  });
}

/** Drains a handle in the background and returns the ids it yields once it ends. */
async function drainIds(events: AsyncIterable<{ readonly id: bigint }>): Promise<bigint[]> {
  const seen: bigint[] = [];
  for await (const event of events) seen.push(event.id);
  return seen;
}

/** Opens a stream the test expects to exist. */
type OpenedStream = NonNullable<Awaited<ReturnType<RunStore['openStream']>>>;

async function openExisting(
  store: RunStore,
  runId: string,
  after: bigint | null,
): Promise<OpenedStream> {
  const handle = await store.openStream(runId, after);
  if (handle === null) throw new Error('no handle');
  return handle;
}

function describeReplayAndFollow({ started, make }: ConformanceHarness): void {
  describe('openStream', () => {
    it('returns null for a run that does not exist, so the route can answer 404', async () => {
      const fixture = await make({});
      expect(await fixture.store.openStream(fixture.nextRun().id, null)).toBeNull();
    });

    it('replays the backlog then follows live events, in one sequence', async () => {
      const { store, run } = await started();
      await store.append(run.id, { type: 'assistant', data: 'a' });
      await store.append(run.id, { type: 'assistant', data: 'b' });

      const handle = await openExisting(store, run.id, null);
      const taken = take(handle.events, 3);
      await store.append(run.id, { type: 'assistant', data: 'c' });
      expect((await taken).map((e) => e.data)).toEqual(['a', 'b', 'c']);
      handle.close();
    });

    it('does not strand an event appended while the consumer was mid-yield', async () => {
      // Regression. The first version of openStream armed its waiter only *after* draining the
      // backlog, so an append that landed while the generator was suspended at a `yield` found
      // no resolver, its notification was dropped, and the event sat in the log until some
      // later append happened to wake the stream. On a run whose last event is its
      // `run.status`, "some later append" never comes and the client waits for a completion
      // frame that has already been written.
      const { store, run } = await started();
      await store.append(run.id, { type: 'assistant', data: 'a' });
      const handle = await openExisting(store, run.id, null);
      const taken = take(handle.events, 2);
      // Appended after the generator has already computed its backlog and yielded from it.
      await store.append(run.id, { type: 'assistant', data: 'b' });
      const seen = await Promise.race([
        taken,
        new Promise<'stranded'>((resolve) => setTimeout(() => resolve('stranded'), 1000)),
      ]);
      expect(seen).not.toBe('stranded');
      handle.close();
    });

    it('replays only what comes after the cursor', async () => {
      const { store, run } = await started();
      for (const data of ['a', 'b', 'c']) await store.append(run.id, { type: 'assistant', data });
      await store.finish(run.id, 'completed', null);

      const handle = await openExisting(store, run.id, 2n);
      expect(handle.reset).toBeNull();
      expect(await drainIds(handle.events)).toEqual([3n]);
    });
  });
}

function describeStreamEnding({ started }: ConformanceHarness): void {
  describe('openStream', () => {
    it('ends the stream when the run is already terminal, rather than hanging', async () => {
      const { store, run } = await started();
      await store.append(run.id, { type: 'assistant', data: 'a' });
      await store.finish(run.id, 'failed', 'boom');
      const handle = await openExisting(store, run.id, null);
      // One event, and then the loop terminated of its own accord rather than waiting for more.
      expect(await drainIds(handle.events)).toEqual([1n]);
    });

    it('ends a live stream the moment the run reaches a terminal status', async () => {
      const { store, run } = await started();
      const handle = await openExisting(store, run.id, null);
      const drained = drainIds(handle.events);
      await store.append(run.id, { type: 'assistant', data: 'a' });
      await store.finish(run.id, 'completed', null);
      expect(await drained).toEqual([1n]);
    });

    it('close() ends the iteration and is idempotent', async () => {
      const { store, run } = await started();
      const handle = await openExisting(store, run.id, null);
      const drained = drainIds(handle.events);
      await store.append(run.id, { type: 'assistant', data: 'a' });
      // Give the generator a turn to deliver the event before closing.
      await new Promise((resolve) => setTimeout(resolve, 0));
      handle.close();
      handle.close();
      expect(await drained).toEqual([1n]);
    });
  });
}

function describeResets({ started }: ConformanceHarness): void {
  describe('openStream', () => {
    it('announces a reset when the cursor names events that have been evicted', async () => {
      const { store, run } = await started(3);
      for (let i = 0; i < 6; i += 1) await store.append(run.id, { type: 'assistant', data: i });
      // Ids 1-3 are gone; 4, 5, 6 are retained.
      const handle = await openExisting(store, run.id, 1n);
      expect(handle.reset).not.toBeNull();
      expect(handle.reset?.resumedAfter).toBe('3');
      const seen = await take(handle.events, 3);
      expect(seen.map((e) => e.id)).toEqual([4n, 5n, 6n]);
      handle.close();
    });

    it('announces a reset on a first connection after the beginning was evicted', async () => {
      const { store, run } = await started(3);
      for (let i = 0; i < 6; i += 1) await store.append(run.id, { type: 'assistant', data: i });
      const handle = await openExisting(store, run.id, null);
      expect(handle.reset?.resumedAfter).toBe('3');
      const seen = await take(handle.events, 3);
      expect(seen.map((event) => event.id)).toEqual([4n, 5n, 6n]);
      handle.close();
    });

    it('announces a reset for a cursor ahead of anything the run produced', async () => {
      const { store, run } = await started();
      await store.append(run.id, { type: 'assistant', data: 'a' });
      const handle = await openExisting(store, run.id, 99n);
      // Not an empty stream that waits forever for event 100: the cursor is wrong and says so.
      expect(handle.reset?.reason).toContain('no event after 99');
      const seen = await take(handle.events, 1);
      expect(seen.map((e) => e.id)).toEqual([1n]);
      handle.close();
    });

    it('does not announce a reset when the cursor is simply the newest event', async () => {
      const { store, run } = await started();
      await store.append(run.id, { type: 'assistant', data: 'a' });
      const handle = await openExisting(store, run.id, 1n);
      expect(handle.reset).toBeNull();
      handle.close();
    });
  });
}

function describeSubscribers({ started }: ConformanceHarness): void {
  describe('openStream', () => {
    it('serves two concurrent subscribers from different cursors', async () => {
      const { store, run } = await started();
      await store.append(run.id, { type: 'assistant', data: 'a' });
      const fromStart = await store.openStream(run.id, null);
      const fromOne = await store.openStream(run.id, 1n);
      if (fromStart === null || fromOne === null) throw new Error('no handle');
      const a = take(fromStart.events, 2);
      const b = take(fromOne.events, 1);
      await store.append(run.id, { type: 'assistant', data: 'b' });
      expect((await a).map((e) => e.id)).toEqual([1n, 2n]);
      expect((await b).map((e) => e.id)).toEqual([2n]);
      fromStart.close();
      fromOne.close();
    });
  });
}

function describeListLimits({ make }: ConformanceHarness): void {
  describe('listRuns', () => {
    /**
     * A `limit` neither implementation will serve is refused by both, with the same message,
     * before anything is read (round 4 finding 3). This assertion used to run against the
     * repository alone, which is how `InMemoryRunStore` came to resolve `limit: 201` as an
     * ordinary page — no HTTP caller could reach it, `api.ts` answering `400 invalid_limit`
     * first, but a direct port caller could, and "one suite, two implementations" is this
     * port's stated contract. The fixture's workspace holds no run of its own, so `200` is
     * answered with an empty page rather than refused.
     */
    it('refuses limit 0, 1.5 and 201 by name and serves exactly 200', async () => {
      const fixture = await make({});
      const { workspaceId } = fixture.nextRun();
      const listRuns = fixture.store.listRuns.bind(fixture.store);
      await expect(listRuns(workspaceId, { limit: 0 })).rejects.toThrow(
        'listRuns limit must be a safe positive integer',
      );
      await expect(listRuns(workspaceId, { limit: 1.5 })).rejects.toThrow(
        'listRuns limit must be a safe positive integer',
      );
      await expect(listRuns(workspaceId, { limit: 201 })).rejects.toThrow(
        'listRuns limit must not exceed 200',
      );
      await expect(listRuns(workspaceId, { limit: 200 })).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });
}
