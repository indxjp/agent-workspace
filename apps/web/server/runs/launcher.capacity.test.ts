import { parseRunFailure, RUNTIME_CAPACITY_EXHAUSTED } from '@indx-workspace/contracts/runs';
import { describe, expect, it, vi } from 'vitest';

import { resetLiveRuns } from './interrupt';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import {
  buildRunRequest,
  context,
  emptyWorkspace,
  expectNoLiveRunEntry,
  latch,
  newRun,
  RUN,
  RUN_DONE,
  RUN_REQUEST_FIXTURE,
  runtimeOf,
  settle,
  silenceErrorLog,
  sse,
  transcript,
  urlOf,
} from './launcher.test-support';
import type { RunRecord } from './store';

// Issue #557: concurrent widget conversations failed outright when the local runner answered
// `429 runner_capacity_exhausted`. The launcher now waits, bounded, for a free slot.
const CAPACITY_BODY = {
  error: 'runner_capacity_exhausted',
  message: 'the runner is already serving 8 runs; retry when capacity is available.',
};
const FAST = { initialDelayMs: 1, maxDelayMs: 5, maxWaitMs: 10_000 } as const;
const BASE = 'http://runner:8080';
const INTERRUPTED = 'the run was interrupted by request';

function capacity429(headers?: Record<string, string>): Response {
  return Response.json(CAPACITY_BODY, { status: 429, ...(headers ? { headers } : {}) });
}

/** A token-revocation counter plus a latch that opens when the launch is over. */
function launchWatch() {
  const settledLaunch = latch();
  const watch = {
    revoked: 0,
    settledLaunch: settledLaunch.reached,
    options: {
      revokeRunTokens: () => {
        watch.revoked += 1;
        return Promise.resolve();
      },
      onLaunchSettled: () => settledLaunch.notify(),
    },
  };
  return watch;
}

async function repostsTheSameRequestAfterCapacityRefusals() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const posted: unknown[] = [];
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    capacityRetry: FAST,
    fetch: (input, init) => {
      expect(urlOf(input)).toBe('http://runner:8080/run');
      posted.push(init?.body);
      return Promise.resolve(
        posted.length <= 2
          ? capacity429()
          : sse(`event: assistant\ndata: {"text":"hi"}\n\n${RUN_DONE}`),
      );
    },
  });
  launch(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('completed');
  expect(settled.error).toBeNull();
  expect(posted).toHaveLength(3);
  expect(new Set(posted)).toEqual(new Set([JSON.stringify(RUN_REQUEST_FIXTURE)]));
  expect((await transcript(store)).map((event) => event.type)).toContain('assistant');
}

async function failsWithTheRetryableCapacityErrorWhenTheBudgetIsSpent() {
  const log = silenceErrorLog();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const calls: string[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf({ persistPaths: ['output'] }),
    buildRunRequest,
    workspaceLifecycle: emptyWorkspace(),
    capacityRetry: { initialDelayMs: 1, maxDelayMs: 5, maxWaitMs: 30 },
    fetch: (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${urlOf(input)}`);
      return Promise.resolve(capacity429());
    },
  });
  launch(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('failed');
  expect(parseRunFailure(settled.error)).toEqual({
    code: RUNTIME_CAPACITY_EXHAUSTED,
    message:
      'The runtime is serving its maximum number of concurrent runs; send the message again in a moment.',
  });
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.every((call) => call === 'POST http://runtime:8080/run')).toBe(true);
  expect(log).toHaveBeenCalledWith('[runs] await-runtime-capacity failed', expect.anything());
  log.mockRestore();
}

async function doesNotHideARealError(_name: string, answer: () => Response) {
  const log = silenceErrorLog();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  let posts = 0;
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    capacityRetry: FAST,
    fetch: () => {
      posts += 1;
      return Promise.resolve(answer());
    },
  });
  launch(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe('The runtime reported a run failure.');
  expect(parseRunFailure(settled.error)?.code).toBeNull();
  expect(posts).toBe(1);
  log.mockRestore();
}

async function stopsWaitingWhenAnInterruptLandsDuringTheWait() {
  resetLiveRuns();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  let posts = 0;
  const watch = launchWatch();
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    capacityRetry: FAST,
    ...watch.options,
    fetch: async (input) => {
      if (urlOf(input).endsWith('/run')) {
        posts += 1;
        // The interrupt route makes the run terminal while the runtime is still full.
        await store.finish(RUN, 'cancelled', INTERRUPTED);
        return capacity429();
      }
      return Response.json({}, { status: 409 });
    },
  });
  launch(context(run));
  await watch.settledLaunch;
  expect(posts).toBe(1);
  expect(watch.revoked).toBe(1);
  const settled = await settle(store);
  expect(settled.status).toBe('cancelled');
  expect(settled.error).toBe(INTERRUPTED);
  await expectNoLiveRunEntry();
}

async function failsWithTheLifetimeMessageWhenTheLifetimeRunsOut() {
  const log = silenceErrorLog();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  let interrupts = 0;
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    maxRunDurationMs: 25,
    capacityRetry: FAST,
    fetch: (input) => {
      if (urlOf(input).endsWith('/interrupt')) {
        interrupts += 1;
        return Promise.resolve(Response.json({}, { status: 409 }));
      }
      return Promise.resolve(capacity429());
    },
  });
  launch(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe('The run exceeded its credential-bounded lifetime of 25ms.');
  expect(interrupts).toBe(1);
  log.mockRestore();
}

async function honoursARetryAfterClampedToTheLargestWait() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const postedAt: number[] = [];
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    // Without Retry-After the first wait would be at most 1ms; with `Retry-After: 60` unclamped
    // it would be a minute. Clamped, it is exactly `maxDelayMs`.
    capacityRetry: { initialDelayMs: 1, maxDelayMs: 40, maxWaitMs: 10_000 },
    fetch: () => {
      postedAt.push(performance.now());
      return Promise.resolve(
        postedAt.length === 1 ? capacity429({ 'Retry-After': '60' }) : sse(RUN_DONE),
      );
    },
  });
  launch(context(run));
  expect((await settle(store)).status).toBe('completed');
  expect(postedAt).toHaveLength(2);
  const [first = 0, second = 0] = postedAt;
  expect(second - first).toBeGreaterThanOrEqual(35);
  expect(second - first).toBeLessThan(1_000);
}

async function keepsTheBackoffWhenRetryAfterIsZero() {
  const log = silenceErrorLog();
  // Pin the jitter to its ceiling so the backoff is deterministic: 40, 80, 100, 100, … ms.
  const random = vi.spyOn(Math, 'random').mockReturnValue(1);
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const postedAt: number[] = [];
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    capacityRetry: { initialDelayMs: 40, maxDelayMs: 100, maxWaitMs: 400 },
    fetch: () => {
      postedAt.push(performance.now());
      return Promise.resolve(capacity429({ 'Retry-After': '0' }));
    },
  });
  launch(context(run));
  const settled = await settle(store);
  random.mockRestore();
  log.mockRestore();
  expect(parseRunFailure(settled.error)?.code).toBe(RUNTIME_CAPACITY_EXHAUSTED);
  // Backoff over a 400ms budget is a handful of POSTs; a zero delay would be hundreds.
  expect(postedAt.length).toBeGreaterThan(1);
  expect(postedAt.length).toBeLessThanOrEqual(8);
  const [first = 0, second = 0] = postedAt;
  expect(second - first).toBeGreaterThanOrEqual(35);
}

/** A store whose next `get` after `failNextGet()` rejects, like a database blip. */
class FlakyStore extends InMemoryRunStore {
  private failing = false;

  failNextGet(): void {
    this.failing = true;
  }

  override get(runId: string): Promise<RunRecord | null> {
    if (!this.failing) return super.get(runId);
    this.failing = false;
    return Promise.reject(new Error('the run store is unavailable'));
  }
}

async function failsTheRunWhenTheStoreCannotBeReadDuringTheWait() {
  const log = silenceErrorLog();
  const store = new FlakyStore();
  const run = await newRun(store);
  let posts = 0;
  const watch = launchWatch();
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    capacityRetry: FAST,
    ...watch.options,
    fetch: () => {
      posts += 1;
      // The next store read is the launcher's own "is the run still running?" after the wait.
      store.failNextGet();
      return Promise.resolve(capacity429());
    },
  });
  launch(context(run));
  await watch.settledLaunch;
  const settled = await store.get(RUN);
  expect(settled?.status).toBe('failed');
  expect(settled?.endedAt).not.toBeNull();
  expect(settled?.error).toBe(
    'The run status could not be read while it waited for runtime capacity.',
  );
  expect(posts).toBe(1);
  expect(watch.revoked).toBe(1);
  expect(log).toHaveBeenCalledWith('[runs] read-run-status failed', expect.anything());
  log.mockRestore();
}

const NOT_CAPACITY_ANSWERS: [string, () => Response][] = [
  ['a 429 with another body', () => Response.json({ error: 'rate_limited' }, { status: 429 })],
  [
    'a capacity body with an unexpected key',
    () => Response.json({ ...CAPACITY_BODY, extra: true }, { status: 429 }),
  ],
  ['an HTML 429 from a proxy', () => new Response('<html>Too Many</html>', { status: 429 })],
  ['a 503', () => Response.json(CAPACITY_BODY, { status: 503 })],
];

describe('createRunnerLauncher runtime capacity wait (issue #557)', () => {
  it(
    're-posts the same request after capacity refusals and relays the stream that follows',
    repostsTheSameRequestAfterCapacityRefusals,
  );
  it(
    'fails with the coded, retryable capacity error once the wait budget is spent, and collects nothing',
    failsWithTheRetryableCapacityErrorWhenTheBudgetIsSpent,
  );
  it.each(NOT_CAPACITY_ANSWERS)(
    'does not hide a real error: %s fails after one POST, as before',
    doesNotHideARealError,
  );
  it(
    'stops waiting, posts nothing more and revokes the run tokens when an interrupt lands during the wait',
    stopsWaitingWhenAnInterruptLandsDuringTheWait,
  );
  it(
    'fails with the credential-lifetime message when the lifetime runs out during the wait',
    failsWithTheLifetimeMessageWhenTheLifetimeRunsOut,
  );
  it(
    'honours a Retry-After, clamped to the largest single wait',
    honoursARetryAfterClampedToTheLargestWait,
  );
  it(
    'keeps the backoff when the runtime sends Retry-After: 0, so a full runtime is not hammered',
    keepsTheBackoffWhenRetryAfterIsZero,
  );
  it(
    'fails the run, revokes its tokens and posts nothing more when the store cannot be read during the wait',
    failsTheRunWhenTheStoreCannotBeReadDuringTheWait,
  );
});
