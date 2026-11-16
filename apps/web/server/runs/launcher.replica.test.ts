import { afterEach, describe, expect, it } from 'vitest';

import { resetLiveRuns, signalLiveRun } from './interrupt';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import {
  buildRunRequest,
  context,
  expectNoLiveRunEntry,
  latch,
  newRun,
  RUN,
  RUN_DONE,
  runtimeOf,
  SESSION,
  silenceErrorLog,
  sse,
  sseStream,
  urlOf,
} from './launcher.test-support';

const WATCH_MS = 20;
const INTERRUPTED = 'the run was interrupted by request';

/** An idle SSE stream, as a runtime blocked in a long tool call holds it: it ends only on abort. */
function idleStream(signal: AbortSignal | null | undefined): Response {
  return sseStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }),
  );
}

async function stopsTheRuntimeWhenAnotherReplicaInterrupts() {
  resetLiveRuns();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  // The run's `run_tokens` rows; the interrupt revokes every one of them.
  const tokens = [{ id: 'token-1', runId: RUN, revoked: false }];
  const interrupts: unknown[] = [];
  let relayAborted = false;
  const opened = latch();
  const settledLaunch = latch();
  const finished: string[] = [];
  const log = silenceErrorLog();

  const launch = createRunnerLauncher({
    baseUrl: 'http://runner:8080',
    store,
    buildRunRequest,
    cancellationWatchIntervalMs: WATCH_MS,
    fetch: (input, init) => {
      if (urlOf(input) === 'http://runner:8080/interrupt') {
        interrupts.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
        return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
      }
      init?.signal?.addEventListener('abort', () => {
        relayAborted = true;
      });
      opened.notify();
      return Promise.resolve(idleStream(init?.signal));
    },
    onRunFinished: (measurement) => finished.push(measurement.status),
    onLaunchSettled: () => settledLaunch.notify(),
  });
  launch(context(run));
  await opened.reached;

  // What a replica that does not hold the stream does (`interruptRun` in run-api.ts): the
  // terminal status, which revokes in the same commit, then the token revocation. Its
  // `signalLiveRun` finds no registry entry there, so none is made here.
  await store.finish(RUN, 'cancelled', INTERRUPTED, true);
  for (const token of tokens) token.revoked = true;
  // The invariant: by the time that caller is answered, no credential of the run is live.
  expect(tokens.every((token) => token.revoked)).toBe(true);

  await settledLaunch.reached;
  expect(interrupts).toEqual([{ runId: RUN }]);
  expect(relayAborted).toBe(true);
  const settled = await store.get(RUN);
  expect(settled?.status).toBe('cancelled');
  expect(settled?.error).toBe(INTERRUPTED);
  // `cancelled`, not a lifetime or relay failure, and once.
  expect(finished).toEqual(['cancelled']);
  // The live-run entry was released: a later signal for the run reaches nothing.
  await expectNoLiveRunEntry();
  log.mockRestore();
}

async function makesNoSecondSignalOnTheHoldingReplica() {
  resetLiveRuns();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const interrupts: string[] = [];
  let closeStream: () => void = () => undefined;
  const opened = latch();
  const settledLaunch = latch();
  const record: typeof globalThis.fetch = (input) => {
    const url = urlOf(input);
    if (url.endsWith('/interrupt')) {
      interrupts.push(url);
      return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStream = () => {
          controller.enqueue(
            new TextEncoder().encode('event: run-interrupted\ndata: {"interrupted":true}\n\n'),
          );
          controller.close();
        };
      },
    });
    opened.notify();
    return Promise.resolve(sseStream(body));
  };
  const launch = createRunnerLauncher({
    baseUrl: 'http://runner:8080',
    store,
    buildRunRequest,
    cancellationWatchIntervalMs: WATCH_MS,
    fetch: record,
    onLaunchSettled: () => settledLaunch.notify(),
  });
  launch(context(run));
  await opened.reached;

  // The interrupt on this replica: the terminal status, then the registry signal.
  await store.finish(RUN, 'cancelled', INTERRUPTED, true);
  await signalLiveRun(RUN, record);
  expect(interrupts).toHaveLength(1);
  // Let the watch read the stopped status several times before the runner ends the stream.
  await new Promise((resolve) => setTimeout(resolve, WATCH_MS * 5));
  closeStream();
  await settledLaunch.reached;

  expect(interrupts).toHaveLength(1);
  expect((await store.get(RUN))?.status).toBe('cancelled');
}

async function abortsTheStorageWritebackOfAStoppedRun() {
  resetLiveRuns();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const interrupts: string[] = [];
  let writebackAborted = false;
  const settledLaunch = latch();
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf(),
    buildRunRequest: () => ({ runId: RUN, cwd: `/workspace/ws/${SESSION}` }),
    cancellationWatchIntervalMs: WATCH_MS,
    fetch: (input) => {
      const url = urlOf(input);
      if (!url.endsWith('/interrupt')) return Promise.resolve(sse(RUN_DONE));
      interrupts.push(url);
      return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
    },
    // A save to a hung store: it ends only when its signal aborts. Another replica's interrupt
    // lands while it waits.
    storageWriteback: async ({ signal }) => {
      await store.finish(RUN, 'cancelled', INTERRUPTED, true);
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            writebackAborted = true;
            resolve();
          },
          { once: true },
        );
      });
    },
    onLaunchSettled: () => settledLaunch.notify(),
  });
  launch(context(run));
  await settledLaunch.reached;

  expect(writebackAborted).toBe(true);
  expect(interrupts).toEqual(['http://runtime:8080/interrupt']);
  expect((await store.get(RUN))?.status).toBe('cancelled');
}

describe('createRunnerLauncher stops a run stopped by another replica (ADR-0151-FU-1440 D1, issue #261)', () => {
  afterEach(() => {
    resetLiveRuns();
  });

  it(
    'an interrupt served by a replica that does not hold the stream stops the runtime',
    stopsTheRuntimeWhenAnotherReplicaInterrupts,
  );
  it(
    'makes no second runtime signal when the interrupt was served on the holding replica',
    makesNoSecondSignalOnTheHoldingReplica,
  );
  it(
    'aborts the storage write-back of a run another replica stops while it is saved',
    abortsTheStorageWritebackOfAStoppedRun,
  );
});
