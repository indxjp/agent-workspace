import { parseRunFailure } from '@indx-workspace/contracts/runs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import {
  buildRunRequest,
  context,
  newRun,
  RUN,
  RUN_DONE,
  runtimeTarget,
  type RuntimeTarget,
  settle,
  silenceErrorLog,
  sse,
  transcript,
  urlOf,
} from './launcher.test-support';

// Issue #830 (ADR-0120 LC7): on Vercel Functions the launch is kept alive by `after()` and a run
// cannot outlive the function.
const HOST_LIMIT_MS = 285_000;
const CONTAINER_LIMIT_MS = 885_000;
const SDK_FRAMES =
  'event: sdk-message\ndata: {"n":1}\n\nevent: sdk-message\ndata: {"n":2}\n\n' + RUN_DONE;

/** The docker target, with the profile's own deadline when it has one. */
const target = (timeoutSeconds?: number): RuntimeTarget =>
  runtimeTarget({
    persistPaths: [],
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  });

/** A runtime that never answers `/run` until aborted, and acknowledges `/interrupt`. */
function stalledRuntime(onInterrupt: () => void): typeof globalThis.fetch {
  return (input, init) => {
    if (urlOf(input).endsWith('/interrupt')) {
      onInterrupt();
      return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
    }
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('lifetime abort')));
    });
  };
}

async function expectRefusedBeforeTheRuntime(
  options: Partial<Parameters<typeof createRunnerLauncher>[0]>,
) {
  const log = silenceErrorLog();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const fetchSpy = vi.fn(() => Promise.resolve(sse(RUN_DONE)));
  createRunnerLauncher({ store, buildRunRequest, fetch: fetchSpy, ...options })(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('failed');
  expect(parseRunFailure(settled.error ?? '')?.code).toBe('run_deadline_exceeds_host');
  expect(fetchSpy).not.toHaveBeenCalled();
  log.mockRestore();
}

/** Launches with a `Date`-only fake clock and returns the failure the host or credential limit gave. */
async function lifetimeFailure(
  options: Partial<Parameters<typeof createRunnerLauncher>[0]>,
  preparationMs = 0,
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  let interrupts = 0;
  createRunnerLauncher({
    store,
    runtime: {
      resolve: () => {
        vi.setSystemTime(Date.now() + preparationMs);
        return Promise.resolve(target());
      },
    },
    buildRunRequest,
    connectTimeoutMs: 1_000,
    fetch: stalledRuntime(() => {
      interrupts += 1;
    }),
    ...options,
  })(context(run));
  return { settled: await settle(store), interrupts: () => interrupts };
}

async function handsTheLaunchToKeepAlive() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const kept: Promise<void>[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: { resolve: () => Promise.resolve(target(HOST_LIMIT_MS / 1_000)) },
    buildRunRequest,
    hostMaxRunDurationMs: HOST_LIMIT_MS,
    keepAlive: (work) => {
      kept.push(work);
    },
    fetch: () => Promise.resolve(sse(SDK_FRAMES)),
  });

  launch(context(run));
  // Called once, before `launch` returned: the request that started the run is not what carries it.
  expect(kept).toHaveLength(1);
  expect((await store.get(RUN))?.status).toBe('queued');

  await kept[0];
  const finished = await store.get(RUN);
  expect(finished?.status).toBe('completed');
  expect(finished?.endedAt).not.toBeNull();
  const types = (await transcript(store)).map((event) => event.type);
  expect(types.filter((type) => type === 'sdk-message')).toHaveLength(2);
}

function refusesADeadlineLongerThanTheHost() {
  return expectRefusedBeforeTheRuntime({
    runtime: { resolve: () => Promise.resolve(target(600)) },
    hostMaxRunDurationMs: HOST_LIMIT_MS,
  });
}

async function cloudflareFinishesWithoutKeepAlive() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const launch = createRunnerLauncher({
    store,
    runtime: { resolve: () => Promise.resolve(target(CONTAINER_LIMIT_MS / 1_000)) },
    buildRunRequest,
    hostMaxRunDurationMs: CONTAINER_LIMIT_MS,
    fetch: () => Promise.resolve(sse(`event: sdk-message\ndata: {"n":1}\n\n${RUN_DONE}`)),
  });

  launch(context(run));
  expect((await store.get(RUN))?.status).toBe('queued');

  expect((await settle(store)).status).toBe('completed');
  const types = (await transcript(store)).map((event) => event.type);
  expect(types).toContain('sdk-message');
}

function cloudflareRefuses886Seconds() {
  return expectRefusedBeforeTheRuntime({
    runtime: { resolve: () => Promise.resolve(target(886)) },
    hostMaxRunDurationMs: CONTAINER_LIMIT_MS,
  });
}

// Issue #831 (ADR-0127): a Cloudflare Container is a long-lived server. Its limit is the idle stop
// less the margin, and it has no `keepAlive`: the launch outlives the request in its process.
function cloudflareContainerTests(): void {
  describe('on a Cloudflare Container (issue #831)', () => {
    it(
      'finishes a run with no keepAlive, after the starting request has returned',
      cloudflareFinishesWithoutKeepAlive,
    );
    it(
      'refuses a profile deadline of 886 s before the runtime is contacted',
      cloudflareRefuses886Seconds,
    );
  });
}

async function cutsOffARunWithNoDeadlineAtTheHostLimit() {
  const { settled, interrupts } = await lifetimeFailure({ hostMaxRunDurationMs: 25 });
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe(
    "The run exceeded its host-limited lifetime of 25ms (the host's function limit ended it).",
  );
  expect(interrupts()).toBe(1);
}

async function countsTheHostLimitFromTheLaunch() {
  // A preparation that took 150ms of the host's 200ms.
  const { settled, interrupts } = await lifetimeFailure({ hostMaxRunDurationMs: 200 }, 150);
  expect(settled.status).toBe('failed');
  // What was left of the 200ms after a 150ms preparation, not a fresh 200ms.
  expect(settled.error).toBe(
    "The run exceeded its host-limited lifetime of 50ms (the host's function limit ended it).",
  );
  expect(interrupts()).toBe(1);
}

async function refusesWhenPreparationUsedTheWholeBudget() {
  vi.useFakeTimers({ toFake: ['Date'] });
  await expectRefusedBeforeTheRuntime({
    runtime: {
      resolve: () => {
        vi.setSystemTime(Date.now() + 200);
        return Promise.resolve(target());
      },
    },
    hostMaxRunDurationMs: 200,
  });
}

async function namesTheCredentialBoundWhenItIsShorter() {
  const { settled } = await lifetimeFailure({
    maxRunDurationMs: 25,
    hostMaxRunDurationMs: HOST_LIMIT_MS,
  });
  expect(settled.error).toBe('The run exceeded its credential-bounded lifetime of 25ms.');
}

describe('createRunnerLauncher on a host with a function limit (issue #830)', () => {
  // The host budget is measured with `Date.now()`; only `Date` is faked, so the elapsed time is
  // exactly what a test sets while the lifetime timers still run for real.
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'hands the whole launch to keepAlive, and the run finishes with its events stored',
    handsTheLaunchToKeepAlive,
  );
  it(
    'refuses a profile deadline longer than the host allows, before the runtime is contacted',
    refusesADeadlineLongerThanTheHost,
  );
  cloudflareContainerTests();
  it(
    'cuts off a run with no deadline at the host limit and interrupts the runtime',
    cutsOffARunWithNoDeadlineAtTheHostLimit,
  );
  it(
    'counts the host limit from the launch, so a slow preparation shortens the run',
    countsTheHostLimitFromTheLaunch,
  );
  it(
    'refuses a run whose preparation used the whole host budget, before the runtime is contacted',
    refusesWhenPreparationUsedTheWholeBudget,
  );
  it(
    'names the credential bound, not the host, when the credential lifetime is the shorter one',
    namesTheCredentialBoundWhenItIsShorter,
  );
});
