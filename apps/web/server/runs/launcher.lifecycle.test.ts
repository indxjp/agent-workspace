import { describe, expect, it } from 'vitest';

import { resetLiveRuns, signalLiveRun } from './interrupt';
import { createRunnerLauncher, RUN_STATUS_EVENT } from './launcher';
import { InMemoryRunStore } from './memory-store';
import {
  buildRunRequest,
  context,
  expectNoLiveRunEntry,
  latch,
  newRun,
  RUN,
  RUN_DONE,
  RUN_REQUEST_FIXTURE,
  settle,
  silenceErrorLog,
  sse,
  sseStream,
  transcript,
  urlOf,
} from './launcher.test-support';

const BASE = 'http://runner:8080';
const INTERRUPTED = 'the run was interrupted by request';

/** A fetch that never answers on its own and rejects once the launcher aborts it. */
const hangingFetch =
  (onInterrupt: () => void): typeof globalThis.fetch =>
  (input, init) => {
    if (urlOf(input).endsWith('/interrupt')) {
      onInterrupt();
      return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
    }
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('lifetime abort')));
    });
  };

async function registersTheRunWhileItHoldsTheConnection() {
  resetLiveRuns();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const encoder = new TextEncoder();
  let closeStream: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStream = () => {
        controller.enqueue(encoder.encode(RUN_DONE));
        controller.close();
      };
    },
  });
  createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    fetch: () => Promise.resolve(sseStream(body)),
  })(context(run));

  // While the stream is still open, this process is holding the run: a signal reaches the
  // registered base URL.
  let signalledUrl: string | null = null;
  for (let i = 0; i < 200 && signalledUrl === null; i += 1) {
    await signalLiveRun(RUN, (input) => {
      signalledUrl = urlOf(input);
      return Promise.resolve(Response.json({}, { status: 202 }));
    });
    if (signalledUrl === null) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(signalledUrl).toBe('http://runner:8080/interrupt');

  closeStream?.();
  await settle(store);

  // Settled: the registry entry is released, so a later signal for this run id does nothing.
  await expectNoLiveRunEntry();
}

async function failsWhenRuntimeDoesNotAnswerInTime() {
  const log = silenceErrorLog();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    connectTimeoutMs: 20,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted by the connect deadline'));
        });
      }),
  });
  launch(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe('The runtime could not be reached.');
  expect(settled.error).not.toContain('aborted by the connect deadline');
  expect(log).toHaveBeenCalled();
  log.mockRestore();
}

async function interruptsBeforeTheGatewayCredentialExpires() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  let interrupts = 0;
  let interruptBody: unknown;
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    connectTimeoutMs: 1_000,
    maxRunDurationMs: 25,
    fetch: (input, init) => {
      if (!urlOf(input).endsWith('/interrupt')) return hangingFetch(() => undefined)(input, init);
      interrupts += 1;
      if (typeof init?.body !== 'string') throw new Error('expected a JSON interrupt body');
      interruptBody = JSON.parse(init.body);
      return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
    },
  });

  launch(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('failed');
  expect(settled.error).toContain('credential-bounded lifetime');
  expect(interrupts).toBe(1);
  expect(interruptBody).toEqual({ runId: run.id });
}

async function postsNothingWhenTheRequestCannotBeBuilt() {
  const log = silenceErrorLog();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  let posted = 0;
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest: () => {
      throw new Error('agent 3333 is gone');
    },
    preparationSecrets: () => Promise.resolve([]),
    fetch: () => {
      posted += 1;
      return Promise.resolve(sse(''));
    },
  });

  launch(context(run));
  const settled = await settle(store);
  expect(posted).toBe(0);
  expect(settled.status).toBe('failed');
  const stored =
    'run_preparation_failed: The run request could not be prepared at the compose step (Error).';
  expect(settled.error).toBe(stored);
  expect(settled.error).not.toContain('agent 3333');
  expect(log).toHaveBeenCalledWith(
    '[runs] run preparation failed at the compose step (Error): agent 3333 is gone',
  );
  // The failure is replayable: a client that reconnects learns about it from the log, not
  // only from the record. Same rule as every other terminal status here.
  expect(await transcript(store)).toEqual([
    { type: RUN_STATUS_EVENT, data: { status: 'running', error: null } },
    { type: RUN_STATUS_EVENT, data: { status: 'failed', error: stored } },
  ]);
  log.mockRestore();
}

/** Launches a run whose request build throws `message`, with the given preparation secrets. */
async function launchFailingToCompose(
  message: string,
  preparationSecrets: () => Promise<readonly string[]>,
) {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest: () => {
      throw new Error(message);
    },
    preparationSecrets,
    fetch: () => Promise.resolve(sse('')),
  })(context(run));
  return settle(store);
}

async function redactsAShortDeclaredSecret() {
  const log = silenceErrorLog();
  const secret = 'shortsecret1';
  const settled = await launchFailingToCompose(
    `tool host refused key ${secret} for agent 3333`,
    () => Promise.resolve([secret]),
  );
  expect(settled.error).not.toContain(secret);
  expect(log).toHaveBeenCalledWith(
    '[runs] run preparation failed at the compose step (Error): tool host refused key [redacted] for agent 3333',
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  log.mockRestore();
}

async function withholdsTheMessageWhenSecretsCannotBeRead() {
  const log = silenceErrorLog();
  await launchFailingToCompose('key shortsecret1 refused', () =>
    Promise.reject(new Error('secrets store down')),
  );
  expect(log).toHaveBeenCalledWith(
    '[runs] run preparation failed at the compose step (Error): [withheld]',
  );
  log.mockRestore();
}

/** Resolves once the launch is over: the terminal telemetry call, which `settle` cannot see. */
function launchFinishedLatch() {
  const { reached, notify } = latch();
  return { finished: reached, onRunFinished: () => notify() };
}

type TokenRow = { id: string; runId: string; revoked: boolean };

/**
 * `buildRunRequest` for a run that is interrupted while it is still queued: it mints the gateway
 * token, and the interrupt lands exactly there, performed the way `interruptRun` in
 * `composition/register.ts` performs it: terminal status, then revocation (which finds the row
 * only because this fixture mints it first — in production `buildRunRequest` has not returned
 * yet), then the best-effort runtime signal, which finds no registry entry because
 * `registerLiveRun` runs after this callback.
 */
async function mintTokenThenInterrupt(
  store: InMemoryRunStore,
  tokens: TokenRow[],
  record: typeof globalThis.fetch,
) {
  tokens.push({ id: 'token-1', runId: RUN, revoked: false });
  await store.appendPlatformEvent(RUN, {
    type: RUN_STATUS_EVENT,
    data: { status: 'cancelled', error: INTERRUPTED },
  });
  await store.finish(RUN, 'cancelled', INTERRUPTED);
  await signalLiveRun(RUN, record);
  return RUN_REQUEST_FIXTURE;
}

async function postsNothingWhenInterruptedWhileQueued() {
  resetLiveRuns();
  const store = new InMemoryRunStore();
  const run = await newRun(store);

  // The run's gateway token row does not exist until `buildRunRequest` mints it (register.ts's
  // `gateway.issue` callback registers it there), so an interrupt that lands before that point
  // revokes nothing at all. This is that table.
  const tokens: TokenRow[] = [];

  // Every request this launch makes, whatever its purpose: the assertion below is that it makes
  // none — neither `POST {base}/run` nor a runtime interrupt signal.
  const urls: string[] = [];
  const record: typeof globalThis.fetch = (input) => {
    urls.push(urlOf(input));
    return Promise.resolve(sse(RUN_DONE));
  };

  // The launcher's work outlives the run's terminal status here — the interrupt writes that
  // status — so `settle` cannot tell when the launch is over. The terminal telemetry call can.
  const { finished, onRunFinished } = launchFinishedLatch();

  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest: () => mintTokenThenInterrupt(store, tokens, record),
    revokeRunTokens: (launched) => {
      for (const token of tokens) {
        if (token.runId === launched.run.id) token.revoked = true;
      }
      return Promise.resolve();
    },
    fetch: record,
    onRunFinished,
  });

  launch(context(run));
  await finished;

  // (a) the runtime never receives the request …
  expect(urls).toEqual([]);
  // … (b) and no active token survives the launch that minted one.
  expect(tokens).toEqual([{ id: 'token-1', runId: RUN, revoked: true }]);
  const settled = await settle(store);
  expect(settled.status).toBe('cancelled');
  expect(settled.error).toBe(INTERRUPTED);
  // The run never started, so the log carries the interrupt's `cancelled` and no `running`.
  expect(await transcript(store)).toEqual([
    { type: RUN_STATUS_EVENT, data: { status: 'cancelled', error: INTERRUPTED } },
  ]);
}

async function revokesTheTokenWhenPreparationFailsAfterAnInterrupt() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  let revoked = 0;
  const { finished, onRunFinished } = launchFinishedLatch();
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest: async () => {
      // The token is minted here; the interrupt then ends the queued run, and the step after
      // composing fails, so the launch's own `finish` is a no-op that revokes nothing.
      await store.finish(RUN, 'cancelled', INTERRUPTED);
      throw new Error('hydrate failed');
    },
    revokeRunTokens: () => {
      revoked += 1;
      return Promise.resolve();
    },
    onRunFinished,
  });
  launch(context(run));
  await finished;
  expect(revoked).toBe(1);
  expect((await settle(store)).status).toBe('cancelled');
}

async function reportsTheSettledCostOnTheTelemetryMeasurement() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const measurements: { status: string; costUsd: number | null }[] = [];
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    fetch: () => Promise.resolve(sse(RUN_DONE)),
    onRunFinished: (measurement) => {
      measurements.push({ status: measurement.status, costUsd: measurement.costUsd });
    },
  });
  launch(context(run));
  await settle(store);
  // The in-memory store's own default is an actual, measured zero (issue #134's distinction is
  // between the store having a real number and the launcher fabricating `null`) — asserting the
  // exact value, not just non-null, is what a regression to the hardcoded `costUsd: null` fails.
  expect(measurements).toEqual([{ status: 'completed', costUsd: 0 }]);
}

function returnsSynchronously() {
  const store = new InMemoryRunStore();
  const launch = createRunnerLauncher({
    baseUrl: BASE,
    store,
    buildRunRequest,
    fetch: () => new Promise(() => undefined),
  });
  void newRun(store).then((run) => {
    expect(launch(context(run))).toBeUndefined();
  });
}

describe('createRunnerLauncher', () => {
  it(
    'registers this run in the live-run registry while it holds the runtime connection, and releases it once settled',
    registersTheRunWhileItHoldsTheConnection,
  );
  it(
    'fails the run when the runtime does not answer within the connect timeout',
    failsWhenRuntimeDoesNotAnswerInTime,
  );
  it(
    'interrupts and fails a run before its fixed gateway credential can expire',
    interruptsBeforeTheGatewayCredentialExpires,
  );
  it(
    'fails the run, and posts nothing, when the run request cannot be built',
    postsNothingWhenTheRequestCannotBeBuilt,
  );
  it(
    "redacts the run's short declared secret from the preparation log and keeps it out of the problem (issue #827)",
    redactsAShortDeclaredSecret,
  );
  it(
    'withholds the preparation log message when the run secrets cannot be read (issue #827)',
    withholdsTheMessageWhenSecretsCannotBeRead,
  );
  it(
    'posts nothing and leaves no active token when an interrupt lands while the run is still queued (issue #235)',
    postsNothingWhenInterruptedWhileQueued,
  );
  it(
    'revokes the token it minted when an interrupt lands and then preparation fails',
    revokesTheTokenWhenPreparationFailsAfterAnInterrupt,
  );
  it(
    'reports the run store’s settled cost on the terminal telemetry measurement, not a hardcoded null',
    reportsTheSettledCostOnTheTelemetryMeasurement,
  );
  it(
    'returns synchronously — the HTTP response that starts a run never waits for it',
    returnsSynchronously,
  );
});
