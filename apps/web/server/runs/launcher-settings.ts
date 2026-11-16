import { RUN_FILES_MAX_ARCHIVE_BYTES } from '@agent-workspace/runtime/transfer';
import { CANCELLATION_WATCH_INTERVAL_MS } from './cancellation-watch';
import { systemClock } from '../clock';
import { systemRandom } from '../ids';
import { type RunnerLauncherOptions } from './launcher-contract';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  STORAGE_WRITEBACK_DEADLINE_MS,
  staleRunAfterMs,
  positiveOr,
} from './launcher-deadlines';
import {
  DEFAULT_CAPACITY_MAX_WAIT_MS,
  DEFAULT_CAPACITY_INITIAL_DELAY_MS,
  DEFAULT_CAPACITY_MAX_DELAY_MS,
  type CapacityRetry,
} from './launcher-capacity';

export function launcherSettings(options: RunnerLauncherOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;

  const timeoutMs =
    typeof options.connectTimeoutMs === 'number' && options.connectTimeoutMs > 0
      ? options.connectTimeoutMs
      : DEFAULT_CONNECT_TIMEOUT_MS;

  const configuredMaxRunDurationMs =
    typeof options.maxRunDurationMs === 'number' &&
    Number.isFinite(options.maxRunDurationMs) &&
    options.maxRunDurationMs > 0
      ? options.maxRunDurationMs
      : null;

  const hostMaxRunDurationMs =
    typeof options.hostMaxRunDurationMs === 'number' &&
    Number.isFinite(options.hostMaxRunDurationMs) &&
    options.hostMaxRunDurationMs > 0
      ? options.hostMaxRunDurationMs
      : null;

  const maxOutputArchiveBytes =
    typeof options.maxOutputArchiveBytes === 'number' &&
    Number.isSafeInteger(options.maxOutputArchiveBytes) &&
    options.maxOutputArchiveBytes > 0
      ? options.maxOutputArchiveBytes
      : RUN_FILES_MAX_ARCHIVE_BYTES;

  const storageWritebackDeadlineMs = positiveOr(
    options.storageWritebackDeadlineMs,
    STORAGE_WRITEBACK_DEADLINE_MS,
  );

  // Where the stale-run sweep fails a run still `running`; the write-back stops short of it.
  const staleAfterMs =
    configuredMaxRunDurationMs === null ? null : staleRunAfterMs(configuredMaxRunDurationMs);

  const capacityRetry: CapacityRetry = {
    maxWaitMs: positiveOr(options.capacityRetry?.maxWaitMs, DEFAULT_CAPACITY_MAX_WAIT_MS),
    initialDelayMs: positiveOr(
      options.capacityRetry?.initialDelayMs,
      DEFAULT_CAPACITY_INITIAL_DELAY_MS,
    ),
    maxDelayMs: positiveOr(options.capacityRetry?.maxDelayMs, DEFAULT_CAPACITY_MAX_DELAY_MS),
  };

  const cancellationWatchIntervalMs = positiveOr(
    options.cancellationWatchIntervalMs,
    CANCELLATION_WATCH_INTERVAL_MS,
  );
  return {
    doFetch,
    timeoutMs,
    configuredMaxRunDurationMs,
    hostMaxRunDurationMs,
    maxOutputArchiveBytes,
    storageWritebackDeadlineMs,
    staleAfterMs,
    capacityRetry,
    cancellationWatchIntervalMs,
    clock: options.clock ?? systemClock,
    random: options.random ?? systemRandom,
  };
}

export type LauncherSettings = ReturnType<typeof launcherSettings>;
