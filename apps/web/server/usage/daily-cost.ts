/**
 * The workspace's daily cost cap at run start (`policy.maxCostPerDayUsd`, ADR-0102 SD6, issue
 * #1851): the wiring that gives the run API the cap's refusal. The rule itself (the UTC-day spend,
 * the per-workspace cache, the unpriced rule, fail-closed on an unreadable sum) is the one the
 * gateway shares, `@agent-workspace/core/daily-cost`.
 */
import {
  createDailyCostRule,
  type DailyCostCapRefusal,
  type DailyCostRuleDependencies,
} from '@agent-workspace/core/daily-cost';

/** The cap a run start consults; absent from the environment when the policy sets none. */
export interface DailyCostCap {
  /** `null` while the workspace is under the cap today. Rejects when the spend cannot be read. */
  readonly refusal: (workspaceId: string) => Promise<DailyCostCapRefusal | null>;
}

export interface DailyCostDependencies extends DailyCostRuleDependencies {
  readonly capUsd: number;
}

/** Build the daily cost cap for a policy that sets `maxCostPerDayUsd`. */
function createDailyCost({ capUsd, ...rule }: DailyCostDependencies): DailyCostCap {
  const { refusal } = createDailyCostRule(rule);
  return { refusal: (workspaceId) => refusal(workspaceId, capUsd) };
}

/**
 * The run API environment's `dailyCostCap` member for a policy's `maxCostPerDayUsd`: nothing when
 * the policy sets no cap, so with none no spend is ever read.
 */
export function dailyCostCapEnvironment(
  capUsd: number | undefined,
  dependencies: Omit<DailyCostDependencies, 'capUsd'>,
): { readonly dailyCostCap?: DailyCostCap } {
  return capUsd === undefined ? {} : { dailyCostCap: createDailyCost({ ...dependencies, capUsd }) };
}
