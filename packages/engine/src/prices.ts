/**
 * The **provisional** model price table every adapter-level budget cap is measured with
 * (ADR-0074 D7, shared since ENG-08 #307 / ADR-0081).
 *
 * Pure and SDK-free. It was the OpenAI Agents adapter's own (`budget.ts`) until pi became the
 * second engine to enforce `maxBudgetUsd` in its adapter; two adapters may not import each other
 * (`docs/architecture.md`), so the one table lives in the port rather than being copied.
 *
 * ## Why a table here, and not the gateway's
 *
 * The platform's authoritative prices are the gateway's `GATEWAY_PRICING_JSON`
 * (`packages/gateway/src/pricing.ts`), a deployment-owned catalogue that exists only in the gateway
 * process. An adapter may not import `packages/gateway`, and the sandbox it runs in never sees the
 * gateway's environment. So a cap is priced from the small table below. It is an **estimate that
 * stops a run**, never a charge: settlement stays the gateway's (`run_usage_records`,
 * ADR-0065 D6). #342 moves budget enforcement into the gateway for every engine and retires this
 * file.
 */

/** One model's provisional rates, in USD per million tokens, as decimal strings. */
export type ProvisionalModelPrice = {
  readonly inputUsdPerMillion: string;
  readonly outputUsdPerMillion: string;
  readonly cachedInputUsdPerMillion: string;
};

/** The day the rates below were last checked against the providers' public list prices. */
export const PROVISIONAL_PRICES_CHECKED_ON = '2026-09-29';

/**
 * The models a cap can be priced for, keyed by the model id the agent or the run names. A model
 * absent here is refused at compile time when the run carries a cap: an unpriced cap is a cap that
 * would never stop anything.
 */
export const PROVISIONAL_MODEL_PRICES: Readonly<Record<string, ProvisionalModelPrice>> = {
  'gpt-5': {
    inputUsdPerMillion: '1.25',
    outputUsdPerMillion: '10',
    cachedInputUsdPerMillion: '0.125',
  },
  'gpt-5-mini': {
    inputUsdPerMillion: '0.25',
    outputUsdPerMillion: '2',
    cachedInputUsdPerMillion: '0.025',
  },
  'gpt-4.1': { inputUsdPerMillion: '2', outputUsdPerMillion: '8', cachedInputUsdPerMillion: '0.5' },
  'gpt-4.1-mini': {
    inputUsdPerMillion: '0.4',
    outputUsdPerMillion: '1.6',
    cachedInputUsdPerMillion: '0.1',
  },
  'gpt-4o': {
    inputUsdPerMillion: '2.5',
    outputUsdPerMillion: '10',
    cachedInputUsdPerMillion: '1.25',
  },
  'gpt-4o-mini': {
    inputUsdPerMillion: '0.15',
    outputUsdPerMillion: '0.6',
    cachedInputUsdPerMillion: '0.075',
  },
  'claude-opus-5': {
    inputUsdPerMillion: '5',
    outputUsdPerMillion: '25',
    cachedInputUsdPerMillion: '0.5',
  },
  'claude-sonnet-5': {
    inputUsdPerMillion: '2',
    outputUsdPerMillion: '10',
    cachedInputUsdPerMillion: '0.2',
  },
  'claude-sonnet-4-5': {
    inputUsdPerMillion: '3',
    outputUsdPerMillion: '15',
    cachedInputUsdPerMillion: '0.3',
  },
  'claude-haiku-4-5': {
    inputUsdPerMillion: '1',
    outputUsdPerMillion: '5',
    cachedInputUsdPerMillion: '0.1',
  },
};

/** The provisional rates of `model`, or `null` when it has none (or no model is named). */
export function provisionalPriceFor(model: string | null): ProvisionalModelPrice | null {
  if (model === null || !Object.hasOwn(PROVISIONAL_MODEL_PRICES, model)) return null;
  return PROVISIONAL_MODEL_PRICES[model] ?? null;
}
