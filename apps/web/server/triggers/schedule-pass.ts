/**
 * The schedule pass (issue #1294, ADR-0144 D5): start one run for every enabled schedule trigger
 * that is due. The decision of what is due is `schedule.ts`; this file only reads, claims and starts.
 *
 * Two things make a firing happen once. The pass runs under the maintenance lease, so one replica
 * sweeps at a time; and each firing claims the slot `schedule:<scheduled instant>` before the run
 * starts, so a second replica, a lease handed over mid-pass or a duplicate Vercel Cron delivery finds
 * the slot taken. The lease is the courtesy, the claim is the guarantee. A run records `lastFiredAt`
 * as the time it started, not as the slot, so a backlog of missed windows is one run (D5).
 *
 * The pass also prunes each workspace's deliveries whose dedupe window has lapsed, so
 * `trigger_deliveries` holds about a day of firings rather than every firing ever.
 */
import type { Logger } from '@agent-workspace/core/telemetry';
import { renderTriggerPrompt } from '@indx-workspace/contracts/triggers';

import { getRunApi } from '../runs/environment';
import { deliver, ownerFor, type Runs } from './fire';
import type { TriggerRecord, TriggersRuntime } from './runtime';
import { dueSlot } from './schedule';

const LEASE_NAME = 'trigger-schedule';

/** The slice of the database root the pass needs; the lease is the one session retention uses. */
export interface ScheduleRoot {
  listWorkspaceIds(): Promise<readonly string[]>;
  tryAcquireMaintenanceLease(
    name: string,
    ttlMs: number,
  ): Promise<null | { release(): Promise<void> }>;
}

export interface SchedulePassDependencies {
  readonly root: ScheduleRoot;
  readonly runtime: TriggersRuntime;
  /** The run API, read at each pass because it is installed independently of the triggers. */
  readonly runs?: () => Runs | null;
  /** Where a failed or skipped firing is reported; the composition root passes the server log. */
  readonly log: SchedulePassLog;
}

type SchedulePassLog = Pick<Logger, 'error' | 'warn'>;

export interface SchedulePassResult {
  readonly leaseHeld: boolean;
  readonly workspaces: number;
  /** Runs started. */
  readonly fired: number;
  /** Due triggers that started nothing: slot already claimed, limit hit, owner or agent gone. */
  readonly skipped: number;
  /** Triggers or workspaces whose firing threw; the next pass tries again. */
  readonly failed: number;
}

/** One pass over every workspace. */
export async function runSchedulePass(deps: SchedulePassDependencies): Promise<SchedulePassResult> {
  const held = await deps.root.tryAcquireMaintenanceLease(LEASE_NAME, 60_000);
  if (held === null) return { leaseHeld: true, workspaces: 0, fired: 0, skipped: 0, failed: 0 };
  try {
    const runs = (deps.runs ?? getRunApi)();
    if (runs === null) throw new Error('the run API is not installed');
    const counts = { fired: 0, skipped: 0, failed: 0 };
    // ponytail: one list() per workspace per pass; add an indexed core query for due schedule
    // triggers if the number of workspaces makes that scan matter.
    const workspaceIds = await deps.root.listWorkspaceIds();
    for (const workspaceId of workspaceIds) {
      try {
        const repository = await deps.runtime.repository(workspaceId);
        await repository.pruneDeliveries(deps.runtime.now());
        const triggers = await repository.list();
        for (const trigger of triggers) await passTrigger(deps, runs, trigger, counts);
      } catch (error) {
        counts.failed += 1;
        deps.log.error(`[trigger-schedule] workspace ${workspaceId} failed`, { error });
      }
    }
    return { leaseHeld: false, workspaces: workspaceIds.length, ...counts };
  } finally {
    await held.release();
  }
}

async function passTrigger(
  { runtime, log }: SchedulePassDependencies,
  runs: Runs,
  trigger: TriggerRecord,
  counts: Record<'fired' | 'skipped' | 'failed', number>,
): Promise<void> {
  try {
    const outcome = await fireIfDue(runtime, log, runs, trigger);
    if (outcome !== null) counts[outcome] += 1;
  } catch (error) {
    counts.failed += 1;
    log.error(`[trigger-schedule] ${trigger.id} failed`, { error });
  }
}

/** `null` when the trigger is not due. */
async function fireIfDue(
  runtime: TriggersRuntime,
  log: SchedulePassLog,
  runs: Runs,
  trigger: TriggerRecord,
): Promise<'fired' | 'skipped' | null> {
  const slot = dueSlot(trigger, runtime.now());
  if (slot === null) return null;
  const owner = await ownerFor(runtime, trigger);
  if (owner === null) {
    log.warn(`[trigger-schedule] ${trigger.id} skipped: trigger_owner_not_allowed`);
    return 'skipped';
  }
  const outcome = await deliver(runtime, runs, {
    trigger,
    owner,
    prompt: renderTriggerPrompt(trigger.promptTemplate, ''),
    key: `schedule:${slot.toISOString()}`,
  });
  if (outcome.kind === 'started') return 'fired';
  // The slot is claimed, so its run started; if recording the firing failed, record it now so the
  // next pass counts from here instead of re-firing this slot once the claim window lapses.
  if (outcome.kind === 'duplicate') {
    await (await runtime.repository(trigger.workspaceId)).markFired(trigger.id, runtime.now());
  }
  if (outcome.kind === 'refused') {
    log.warn(`[trigger-schedule] ${trigger.id} skipped: ${outcome.code}`);
  }
  return 'skipped';
}

/**
 * Pass every `intervalMs` on an unref'd timer; the returned function stops it.
 *
 * ponytail: an in-process timer; the Vercel target runs `/api/cron/triggers` instead (see
 * `schedule-cron.ts`), at the cadence its plan allows.
 */
export function startSchedulePassScheduler(
  deps: SchedulePassDependencies & {
    readonly intervalMs: number;
    readonly onError: (error: unknown) => void;
  },
): () => void {
  const timer = setInterval(() => void runSchedulePass(deps).catch(deps.onError), deps.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
