/**
 * The demo run caps' rules: pure functions, no I/O (AGENTS.md, hexagonal rule 1). Time is an
 * argument, never read here.
 */
import { utcDayStart } from '@agent-workspace/core/daily-cost';
import {
  DEMO_RUN_WINDOW_SECONDS,
  type DemoRunStartProblemCode,
} from '@indx-workspace/contracts/demo';

import type { DemoAdmission } from '../ports';

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 24 * 60 * 60 * MS_PER_SECOND;

/** The caps a deployment sets; `null` is a cap its operator has not set. */
export interface DemoCapSettings {
  readonly runsPerPersonPerDay: number;
  readonly runsPerClientPerDay: number;
  readonly maxTurnsPerRun: number | null;
  readonly maxCostPerRunUsd: number | null;
  readonly siteMaxCostPerDayUsd: number | null;
}

/**
 * Whether a cap the spec leaves to configuration is unset: the per-run turns and cost, and the
 * site's daily cost. A demo with one unset starts no run at all (fail closed).
 */
export function capsUnconfigured(settings: DemoCapSettings): boolean {
  return (
    settings.maxTurnsPerRun === null ||
    settings.maxCostPerRunUsd === null ||
    settings.siteMaxCostPerDayUsd === null
  );
}

/** The end of the UTC day that starts at `dayStart` (its start is `utcDayStart` of any time in it). */
export function utcDayEnd(dayStart: Date): Date {
  return new Date(utcDayStart(dayStart).getTime() + MS_PER_DAY);
}

/** The start of the rolling window the per-person and per-client counts look back over. */
export function admissionWindowStart(now: Date): Date {
  return new Date(now.getTime() - DEMO_RUN_WINDOW_SECONDS * MS_PER_SECOND);
}

/** The refusal an admission that was not granted names. */
export function admissionRefusal(
  admission: Exclude<DemoAdmission, { readonly kind: 'admitted' }>,
): DemoRunStartProblemCode {
  return admission.kind === 'person_limit'
    ? 'demo_person_runs_reached'
    : 'demo_client_runs_reached';
}
