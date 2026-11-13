/**
 * The agent screen's Schedules tab (UX-18 in #2086): which schedule triggers start this agent, when
 * each runs next, and the form that adds one. Kept apart from React and the SDK client so it runs
 * directly in tests. The server parses every cron expression again (`server/triggers/schedule.ts`)
 * and its answer wins; the checks here only let the form explain a mistake before it is sent.
 */
import type { TriggerResource } from '@indx-workspace/contracts/triggers';
import { ApiProblemError } from '@indx-workspace/sdk';
import { Cron } from 'croner';

/** The agent's schedule triggers, by name: webhooks and other agents' triggers are not shown. */
export function agentSchedules(
  triggers: readonly TriggerResource[],
  agentId: string,
): readonly TriggerResource[] {
  return triggers
    .filter((trigger) => trigger.kind === 'schedule' && trigger.agentId === agentId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The first instant after `after` that `cron` matches in `timezone`; `null` when it never will. */
export function nextRun(cron: string, timezone: string, after: Date): Date | null {
  try {
    return new Cron(cron, { timezone, paused: true }).nextRun(after);
  } catch {
    return null;
  }
}

export type ScheduleProblem = 'fields' | 'timezone' | 'invalid' | 'never';

/**
 * Why `cron` in `timezone` cannot be saved, or `null`: exactly five fields, a time zone, an
 * expression and an IANA zone croner accepts, and a date it matches. The same rules as the server's
 * check. An empty zone is refused here because croner reads it as the local time, while the preview
 * (`formatRunTime`) and the server would not.
 */
export function scheduleProblem(cron: string, timezone: string): ScheduleProblem | null {
  if (cron.trim().split(/\s+/u).length !== 5) return 'fields';
  if (timezone.trim() === '') return 'timezone';
  try {
    return new Cron(cron, { timezone, paused: true }).nextRun(new Date(0)) === null
      ? 'never'
      : null;
  } catch {
    return 'invalid';
  }
}

/** The repeat choices the form offers before "Custom"; each is a five-field cron expression. */
export const SCHEDULE_PRESETS = [
  { id: 'hourly', cron: '0 * * * *' },
  { id: 'daily', cron: '0 9 * * *' },
  { id: 'weekdays', cron: '0 9 * * 1-5' },
  { id: 'weekly', cron: '0 9 * * 1' },
] as const;

export type SchedulePresetId = (typeof SCHEDULE_PRESETS)[number]['id'] | 'custom';

/** The cron expression a preset stands for, or `custom` when the form takes the typed one. */
export function presetCron(preset: SchedulePresetId, custom: string): string {
  return SCHEDULE_PRESETS.find((choice) => choice.id === preset)?.cron ?? custom.trim();
}

/** The preset a stored cron expression is, or `custom` when it is none of them. */
export function presetOf(cron: string): SchedulePresetId {
  return SCHEDULE_PRESETS.find((choice) => choice.cron === cron)?.id ?? 'custom';
}

/** The time zone of the browser, or UTC when it does not say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * `at` in the schedule's own zone, with the zone named, so nobody has to convert from UTC; `null`
 * when `Intl` does not know the zone, so a render never throws on what someone is still typing.
 */
export function formatRunTime(at: Date, timezone: string, locale: 'en' | 'ja'): string | null {
  try {
    const text = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
    return `${text} (${timezone})`;
  } catch {
    return null;
  }
}

/** A failed call as the tab shows it: a problem's code, or `null` for a network or unknown error. */
export function problemCode(error: unknown): string | null {
  return error instanceof ApiProblemError ? error.code : null;
}
