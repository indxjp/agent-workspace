import type { SecretsService } from '@agent-workspace/core/secrets';

import type { TriggersRuntime } from '../../triggers/runtime';
import {
  runSchedulePass,
  startSchedulePassScheduler,
  type ScheduleRoot,
} from '../../triggers/schedule-pass';
import { wireTriggerSchedule } from '../../triggers/schedule-cron';
import type { Logger } from '@agent-workspace/core/telemetry';
import { createRepositoryTriggersRuntime } from '../../triggers/store';

const SCHEDULE_INTERVAL_MS = 60_000;

/**
 * Build the trigger routes' runtime and start the schedule driver. `root` is typed by the store
 * adapter, the one triggers file that may name `core/db` (F-15).
 */
export function wireTriggers(
  root: Parameters<typeof createRepositoryTriggersRuntime>[0] & ScheduleRoot,
  secretsService: SecretsService | null,
  options: Readonly<{
    cronSecret: string | undefined;
    log: Pick<Logger, 'error' | 'warn' | 'info'>;
    stopOnClose: (stop: () => void) => void;
  }>,
): TriggersRuntime {
  const { log } = options;
  const runtime = createRepositoryTriggersRuntime(root, secretsService);
  // ADR-0144 D5: Vercel Cron calls `GET /api/cron/triggers` where `CRON_SECRET` is set; a long-lived
  // server runs the same pass on an interval under the maintenance lease.
  const deps = { root, runtime, log };
  const driver = wireTriggerSchedule({
    cronSecret: options.cronSecret,
    runPass: () => runSchedulePass(deps),
    log,
    startScheduler: () => {
      options.stopOnClose(
        startSchedulePassScheduler({
          ...deps,
          intervalMs: SCHEDULE_INTERVAL_MS,
          onError: (error) => log.error('[compose] trigger schedule pass failed', { error }),
        }),
      );
    },
  });
  log.info(
    `[compose] schedule triggers ${driver === 'cron' ? 'run from the cron route' : 'scheduled every minute'}`,
  );
  return runtime;
}
