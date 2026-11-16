/**
 * What the run detail says about a run's spend ceiling (ADR-0162 decision 7), and its words in
 * English and Japanese, in the shape of `./team-messages.ts`.
 *
 * The run view renders from the failure code, never the error text: a run whose
 * `parseRunFailure(run.error).code` is `run_budget_reached` stopped at its ceiling, and the amount
 * it names is `run.spendCeilingUsd`. A run with a ceiling whose cost is not priced
 * (`accountingState: 'unavailable'`) never reaches it, and the view says so.
 */
import { parseRunFailure, RUN_BUDGET_REACHED } from '@indx-workspace/contracts/runs';

import type { VersionsLocale } from '../agents/versions-messages';
import type { RunListItem } from './history';

export interface SpendCeilingStrings {
  /** The label of the ceiling beside the cost. */
  readonly spendCeiling: string;
  /** The sentence of a run the gateway stopped at its ceiling; `amount` is in USD. */
  readonly stopped: (amount: string) => string;
  /** The sentence of a run with a ceiling whose model has no price. */
  readonly unmeasured: string;
}

const EN: SpendCeilingStrings = {
  spendCeiling: 'Spend ceiling',
  stopped: (amount) => `Stopped at its spend ceiling (${amount} USD)`,
  unmeasured: "This run's model has no price, so its spend ceiling could not be enforced.",
};

const JA: SpendCeilingStrings = {
  spendCeiling: '利用上限',
  stopped: (amount) => `利用上限（${amount} USD）に達したため停止しました`,
  unmeasured: 'このランのモデルには価格がないため、利用上限を適用できませんでした。',
};

const STRINGS: Readonly<Record<VersionsLocale, SpendCeilingStrings>> = { en: EN, ja: JA };

export function spendCeilingStrings(locale: VersionsLocale): SpendCeilingStrings {
  return STRINGS[locale];
}

/** A stored six-place decimal as a person reads it: `0.500000` is `0.5`, `2.000000` is `2`. */
export function spendCeilingAmount(decimal: string): string {
  return decimal.includes('.') ? decimal.replace(/\.?0+$/u, '') : decimal;
}

export type SpendCeilingNotice =
  { readonly kind: 'stopped'; readonly amount: string } | { readonly kind: 'unmeasured' };

/** The notice a run's detail shows about its ceiling, or `null` when there is nothing to say. */
export function spendCeilingNotice(
  run: Pick<RunListItem, 'error' | 'spendCeilingUsd' | 'accountingState'>,
): SpendCeilingNotice | null {
  if (run.spendCeilingUsd === null) return null;
  if (parseRunFailure(run.error)?.code === RUN_BUDGET_REACHED) {
    return { kind: 'stopped', amount: spendCeilingAmount(run.spendCeilingUsd) };
  }
  return run.accountingState === 'unavailable' ? { kind: 'unmeasured' } : null;
}
