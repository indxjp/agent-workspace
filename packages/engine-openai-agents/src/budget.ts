/**
 * The **provisional** per-run budget cap of the OpenAI Agents engine (ENG-09, #308; ADR-0074 D7).
 *
 * Pure and SDK-free. `./compile.ts` looks the run's model up in
 * {@link OPENAI_AGENTS_PROVISIONAL_PRICES} and refuses a cap it cannot price; `./boundary.ts` adds
 * each model response's usage, as the gateway reported it back, and stops the run with
 * `max_budget` once {@link openAiAgentsBudgetSpent} says the cap is reached.
 *
 * ## Why a table, and not the gateway's
 *
 * The table itself is `@agent-workspace/engine`'s `prices.ts` (ADR-0081), shared with the pi
 * adapter. The platform's authoritative prices are the gateway's `GATEWAY_PRICING_JSON`
 * (`packages/gateway/src/pricing.ts`), a deployment-owned catalogue that exists only in the gateway
 * process. This adapter may not import `packages/gateway` (an engine adapter depends only on the
 * port, `contracts` and its own SDK — `docs/architecture.md`), and the sandbox the adapter
 * runs in never sees the gateway's environment. So the cap is priced from that small table,
 * with the gateway's arithmetic (integer micro-dollars, rates as decimal strings per million
 * tokens). It is an **estimate that stops a run**, never a charge: settlement stays the gateway's
 * (`run_usage_records`, ADR-0065 D6).
 *
 * #342 moves budget enforcement into the gateway for every engine, priced from the real catalogue,
 * and retires this file.
 *
 * ## How usage is priced
 *
 * The SDK's usage is summed per response by `./frames.ts#addResponseUsage`. `inputTokens` counts
 * every input token, cached ones included (the Responses and Chat Completions shape), so the cached
 * share is billed at the cached rate and the rest at the input rate. Reasoning tokens are part of
 * `outputTokens`. A cap is reached when the estimate is **at or above** it; the response that
 * reaches it has already been paid for, so a run can overshoot its cap by at most one response.
 */
import {
  PROVISIONAL_MODEL_PRICES,
  PROVISIONAL_PRICES_CHECKED_ON,
  provisionalPriceFor,
  type ProvisionalModelPrice,
} from '@agent-workspace/engine';

import type { OpenAiAgentsUsage } from './frames.js';

/** One model's provisional rates, in USD per million tokens, as decimal strings. */
export type OpenAiAgentsPrice = ProvisionalModelPrice;

/**
 * The day the rates were last checked. The table is the port's since ENG-08 (#307, ADR-0081),
 * shared with the pi adapter rather than copied; these names are kept so every citation of them
 * still reads the same table.
 */
export const OPENAI_AGENTS_PRICES_CHECKED_ON = PROVISIONAL_PRICES_CHECKED_ON;

/** The models a cap can be priced for: `@agent-workspace/engine`'s `PROVISIONAL_MODEL_PRICES`. */
export const OPENAI_AGENTS_PROVISIONAL_PRICES: Readonly<Record<string, OpenAiAgentsPrice>> =
  PROVISIONAL_MODEL_PRICES;

/** A compiled cap: the limit, and the rates it is measured with. JSON, so it compiles. */
export type OpenAiAgentsBudget = {
  readonly maxBudgetUsd: number;
  readonly model: string;
  readonly price: OpenAiAgentsPrice;
};

/** The provisional rates of `model`, or `null` when it has none (or no model is named). */
export function openAiAgentsPriceFor(model: string | null): OpenAiAgentsPrice | null {
  return provisionalPriceFor(model);
}

const DECIMAL = /^(0|[1-9]\d{0,7})(?:\.(\d{1,6}))?$/u;

/** A per-million rate in micro-dollars, the gateway's `rateMicros`. */
function rateMicros(value: string): bigint {
  const match = DECIMAL.exec(value);
  if (match === null) throw new Error(`${value} is not a rate with at most six decimal places.`);
  return BigInt(match[1] ?? '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

function count(value: number | null): bigint {
  return value === null || !Number.isSafeInteger(value) || value < 0 ? 0n : BigInt(value);
}

/** The estimated cost of `usage`, in micro-dollars, rounded half up (the gateway's rounding). */
export function openAiAgentsUsageCostMicros(
  price: OpenAiAgentsPrice,
  usage: OpenAiAgentsUsage,
): bigint {
  const input = count(usage.inputTokens);
  const cached = count(usage.cachedInputTokens);
  const cachedShare = cached > input ? input : cached;
  const weighted =
    (input - cachedShare) * rateMicros(price.inputUsdPerMillion) +
    cachedShare * rateMicros(price.cachedInputUsdPerMillion) +
    count(usage.outputTokens) * rateMicros(price.outputUsdPerMillion);
  return (weighted + 500_000n) / 1_000_000n;
}

/** Has `usage` reached the cap? `null` usage (nothing reported yet) has not. */
export function openAiAgentsBudgetSpent(
  budget: OpenAiAgentsBudget,
  usage: OpenAiAgentsUsage | null,
): boolean {
  if (usage === null) return false;
  const cap = BigInt(Math.round(budget.maxBudgetUsd * 1_000_000));
  return openAiAgentsUsageCostMicros(budget.price, usage) >= cap;
}
