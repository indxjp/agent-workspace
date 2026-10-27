/**
 * The pure half of schedule triggers (issue #1294, ADR-0144 D6): when is a cron expression next due,
 * and is a trigger due now. Nothing here reads a clock or a database; `schedule-pass.ts` is the
 * effectful shell. This is the one place a cron expression is parsed.
 */
import { Cron } from 'croner';

import type { TriggerRecord } from './runtime';

/** The first instant strictly after `after` that `cron` matches in `timezone`, or `null` if never. */
export function nextFireAt(cron: string, timezone: string, after: Date): Date | null {
  return new Cron(cron, { timezone, paused: true }).nextRun(after);
}

/**
 * Why `cron` in `timezone` cannot schedule a trigger, or `null` when it can. Exactly five fields (no
 * seconds, no nicknames), an expression and an IANA zone croner accepts, and an instant that exists.
 */
export function findScheduleError(cron: string, timezone: string): string | null {
  if (cron.trim().split(/\s+/u).length !== 5) {
    return 'cron must have exactly five fields: minute hour day-of-month month day-of-week';
  }
  try {
    return nextFireAt(cron, timezone, new Date(0)) === null ? 'cron never matches a date' : null;
  } catch {
    return 'cron or timezone is not valid; the timezone must be an IANA name such as Asia/Tokyo';
  }
}

/**
 * The scheduled instant `trigger` owes a run at `now`, or `null`. Counting starts at the last firing
 * (or creation), so a trigger that missed several windows owes one run, not one per window (D5); and
 * never before `scheduleFrom`, so a schedule re-enabled or re-timed owes nothing for the windows
 * before that.
 */
export function dueSlot(
  trigger: Pick<
    TriggerRecord,
    'kind' | 'enabled' | 'cron' | 'timezone' | 'lastFiredAt' | 'scheduleFrom' | 'createdAt'
  >,
  now: Date,
): Date | null {
  if (trigger.kind !== 'schedule' || !trigger.enabled) return null;
  if (trigger.cron === null || trigger.timezone === null) return null;
  const fired = trigger.lastFiredAt ?? trigger.createdAt;
  const from =
    trigger.scheduleFrom !== null && trigger.scheduleFrom.getTime() > fired.getTime()
      ? trigger.scheduleFrom
      : fired;
  const slot = nextFireAt(trigger.cron, trigger.timezone, from);
  return slot !== null && slot.getTime() <= now.getTime() ? slot : null;
}
