/**
 * The recipe graph's pure half (issue #1514): the order of a run's steps, the badge of each
 * status, how long a step took and what it cost in the reader's language, what to announce when a
 * poll brings a change, and whether to poll again. No React and no `fetch`, so it is tested alone.
 */
import type { RecipeRunStatus, RecipeStepStatus } from '../db/recipe-port.js';
import type {
  RecipeRunDetail,
  RecipeRunView,
  RecipeStepCost,
  RecipeStepView,
} from '../recipe-wire.js';
import type { AppLocale, RecipeStrings } from './locale.js';

/** The tones the kit's badge is drawn in, as `@indx-workspace/react`'s run badge names them. */
type RecipeBadgeTone = 'info' | 'warn' | 'ok' | 'danger';

/** A status as a badge: its words and its tone. */
export interface RecipeBadge {
  readonly label: string;
  readonly tone: RecipeBadgeTone;
}

/** How often the graph asks for the run again while it is not stopped. */
export const RECIPE_POLL_INTERVAL_MS = 2000;

const STEP_TONES: Readonly<Record<RecipeStepStatus, RecipeBadgeTone>> = {
  running: 'info',
  awaiting_approval: 'warn',
  completed: 'ok',
  failed: 'danger',
};

const RUN_TONES: Readonly<Record<RecipeRunStatus, RecipeBadgeTone>> = {
  running: 'info',
  waiting: 'warn',
  completed: 'ok',
  failed: 'danger',
  cancelled: 'warn',
};

/** The badge of a step's status. */
export function stepBadge(status: RecipeStepStatus, strings: RecipeStrings): RecipeBadge {
  return { label: strings.stepStatus[status], tone: STEP_TONES[status] };
}

/** The badge of a recipe run's status. */
export function runBadge(status: RecipeRunStatus, strings: RecipeStrings): RecipeBadge {
  return { label: strings.runStatus[status], tone: RUN_TONES[status] };
}

/** The steps in the order they ran: by start, then by key for two that started together. */
export function orderedSteps(steps: readonly RecipeStepView[]): readonly RecipeStepView[] {
  return [...steps].sort(
    (left, right) =>
      Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
}

/** How long a step took, or has taken so far at `now` while it has not ended; never negative. */
export function stepDurationMs(step: RecipeStepView, now: Date): number {
  const end = step.endedAt === null ? now.getTime() : Date.parse(step.endedAt);
  return Math.max(0, end - Date.parse(step.startedAt));
}

/** A duration in the reader's language: `850 ms`, `4.2 s`, `3 min 5 s`. */
export function formatDuration(ms: number, locale: AppLocale): string {
  const unit = (value: number, name: 'millisecond' | 'second' | 'minute', digits = 0): string =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: name,
      unitDisplay: 'short',
      maximumFractionDigits: digits,
    }).format(value);
  if (ms < 1000) return unit(ms, 'millisecond');
  if (ms < 60_000) return unit(ms / 1000, 'second', 1);
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${unit(minutes, 'minute')} ${unit(seconds, 'second')}`;
}

/**
 * A cost in the reader's language and its currency (`$0.0123`); the amount and code as they are
 * when the currency is not one `Intl` knows. The amount is a decimal string, shown to 4 places.
 */
export function formatCost(cost: RecipeStepCost, locale: AppLocale): string {
  const amount = Number(cost.amount);
  if (!Number.isFinite(amount)) return `${cost.amount} ${cost.currency}`;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cost.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(amount);
  } catch {
    return `${cost.amount} ${cost.currency}`;
  }
}

/** Whether a run's graph polls again: until the run is stopped (completed, failed, cancelled). */
export function keepsPolling(run: RecipeRunView | null): boolean {
  return run === null || run.status === 'running' || run.status === 'waiting';
}

/**
 * What the live region says when a poll brings `next` after `previous`: each step whose status
 * changed (or that appeared), then the run's own change; `null` when nothing changed.
 */
export function changeAnnouncement(
  previous: RecipeRunDetail | null,
  next: RecipeRunDetail,
  strings: RecipeStrings,
): string | null {
  if (previous === null) return null;
  const before = new Map(previous.steps.map((step) => [step.key, step.status]));
  const steps = orderedSteps(next.steps)
    .filter((step) => before.get(step.key) !== step.status)
    .map((step) => strings.stepChanged(step.key, strings.stepStatus[step.status]));
  const run =
    previous.run.status === next.run.status
      ? []
      : [strings.runChanged(strings.runStatus[next.run.status])];
  const lines = [...steps, ...run];
  return lines.length === 0 ? null : lines.join(' ');
}
