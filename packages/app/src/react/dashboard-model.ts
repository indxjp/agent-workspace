/**
 * The dashboard's pure half (issue #1522): the order of each list, the run view a row opens, how
 * long ago something happened in the reader's language, a run's badge, and what each of the four
 * lists holds or says when it is empty. No React and no `fetch`, so it is tested alone.
 */
import type { RunStatus } from '@indx-workspace/contracts/runs';

import type { DashboardSnapshot, DashboardSpend, RunSummary } from '../dashboard-wire.js';
import type { AppLocale, DashboardStrings } from './locale.js';

/** How often the dashboard asks again while it is visible. */
export const DASHBOARD_POLL_INTERVAL_MS = 1000;

/** The four lists, in the order J5 names them. */
type DashboardListKey = 'running' | 'waiting' | 'failed' | 'spend';

/** The tones the kit's badge is drawn in, as the recipe graph's. */
type DashboardBadgeTone = 'info' | 'warn' | 'ok' | 'danger';

const RUN_TONES: Readonly<Record<RunStatus, DashboardBadgeTone>> = {
  queued: 'info',
  running: 'info',
  awaiting_approval: 'warn',
  completed: 'ok',
  failed: 'danger',
  cancelled: 'warn',
};

/** A run's status as a badge: its words and its tone. */
export function runStatusBadge(
  status: RunStatus,
  strings: DashboardStrings,
): { readonly label: string; readonly tone: DashboardBadgeTone } {
  return { label: strings.runStatus[status], tone: RUN_TONES[status] };
}

/** The runs newest first, then by id, so two created together keep one order. */
export function newestFirst(runs: readonly RunSummary[]): readonly RunSummary[] {
  return [...runs].sort(
    (left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

/** The spend by currency code, so a currency keeps its row from one poll to the next. */
export function byCurrency(spend: readonly DashboardSpend[]): readonly DashboardSpend[] {
  return [...spend].sort((left, right) =>
    left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0,
  );
}

/** The console's view of one run: the run history with its detail panel open. */
export function runViewUrl(platformUrl: string, runId: string): string {
  return `${platformUrl.replace(/\/+$/u, '')}/runs?run=${encodeURIComponent(runId)}`;
}

/** The first group of a run id, which is how the console abbreviates it. */
export function shortRunId(runId: string): string {
  return runId.split('-')[0] ?? runId;
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/**
 * How long before `asOf` the instant `at` was, in the reader's language (`5 minutes ago`,
 * `now`). Measured against the snapshot's own time, so a server and a browser draw the same words.
 */
export function relativeTime(at: string, asOf: string, locale: AppLocale): string {
  const elapsed = Math.max(0, Date.parse(asOf) - Date.parse(at));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return format.format(-Math.floor(elapsed / 1000), 'second');
}

/** One of the three run lists: its key, heading, rows, empty line and whether it was cut short. */
export interface DashboardRunList {
  readonly key: Exclude<DashboardListKey, 'spend'>;
  readonly heading: string;
  readonly rows: readonly RunSummary[];
  readonly empty: string;
  readonly truncated: boolean;
}

/** The three run lists of `snapshot`, each in order, in J5's order. */
export function runListsOf(
  snapshot: DashboardSnapshot,
  strings: DashboardStrings,
): readonly DashboardRunList[] {
  return [
    {
      key: 'running',
      heading: strings.runningHeading,
      rows: newestFirst(snapshot.running),
      empty: strings.noRunning,
      truncated: snapshot.truncated.running,
    },
    {
      key: 'waiting',
      heading: strings.waitingHeading,
      rows: newestFirst(snapshot.waiting),
      empty: strings.noWaiting,
      truncated: snapshot.truncated.waiting,
    },
    {
      key: 'failed',
      heading: strings.failedHeading,
      rows: newestFirst(snapshot.failed),
      empty: strings.noFailed,
      truncated: snapshot.truncated.failed,
    },
  ];
}

/** When the lists were read, as a time of day in UTC, so a server and a browser agree. */
export function updatedAt(asOf: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'long', timeZone: 'UTC' }).format(
    new Date(asOf),
  );
}

/**
 * A spend in the reader's language and its currency, from its exact decimal string (`Intl` reads
 * the string as a decimal, never a float); the amount and code as they are when the currency is
 * not one `Intl` knows.
 */
export function formatSpend(
  spend: Pick<DashboardSpend, 'amount' | 'currency'>,
  locale: AppLocale,
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: spend.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(spend.amount as `${number}`);
  } catch {
    return `${spend.amount} ${spend.currency}`;
  }
}
