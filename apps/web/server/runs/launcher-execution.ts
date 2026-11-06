import { signalRuntimeInterrupt } from './interrupt';
import { relayRunnerStream } from './relay';
import type { LaunchContext } from './environment';
import { type RunnerLauncherOptions } from './launcher-contract';
import { conclude, revokeRunTokensBestEffort, concludeHeldRun } from './launcher-outcomes';
import { writeBackDeadlineMs } from './launcher-deadlines';
import { postRunAwaitingCapacity } from './launcher-capacity';
import {
  type OutputCollection,
  collectRuntimeOutputs,
  concludesCompleted,
  writeBackRunStorage,
} from './launcher-outputs';
import type { LauncherSettings } from './launcher-settings';
import type { PreparedRuntime } from './launcher-prepare';
import type { HeldRunWatch } from './launcher-outcomes';

export async function executeHeldRun(launch: {
  readonly options: RunnerLauncherOptions;
  readonly context: LaunchContext;
  readonly prepared: PreparedRuntime;
  readonly settings: LauncherSettings;
  readonly startedAtMs: number;
  readonly interrupted: AbortController;
  readonly watch: HeldRunWatch;
  readonly maxRunDurationMs: number | null;
  readonly lifetimeLabel: string;
}): Promise<void> {
  const {
    options,
    context,
    prepared,
    settings,
    startedAtMs,
    interrupted,
    watch,
    maxRunDurationMs,
    lifetimeLabel,
  } = launch;
  const store = options.store;
  const runId = context.run.id;
  const { body, target, base, runtimeHeaders } = prepared;
  const {
    doFetch,
    timeoutMs,
    capacityRetry,
    maxOutputArchiveBytes,
    storageWritebackDeadlineMs,
    hostMaxRunDurationMs,
    staleAfterMs,
  } = settings;
  // The timeout covers the CONNECT, and is cancelled the moment response headers arrive.
  // `AbortSignal.timeout(ms)` was here first and was wrong: its signal stays attached to the
  // response body, so it aborted the run's stream `ms` after it started, no matter how well
  // it was going. The acceptance run caught it as a ten-minute stream that failed at exactly
  // thirty seconds. A connect deadline must not become a run deadline — R-13 finding 8 is
  // the whole reason a run outlives any one connection.
  const lifetime = new AbortController();
  let lifetimeExpired = false;
  const lifetimeTimer =
    maxRunDurationMs === null
      ? null
      : setTimeout(() => {
          lifetimeExpired = true;
          lifetime.abort(new Error(`the run reached its ${lifetimeLabel}`));
          // Best effort cleanup of the child. The abort above is the security boundary: it
          // makes the control-plane run terminal and atomically revokes its registered token
          // even if this interrupt request cannot reach the runtime.
          void signalRuntimeInterrupt(base, runId, runtimeHeaders, doFetch);
        }, maxRunDurationMs);
  (lifetimeTimer as { unref?: () => void } | null)?.unref?.();
  const lifetimeFailure = `The run exceeded its ${lifetimeLabel}.`;

  const posted = await postRunAwaitingCapacity({
    doFetch,
    url: `${base}/run`,
    init: {
      method: 'POST',
      headers: {
        ...runtimeHeaders,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    },
    connectTimeoutMs: timeoutMs,
    // The stream's fetch carries this signal into its body, so the watch's abort ends the relay.
    lifetime: AbortSignal.any([lifetime.signal, watch.signal]),
    lifetimeExpired: () => lifetimeExpired,
    stoppedElsewhere: () => watch.signal.aborted,
    lifetimeFailure,
    retry: capacityRetry,
    stillRunning: async () => (await store.get(runId))?.status === 'running',
    revokeRunTokens: () => revokeRunTokensBestEffort(options, context),
  });
  if (posted.kind === 'stopped') {
    // Nothing was relayed, so there are no outputs to collect.
    if (lifetimeTimer !== null) clearTimeout(lifetimeTimer);
    watch.stop();
    await conclude({
      store: store,
      context: context,
      status: posted.status,
      failureMessage: posted.error,
      startedAtMs: startedAtMs,
      options: options,
      target: target,
    });
    return;
  }
  const response = posted.response;

  const outcome = await relayRunnerStream(runId, response, store, async (sessionId) => {
    await options.onSessionIdentified?.(context, sessionId);
  });
  if (lifetimeTimer !== null) clearTimeout(lifetimeTimer);
  const collection: OutputCollection = {
    lifecycle: options.workspaceLifecycle,
    context,
    target,
    base,
    doFetch,
    maxBytes: maxOutputArchiveBytes,
    requestHeaders: runtimeHeaders,
    body,
    outcome,
    lifetimeExpired,
  };
  const persistenceFailure = await collectRuntimeOutputs(collection);
  // Decided first, saved while the run is still `running`, then concluded: the session stays
  // busy until the save ends, and the save's result never changes the stored status.
  if (concludesCompleted(context, outcome, persistenceFailure, lifetimeExpired)) {
    await writeBackRunStorage(collection, store, options.storageWriteback, (storedStartedAt) =>
      AbortSignal.any([
        AbortSignal.timeout(
          writeBackDeadlineMs(
            storageWritebackDeadlineMs,
            hostMaxRunDurationMs,
            startedAtMs,
            staleAfterMs,
            storedStartedAt,
          ),
        ),
        interrupted.signal,
      ]),
    );
  }
  // This launch writes its own stop next, which the watch must not take for someone else's.
  watch.stop();
  await concludeHeldRun(store, options, context, {
    outcome,
    persistenceFailure,
    stoppedElsewhere: watch.signal.aborted,
    lifetimeFailure: lifetimeExpired ? lifetimeFailure : null,
    startedAtMs,
    target,
  });
}
