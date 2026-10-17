/**
 * The provisional budget cap's arithmetic (ENG-09, #308; ADR-0074 D7).
 */
import { describe, expect, it } from 'vitest';

import {
  OPENAI_AGENTS_PROVISIONAL_PRICES,
  openAiAgentsBudgetSpent,
  openAiAgentsPriceFor,
  openAiAgentsUsageCostMicros,
  type OpenAiAgentsBudget,
} from './budget.js';

const GPT_5 = OPENAI_AGENTS_PROVISIONAL_PRICES['gpt-5']!;

describe('the provisional price table', () => {
  it('prices a listed model and nothing else', () => {
    expect(openAiAgentsPriceFor('gpt-5')).toBe(GPT_5);
    expect(openAiAgentsPriceFor('gpt-unknown')).toBeNull();
    expect(openAiAgentsPriceFor('toString')).toBeNull();
    expect(openAiAgentsPriceFor(null)).toBeNull();
  });

  it('holds rates the gateway arithmetic accepts', () => {
    for (const price of Object.values(OPENAI_AGENTS_PROVISIONAL_PRICES)) {
      expect(() =>
        openAiAgentsUsageCostMicros(price, {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 1,
          reasoningTokens: null,
        }),
      ).not.toThrow();
    }
  });
});

describe('the estimate', () => {
  it('bills the cached share of the input at the cached rate, rounding half up', () => {
    // 800k uncached input at 1.25, 200k cached at 0.125, 100k output at 10: 1 + 0.025 + 1 USD.
    expect(
      openAiAgentsUsageCostMicros(GPT_5, {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cachedInputTokens: 200_000,
        reasoningTokens: 50_000,
      }),
    ).toBe(2_025_000n);
    // 8 * 1.25 + 2 * 0.125 + 5 * 10 = 60.25 micro-dollars, rounded to 60.
    expect(
      openAiAgentsUsageCostMicros(GPT_5, {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 2,
        reasoningTokens: 1,
      }),
    ).toBe(60n);
  });

  it('never bills more cached tokens than input tokens', () => {
    expect(
      openAiAgentsUsageCostMicros(GPT_5, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 5_000_000,
        reasoningTokens: null,
      }),
    ).toBe(125_000n);
  });
});

describe('the cap', () => {
  const budget: OpenAiAgentsBudget = { maxBudgetUsd: 0.000_1, model: 'gpt-5', price: GPT_5 };
  const usage = (responses: number) => ({
    inputTokens: 10 * responses,
    outputTokens: 5 * responses,
    cachedInputTokens: 2 * responses,
    reasoningTokens: null,
  });

  it('is not reached under it, and is reached at or above it', () => {
    expect(openAiAgentsBudgetSpent(budget, null)).toBe(false);
    expect(openAiAgentsBudgetSpent(budget, usage(1))).toBe(false);
    expect(openAiAgentsBudgetSpent(budget, usage(2))).toBe(true);
    expect(openAiAgentsBudgetSpent({ ...budget, maxBudgetUsd: 0.000_06 }, usage(1))).toBe(true);
  });
});
