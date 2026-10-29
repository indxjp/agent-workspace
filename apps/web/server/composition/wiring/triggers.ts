import type { SecretsService } from '@agent-workspace/core/secrets';

import { openAgentArchiveStore, type AgentArchiveRoot } from '../../agents/archive/store';
import { createAgentArchiveSweep, startAgentArchiveScheduler } from '../../agents/archive/sweep';
import type { TriggersRuntime } from '../../triggers/runtime';
import {
  runSchedulePass,
  startSchedulePassScheduler,
  type ScheduleRoot,
} from '../../triggers/schedule-pass';
import { runTriggerCronPass, wireTriggerSchedule } from '../../triggers/schedule-cron';
import type { Logger } from '@agent-workspace/core/telemetry';
import { createRepositoryTriggersRuntime } from '../../triggers/store';

const SCHEDULE_INTERVAL_MS = 60_000;
// A poll, not the cadence: the sweep itself runs at most once an hour (see `agents/archive/sweep.ts`).
const ARCHIVE_POLL_MS = 15 * 60_000;

/**
 * Build the trigger routes' runtime and start the schedule driver. `root` is typed by the store
 * adapter, the one triggers file that may name `core/db` (F-15).
 */
export function wireTriggers(
  root: Parameters<typeof createRepositoryTriggersRuntime>[0] & ScheduleRoot & AgentArchiveRoot,
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
  // Issue #1851: the agent auto-archive sweep rides the same driver. The repository is the sweep's
  // store, so nothing here decides which agent is archived. The cron and the timer share this one
  // sweep, and so its once-an-hour throttle.
  const sweepArchive = createAgentArchiveSweep({
    listWorkspaceIds: () => root.listWorkspaceIds(),
    tryAcquireMaintenanceLease: (name, ttlMs) => root.tryAcquireMaintenanceLease(name, ttlMs),
    storeFor: (workspaceId) => openAgentArchiveStore(root, workspaceId),
    now: () => runtime.now(),
    log,
  });
  const driver = wireTriggerSchedule({
    cronSecret: options.cronSecret,
    runPass: () =>
      runTriggerCronPass({
        schedule: () => runSchedulePass(deps),
        archive: sweepArchive,
        log,
      }),
    log,
    startScheduler: () => {
      options.stopOnClose(
        startSchedulePassScheduler({
          ...deps,
          intervalMs: SCHEDULE_INTERVAL_MS,
          onError: (error) => log.error('[compose] trigger schedule pass failed', { error }),
        }),
      );
      options.stopOnClose(
        startAgentArchiveScheduler({
          sweep: sweepArchive,
          intervalMs: ARCHIVE_POLL_MS,
          onError: (error) => log.error('[compose] agent archive sweep failed', { error }),
        }),
      );
    },
  });
  log.info(
    `[compose] schedule triggers ${driver === 'cron' ? 'run from the cron route' : 'scheduled every minute'}`,
  );
  return runtime;
}
