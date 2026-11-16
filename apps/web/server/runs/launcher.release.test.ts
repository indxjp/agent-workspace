import { bytesToStream } from '@agent-workspace/runtime/transfer';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import {
  buildRunRequest,
  context,
  emptyWorkspace,
  newRun,
  RUN,
  RUN_DONE,
  RUN_REQUEST_FIXTURE,
  runtimeOf,
  settle,
  silenceErrorLog,
  sse,
  sseStream,
  urlOf,
  type LauncherOptions,
} from './launcher.test-support';

const EXTERNAL = runtimeOf({
  runtimeProfileId: 'profile-e2b',
  driver: 'external',
  runnerUrl: 'http://manager:8080/runtimes/sealed-1',
});

/** One launch against an `external` target; `releases` records the run and its status at each release. */
async function launchWith(options: Partial<LauncherOptions> & { fetch: typeof globalThis.fetch }) {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const releases: { runId: string; statusSeen: string | undefined }[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: EXTERNAL,
    buildRunRequest,
    releaseRunSandboxes: async (launched) => {
      releases.push({ runId: launched.run.id, statusSeen: (await store.get(RUN))?.status });
    },
    ...options,
  });
  launch(context(run));
  const settled = await settle(store);
  return { store, settled, releases };
}

/** An `external` launch that records the status the store held at each release. */
async function startExternal(
  options: Partial<LauncherOptions> & { fetch: typeof globalThis.fetch },
  store = new InMemoryRunStore(),
) {
  const run = await newRun(store);
  const releases: (string | undefined)[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: EXTERNAL,
    buildRunRequest,
    releaseRunSandboxes: async () => {
      releases.push((await store.get(RUN))?.status);
    },
    ...options,
  });
  launch(context(run));
  return { store, releases };
}

async function releasesOnceBeforeTheTerminalStatus() {
  const { settled, releases } = await launchWith({
    fetch: () => Promise.resolve(sse(RUN_DONE)),
  });
  expect(settled.status).toBe('completed');
  expect(releases).toEqual([{ runId: RUN, statusSeen: 'running' }]);
}

// The session's runtime refuses a second run while its first is in flight. The release names
// only the refused run, and the manager ends only the sandboxes that run started: none, since it
// reused the first run's (apps/runner/src/tool-sandbox.test.ts holds the manager's side).
async function releasesOnlyTheRefusedRun() {
  const log = silenceErrorLog();
  const { settled, releases } = await launchWith({
    fetch: () =>
      Promise.resolve(
        Response.json(
          { error: 'session_in_flight', message: 'a run of this session is in flight' },
          { status: 409 },
        ),
      ),
  });
  expect(settled.status).toBe('failed');
  expect(releases).toEqual([{ runId: RUN, statusSeen: 'running' }]);
  log.mockRestore();
}

async function releasesOnceWhenACaseReachesItsDeadlineWhileStreaming() {
  let endStream: (() => void) | undefined;
  const { store, releases } = await startExternal({
    fetch: () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          endStream = () => {
            controller.enqueue(
              new TextEncoder().encode('event: run-interrupted\ndata: {"interrupted":true}\n\n'),
            );
            controller.close();
          };
        },
      });
      return Promise.resolve(sseStream(body));
    },
  });
  await vi.waitFor(() => expect(endStream).toBeDefined());
  // The case deadline stops the run as `stopAbandonedRun` does: the interrupt route writes
  // `cancelled`, and the runtime then ends the stream it was serving.
  await store.finish(RUN, 'cancelled', 'deadline_exceeded');
  endStream?.();
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  const settled = await settle(store);
  expect(settled.status).toBe('cancelled');
  expect(settled.error).toBe('deadline_exceeded');
}

async function releasesWhenTheRuntimeReportsAFailure() {
  const { settled, releases } = await launchWith({
    fetch: () => Promise.resolve(sse('event: run-failed\ndata: {"error":"boom"}\n\n')),
  });
  expect(settled.status).toBe('failed');
  expect(releases).toHaveLength(1);
}

async function releasesWhenTheRuntimeReportsAnInterruptAfterTheRouteConcluded() {
  const store = new InMemoryRunStore();
  const { releases } = await startExternal(
    {
      // An evaluation case's deadline interrupts through the same route: it writes `cancelled`
      // first, and the runner then ends the stream.
      fetch: async () => {
        await store.finish(RUN, 'cancelled', 'the case reached its deadline');
        return sse('event: run-interrupted\ndata: {"interrupted":true}\n\n');
      },
    },
    store,
  );
  const settled = await settle(store);
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  expect(settled.status).toBe('cancelled');
  expect(settled.error).toBe('the case reached its deadline');
}

async function releasesWhenTheRunReachesItsDeadline() {
  const { settled, releases } = await launchWith({
    connectTimeoutMs: 1_000,
    maxRunDurationMs: 25,
    fetch: (input, init) => {
      if (urlOf(input).endsWith('/interrupt')) {
        return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('lifetime abort')));
      });
    },
  });
  expect(settled.status).toBe('failed');
  expect(releases).toHaveLength(1);
}

async function releasesWhenTheRuntimeCannotBeReached() {
  const log = silenceErrorLog();
  const { settled, releases } = await launchWith({
    fetch: () => Promise.reject(new Error('connect ECONNREFUSED')),
  });
  expect(settled.status).toBe('failed');
  expect(releases).toHaveLength(1);
  log.mockRestore();
}

async function releasesWhenTheWorkspaceCannotBeHydrated() {
  const log = silenceErrorLog();
  const { settled, releases } = await launchWith({
    workspaceLifecycle: emptyWorkspace({
      inputArchive: () => Promise.resolve(bytesToStream(new Uint8Array([1]))),
    }),
    fetch: () => Promise.resolve(Response.json({ error: 'invalid_archive' }, { status: 400 })),
  });
  expect(settled.error).toContain('The workspace could not be prepared.');
  expect(releases).toHaveLength(1);
  log.mockRestore();
}

async function releasesWhenTheRunRequestCannotBeBuilt() {
  const log = silenceErrorLog();
  const { settled, releases } = await launchWith({
    buildRunRequest: () => {
      throw new Error('compose failed');
    },
    fetch: () => Promise.resolve(sse(RUN_DONE)),
  });
  expect(settled.status).toBe('failed');
  expect(releases).toHaveLength(1);
  log.mockRestore();
}

async function releasesWhenAnInterruptLandedBeforeTheRuntime() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const releases: string[] = [];
  const posted: string[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: EXTERNAL,
    buildRunRequest: async () => {
      await store.finish(RUN, 'cancelled', 'the run was interrupted by request');
      return RUN_REQUEST_FIXTURE;
    },
    releaseRunSandboxes: (_context, target) => {
      releases.push(target.runnerUrl);
      return Promise.resolve();
    },
    fetch: (input) => {
      posted.push(urlOf(input));
      return Promise.resolve(sse(RUN_DONE));
    },
  });
  launch(context(run));
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  expect(posted).toEqual([]);
}

async function stillConcludesTheRunWhenTheReleaseFails() {
  const log = silenceErrorLog();
  const { settled } = await launchWith({
    releaseRunSandboxes: () =>
      Promise.reject(new Error('runner manager answered HTTP 500 e2b_SECRET')),
    fetch: () => Promise.resolve(sse(RUN_DONE)),
  });
  expect(settled.status).toBe('completed');
  expect(settled.error ?? '').not.toContain('e2b_SECRET');
  log.mockRestore();
}

async function releasesNothingWithoutARuntimeTarget() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const releaseRunSandboxes = vi.fn<() => Promise<void>>(() => Promise.resolve());
  createRunnerLauncher({
    baseUrl: 'http://runner:8080',
    store,
    buildRunRequest,
    releaseRunSandboxes,
    fetch: () => Promise.resolve(sse(RUN_DONE)),
  })(context(run));
  expect((await settle(store)).status).toBe('completed');
  expect(releaseRunSandboxes).not.toHaveBeenCalled();
}

describe('createRunnerLauncher releases the run sandboxes (issue #832)', () => {
  it(
    'releases once, before the terminal status is written, when the run completes',
    releasesOnceBeforeTheTerminalStatus,
  );
  it(
    'releases only the refused run itself when the runtime answers 409 session_in_flight',
    releasesOnlyTheRefusedRun,
  );
  it(
    'releases once when an evaluation case reaches its deadline while the run streams',
    releasesOnceWhenACaseReachesItsDeadlineWhileStreaming,
  );
  it('releases when the runtime reports a failure', releasesWhenTheRuntimeReportsAFailure);
  it(
    'releases when the runtime reports an interrupt, even after the interrupt route concluded the run',
    releasesWhenTheRuntimeReportsAnInterruptAfterTheRouteConcluded,
  );
  it('releases when the run reaches its deadline', releasesWhenTheRunReachesItsDeadline);
  it('releases when the runtime cannot be reached', releasesWhenTheRuntimeCannotBeReached);
  it('releases when the workspace cannot be hydrated', releasesWhenTheWorkspaceCannotBeHydrated);
  it(
    'releases when the run request cannot be built, once the target is known',
    releasesWhenTheRunRequestCannotBeBuilt,
  );
  it(
    'releases when an interrupt landed before the run reached the runtime',
    releasesWhenAnInterruptLandedBeforeTheRuntime,
  );
  it(
    'still concludes the run, and keeps the failure off it, when the release fails',
    stillConcludesTheRunWhenTheReleaseFails,
  );
  it('releases nothing for a launch with no runtime target', releasesNothingWithoutARuntimeTarget);
});
