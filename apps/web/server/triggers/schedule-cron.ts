/**
 * `GET /api/cron/triggers`: the schedule pass driven by Vercel Cron instead of the in-process
 * interval (issue #1294, ADR-0144 D5). The same shape, and the same vendor facts, as
 * `sessions/retention-cron.ts`: the route exists only where `CRON_SECRET` is set (the composition
 * root reads it and installs it with the pass), answers 404 otherwise, and runs the pass only for
 * the exact bearer. A duplicate delivery is harmless because every firing claims its slot first.
 */
import type { Logger } from '@agent-workspace/core/telemetry';
import { defineSlot } from '../runtime-slot';
import { bearerMatches, problem } from '../sessions/retention-cron';
import type { AgentArchiveSweepResult } from '../agents/archive/sweep';
import type { SchedulePassResult } from './schedule-pass';

/**
 * What one delivery of the cron did: the schedule pass, and the agent auto-archive sweep (issue
 * #1851) that rides the same delivery. `archive` is `null` when the sweep threw; it never fails the
 * delivery, because the schedule pass has already started its runs.
 */
export type TriggerScheduleCronResult = SchedulePassResult & {
  readonly archive?: AgentArchiveSweepResult | null;
};

export type TriggerScheduleCronPass = () => Promise<TriggerScheduleCronResult>;

/** The schedule pass first, then the archive sweep; a sweep failure is logged, not thrown. */
export async function runTriggerCronPass(
  deps: Readonly<{
    schedule: () => Promise<SchedulePassResult>;
    archive: () => Promise<AgentArchiveSweepResult>;
    log: Pick<Logger, 'error'>;
  }>,
): Promise<TriggerScheduleCronResult> {
  const schedule = await deps.schedule();
  try {
    return { ...schedule, archive: await deps.archive() };
  } catch (error) {
    deps.log.error('[agent-archive] sweep failed', { error });
    return { ...schedule, archive: null };
  }
}

/** What the cron route needs, read and built by the composition root: the route reads no env. */
export interface TriggerScheduleCron {
  readonly secret: string;
  readonly pass: TriggerScheduleCronPass;
  readonly log: Pick<Logger, 'error'>;
}

const slot = defineSlot<TriggerScheduleCron>('__agentWorkspaceTriggerScheduleCron__');

/** Register the cron the route serves. Called by the composition root when `CRON_SECRET` is set. */
export function installTriggerScheduleCron(cron: TriggerScheduleCron): void {
  slot.set(cron);
}

/** Remove it. For tests. */
export function resetTriggerScheduleCron(): void {
  slot.clear();
}

export function getTriggerScheduleCron(): TriggerScheduleCron | null {
  return slot.current();
}

/**
 * Pick the one driver this process runs: the cron route when `CRON_SECRET` is set (the Vercel and
 * Cloudflare targets), the in-process interval otherwise. Never both, never neither.
 */
export function wireTriggerSchedule(
  deps: Readonly<{
    cronSecret: string | undefined;
    runPass: TriggerScheduleCronPass;
    log: Pick<Logger, 'error'>;
    startScheduler: () => void;
    installCron?: (cron: TriggerScheduleCron) => void;
  }>,
): 'cron' | 'interval' {
  if (deps.cronSecret !== undefined && deps.cronSecret !== '') {
    (deps.installCron ?? installTriggerScheduleCron)({
      secret: deps.cronSecret,
      pass: deps.runPass,
      log: deps.log,
    });
    return 'cron';
  }
  deps.startScheduler();
  return 'interval';
}

/** `cron` is `null` wherever `CRON_SECRET` is unset or the triggers were never composed: a 404. */
export async function handleTriggerScheduleCron(
  request: Request,
  cron: TriggerScheduleCron | null,
): Promise<Response> {
  if (cron === null) {
    return problem(404, 'not_found', 'There is nothing at this path.');
  }
  if (!bearerMatches(request.headers.get('authorization'), cron.secret)) {
    return problem(401, 'unauthenticated', 'A valid cron bearer is required.');
  }
  let result: TriggerScheduleCronResult;
  try {
    result = await cron.pass();
  } catch (error) {
    // SQL and store text stay in the server log; the caller gets the standard envelope.
    cron.log.error('[trigger-schedule-cron] pass failed', { error });
    return problem(500, 'internal_error', 'The request could not be completed.');
  }
  return Response.json(result, { status: 200 });
}
