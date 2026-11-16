import { registerLiveRun, releaseLiveRun, signalRuntimeInterrupt } from './interrupt';
import { RUN_STATUS_EVENT } from './sse';
import { publicRunFailure } from './failures';
import type { LaunchContext } from './environment';
import { type RunnerLauncherOptions } from './launcher-contract';
import {
  watchHeldRun,
  warnAttachmentsRemovedShell,
  abandonInterruptedLaunch,
} from './launcher-outcomes';
import { describeLifetime } from './launcher-deadlines';
import { launcherSettings, type LauncherSettings } from './launcher-settings';
import { prepareRuntime } from './launcher-prepare';
import { executeHeldRun } from './launcher-execution';

export { type RunnerLauncherOptions, type RuntimeWorkspaceLifecycle } from './launcher-contract';

export {
  STORAGE_WRITEBACK_DEADLINE_MS,
  staleRunAfterMs,
  STORAGE_WRITEBACK_HOST_MARGIN_MS,
} from './launcher-deadlines';

export { RUN_STATUS_EVENT };

async function launchRuntime(
  options: RunnerLauncherOptions,
  context: LaunchContext,
  settings: LauncherSettings,
): Promise<void> {
  const runId = context.run.id;
  const startedAtMs = settings.clock.now().getTime();
  const prepared = await prepareRuntime(options, context, settings, startedAtMs);
  if (prepared === null) return;
  const { target, base, runtimeHeaders, hostRemainingMs } = prepared;
  const store = options.store;
  const profileDurationMs =
    target?.timeoutSeconds === undefined ? null : target.timeoutSeconds * 1_000;
  const bounds = [settings.configuredMaxRunDurationMs, hostRemainingMs, profileDurationMs].filter(
    (bound): bound is number => bound !== null,
  );
  const maxRunDurationMs = bounds.length === 0 ? null : Math.min(...bounds);
  const lifetimeLabel = describeLifetime(maxRunDurationMs, hostRemainingMs);

  // `base` is known from here on: register this process as the one holding the run's runtime
  // connection, for `POST /api/runs/:id/interrupt` (issue #235, S-14) to find through
  // `interrupt.ts`'s registry. Released in `finally` below, whatever the run's outcome —
  // including a failure that never reaches the runtime at all.
  // An interrupt served by this process also stops the run's storage write-back.
  const interrupted = new AbortController();
  registerLiveRun(runId, {
    base,
    headers: runtimeHeaders,
    onInterrupt: () => interrupted.abort(new Error('the run was interrupted')),
  });
  let stopWatch: () => void = () => undefined;
  try {
    // `markRunning` moves a run only out of `queued`, and reports whether *this* call is what
    // moved it. `false` here means something else already took the run out of `queued`, and on
    // this path that something is an interrupt: `POST /api/runs/:id/interrupt` accepts a run
    // that is still queued, writes its terminal `cancelled` status and revokes its tokens — of
    // which there were none, because `buildRunRequest` above is where the run's gateway token
    // is minted. Posting `/run` now would hand the runtime a brand-new, live credential for a run
    // whose caller has already been told it was cancelled, which is exactly the invariant the
    // interrupt's ordering exists to buy ("a caller never sees success for a run whose
    // credential is still live", docs/adr/SDK-03-RUN-235-*.md). So nothing is sent, the
    // credential this launch minted is revoked, and the run is finalised through the same
    // `conclude` as every other outcome. `releaseLiveRun` still runs in the `finally` below.
    if (!(await store.markRunning(runId))) {
      await abandonInterruptedLaunch(store, options, context, startedAtMs, target);
      return;
    }
    // From here until this launch writes its own stop, a stop committed by anyone else (an
    // interrupt served by a replica that does not hold this run) stops the runtime. The
    // `queued` window before this point is `markRunning`'s, above.
    const watch = watchHeldRun(
      store,
      runId,
      settings.cancellationWatchIntervalMs,
      interrupted,
      () => signalRuntimeInterrupt(base, runId, runtimeHeaders, settings.doFetch),
    );
    stopWatch = watch.stop;
    await store.appendPlatformEvent(runId, {
      type: RUN_STATUS_EVENT,
      data: { status: 'running', error: null },
    });
    await warnAttachmentsRemovedShell(store, context);

    await executeHeldRun({
      options,
      context,
      prepared,
      settings,
      startedAtMs,
      interrupted,
      watch,
      maxRunDurationMs,
      lifetimeLabel,
    });
  } finally {
    stopWatch();
    releaseLiveRun(runId);
  }
}

/**
 * Build a `launch` for {@link import('./environment.js').RunApiEnvironment}.
 *
 * Fire-and-forget by contract: it returns as soon as the run is queued, and every outcome —
 * including "the runtime never answered" — is written to the store rather than to the HTTP
 * response that started the run.
 */
export function createRunnerLauncher(options: RunnerLauncherOptions): (c: LaunchContext) => void {
  const settings = launcherSettings(options);
  return (context: LaunchContext): void => {
    const work = launchRuntime(options, context, settings)
      .catch((cause: unknown) => {
        // The store may itself be unavailable, so there is no reliable place left to persist this.
        // Keep the cause in server diagnostics instead of silently losing the failure.
        publicRunFailure(cause, {
          operation: 'finalize-run',
          publicMessage: 'The run could not be finalized.',
        });
      })
      .finally(() => {
        options.onLaunchSettled?.(context);
      });
    options.keepAlive?.(work);
  };
}
