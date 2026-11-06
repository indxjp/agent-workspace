import { withStreamedDigests } from './streamed-digests';
import { atStep, publicPreparationFailure, publicRunFailure } from './failures';
import type { LaunchContext } from './environment';
import type { RuntimeLaunchTarget } from '../compose/runtime-profile';
import { type RunnerLauncherOptions } from './launcher-contract';
import { preparationSecretsOf, concludePreparationFailure } from './launcher-outcomes';
import { assertDeadlineFitsHost, hostBudgetLeft } from './launcher-deadlines';
import { hydrateRuntime, hydrateLocalWorkspace } from './launcher-hydration';
import type { LauncherSettings } from './launcher-settings';

export async function prepareRuntime(
  options: RunnerLauncherOptions,
  context: LaunchContext,
  settings: LauncherSettings,
  startedAtMs: number,
) {
  const { doFetch, hostMaxRunDurationMs } = settings;
  const store = options.store;
  // Compile before anything is written or sent. A body that cannot be built is a run that
  // cannot start, and it is reported as a failed run rather than as an empty stream — the
  // caller already has a 202 and a stream URL, so the only place left to say so is the store.
  let body: unknown;
  let target: RuntimeLaunchTarget | undefined;
  let base: string;
  let hydrating = false;
  let runtimeHeaders: Readonly<Record<string, string>>;
  let hostRemainingMs: number | null;
  let archive: ReadableStream<Uint8Array> | null = null;
  const digests = new Map<string, string>();
  try {
    // Before the runtime is resolved, which may create its sandbox: a run whose files are over
    // the limit (`run_files_too_large`) is refused with nothing allocated. Nothing is read yet.
    const lifecycle = options.workspaceLifecycle;
    archive =
      lifecycle === undefined
        ? null
        : await atStep('resources', () =>
            lifecycle.inputArchive(context, (path, sha256) => digests.set(path, sha256)),
          );
    const runtime = options.runtime;
    target =
      runtime === undefined
        ? undefined
        : await atStep('runtime_profile', () => runtime.resolve(context));
    assertDeadlineFitsHost(target?.timeoutSeconds, hostMaxRunDurationMs);
    const selectedUrl = target?.runnerUrl ?? options.baseUrl;
    if (selectedUrl === undefined || selectedUrl.trim().length === 0) {
      throw new Error('no runtime launch target was selected');
    }
    base = selectedUrl.replace(/\/+$/, '');
    runtimeHeaders = options.runtimeRequestHeaders?.(target) ?? {};
    body = await atStep('compose', () => options.buildRunRequest(context, target));
    // The in-process runner's `/files` endpoint is not session-scoped, so a `local-disk` target
    // is hydrated on this host instead. The driver's id is never compared (the storage design, §03).
    if (archive !== null && target?.fileTransfer === 'local-disk') {
      hydrating = true;
      await hydrateLocalWorkspace(archive, target);
    } else if (archive !== null && target !== undefined) {
      hydrating = true;
      await hydrateRuntime(archive, base, doFetch, runtimeHeaders);
    } else {
      await archive?.cancel();
    }
    body = withStreamedDigests(body, digests);
    hostRemainingMs = hostBudgetLeft(hostMaxRunDurationMs, startedAtMs);
  } catch (cause) {
    // Unread when a step before the hydrate threw; a consumed or locked one rejects, ignored.
    await archive?.cancel().catch(() => undefined);
    const detail = hydrating
      ? publicRunFailure(cause, {
          operation: 'hydrate-workspace',
          publicMessage: 'The workspace could not be prepared.',
          failureKind: 'upstream',
        })
      : publicPreparationFailure(cause, await preparationSecretsOf(options, context, cause));
    await concludePreparationFailure(store, options, context, detail, startedAtMs, target);
    return null;
  }

  return { body, target, base, runtimeHeaders, hostRemainingMs };
}

export type PreparedRuntime = NonNullable<Awaited<ReturnType<typeof prepareRuntime>>>;
