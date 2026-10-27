/**
 * Runs the storage cleanup pass on a schedule, one pass at a time across servers (the storage
 * design, §04 "The cleanup job"). Two drivers, never both: the in-process hourly timer, or, where
 * `CRON_SECRET` is set (Vercel), `GET /api/cron/storage-cleanup` called by the platform cron. The
 * route has the same shape as `triggers/schedule-cron.ts`: 404 while no cron is installed, 401
 * without the exact bearer, and the pass under the same lock as the timer.
 */
import type { Logger } from '@agent-workspace/core/telemetry';

import { defineSlot } from '../runtime-slot';
import { bearerMatches, problem } from '../sessions/retention-cron';
import type { CleanupReport } from './cleanup';
import type { LockOutcome } from './store';

// @story US-STO-14
export type CleanupMode = 'report' | 'delete';

export const STORAGE_CLEANUP_ENV = 'AW_STORAGE_CLEANUP';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Unset or blank means `report`; `report` and `delete` are the only values. Anything else throws,
 * so start-up stops; the message names the variable and never echoes the value.
 */
export function readStorageCleanupMode(raw: string | null): CleanupMode {
  if (raw === null || raw === 'report') return 'report';
  if (raw === 'delete') return 'delete';
  throw new Error(`${STORAGE_CLEANUP_ENV} must be report or delete.`);
}

export interface CleanupTickDependencies<T> {
  readonly lock: <R>(name: string, work: () => Promise<R>) => Promise<LockOutcome<R>>;
  readonly pass: () => Promise<T>;
  readonly log: Logger;
}

/** One scheduled run: the pass, unless another server holds the lock. */
export async function runCleanupTick<T>(deps: CleanupTickDependencies<T>): Promise<LockOutcome<T>> {
  const outcome = await deps.lock('storage-cleanup', deps.pass);
  if (!outcome.acquired) {
    deps.log.info('storage cleanup skipped: another server is running it');
  }
  return outcome;
}

/** What the cron route serves, installed by the composition root: the route reads no env. */
export interface StorageCleanupCron {
  readonly secret: string;
  readonly tick: () => Promise<LockOutcome<CleanupReport>>;
  readonly log: Pick<Logger, 'warn'>;
}

const slot = defineSlot<StorageCleanupCron>('__agentWorkspaceStorageCleanupCron__');

/** Remove the installed cron. For tests. */
export function resetStorageCleanupCron(): void {
  slot.clear();
}

export function getStorageCleanupCron(): StorageCleanupCron | null {
  return slot.current();
}

export interface StorageCleanupStart extends CleanupTickDependencies<CleanupReport> {
  /** `CRON_SECRET`, or `null`: when set, the cron route drives the pass and no timer starts. */
  readonly cronSecret: string | null;
  readonly stopOnClose: (stop: () => void) => void;
  readonly intervalMs?: number;
}

const errorName = (error: unknown) => ({
  name: error instanceof Error ? error.name : 'unknown',
});

/** Install the cron route where `CRON_SECRET` is set, else start the hourly timer. */
export function startStorageCleanup(deps: StorageCleanupStart): 'cron' | 'interval' {
  if (deps.cronSecret !== null) {
    slot.set({
      secret: deps.cronSecret,
      tick: () => runCleanupTick(deps),
      log: deps.log,
    });
    return 'cron';
  }
  const timer = setInterval(() => {
    runCleanupTick(deps).catch((error: unknown) => {
      deps.log.warn('[storage] a cleanup run failed', errorName(error));
    });
  }, deps.intervalMs ?? HOUR_MS);
  timer.unref();
  deps.stopOnClose(() => clearInterval(timer));
  return 'interval';
}

/**
 * `cron` is `null` wherever `CRON_SECRET` is unset or storage was never composed: a 404. The answer
 * is the report's counts, or `alreadyRunning` when another call or server holds the lock.
 */
export async function handleStorageCleanupCron(
  request: Request,
  cron: StorageCleanupCron | null,
): Promise<Response> {
  if (cron === null) {
    return problem(404, 'not_found', 'There is nothing at this path.');
  }
  if (!bearerMatches(request.headers.get('authorization'), cron.secret)) {
    return problem(401, 'unauthenticated', 'A valid cron bearer is required.');
  }
  let outcome: LockOutcome<CleanupReport>;
  try {
    outcome = await cron.tick();
  } catch (error) {
    // A storage message can carry a signed URL: only the error name reaches the log.
    cron.log.warn('[storage] a cleanup run failed', errorName(error));
    return problem(500, 'internal_error', 'The request could not be completed.');
  }
  if (!outcome.acquired) return Response.json({ alreadyRunning: true }, { status: 200 });
  // Named one by one, so a field added to the report later never reaches the caller unreviewed.
  const report = outcome.value;
  return Response.json(
    {
      alreadyRunning: false,
      mode: report.mode,
      scanned: report.scanned,
      orphans: report.orphans,
      legacyOrphans: report.legacyOrphans,
      stalePendingReady: report.stalePendingReady,
      stalePendingDeleted: report.stalePendingDeleted,
      deletingFinished: report.deletingFinished,
      skippedYoung: report.skippedYoung,
      deleted: report.deleted,
    },
    { status: 200 },
  );
}
