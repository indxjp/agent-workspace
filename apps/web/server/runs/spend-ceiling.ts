/**
 * A run's spend ceiling at start (ADR-0162 decision 2): the lowest of the limit the run composes
 * with (the agent's `limits.maxBudgetUsd` met with the deployment ceiling's), a trusted in-process
 * override, and the start's `spendCeilingUsd`. The start's value only narrows: one above the limit
 * is refused, as ADR-0102 SD6 refuses any explicit value above the ceiling.
 */

/** The largest value `runs.spend_ceiling_usd` (`numeric(14,6)`) holds. */
const MAX_STORED_MICROS = 99_999_999_999_999;

export type SpendCeilingDecision =
  { readonly kind: 'ok'; readonly spendCeilingUsd: string | null } | { readonly kind: 'widens' };

/**
 * A positive USD amount as the six-place decimal the column stores. A limit finer than a
 * micro-dollar rounds to the nearest one but never to zero, and one above the column's range
 * (a policy that means "no practical cap") is stored at the column's largest value.
 */
function toStoredDecimal(usd: number): string {
  const micros = Math.min(MAX_STORED_MICROS, Math.max(1, Math.round(usd * 1_000_000)));
  const whole = Math.floor(micros / 1_000_000);
  const fraction = micros - whole * 1_000_000;
  return `${String(whole)}.${String(fraction).padStart(6, '0')}`;
}

export function effectiveSpendCeiling(
  limitUsd: number | null,
  overrideUsd: number | null | undefined,
  requestedUsd: number | undefined,
): SpendCeilingDecision {
  if (requestedUsd !== undefined && limitUsd !== null && requestedUsd > limitUsd) {
    return { kind: 'widens' };
  }
  const set = [limitUsd, overrideUsd, requestedUsd].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  return {
    kind: 'ok',
    spendCeilingUsd: set.length === 0 ? null : toStoredDecimal(Math.min(...set)),
  };
}

/** The message a start whose `spendCeilingUsd` is above its limit is refused with. */
export const SPEND_CEILING_WIDENS_MESSAGE =
  "spendCeilingUsd is above this run's limit (the agent's or the deployment ceiling's limits.maxBudgetUsd); it can only lower the ceiling.";
