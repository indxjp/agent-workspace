import { describe, expect, it } from 'vitest';

import { calculateUsageCost, parsePricingCatalog, priceFor } from './pricing.js';

describe('versioned gateway pricing', () => {
  it('calculates exact micro-dollar cost without floating-point arithmetic', () => {
    expect(
      calculateUsageCost(
        {
          inputUsdPerMillion: '3',
          outputUsdPerMillion: '15',
          cacheReadUsdPerMillion: '0.30',
          cacheCreationUsdPerMillion: '3.75',
        },
        {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadInputTokens: 500_000,
          cacheCreationInputTokens: 200_000,
        },
      ),
    ).toBe('5.400000');
  });

  it('rounds to the database micro-dollar scale', () => {
    expect(
      calculateUsageCost(
        { inputUsdPerMillion: '0.500000', outputUsdPerMillion: '0' },
        { inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      ),
    ).toBe('0.000001');
  });

  it('parses exact and wildcard prices from an immutable catalogue', () => {
    const catalog = parsePricingCatalog(
      JSON.stringify({
        version: 'prices-2026-09-10',
        models: {
          'anthropic:claude-exact': {
            inputUsdPerMillion: '3',
            outputUsdPerMillion: '15',
          },
          'openai:*': { inputUsdPerMillion: '2', outputUsdPerMillion: '8' },
        },
      }),
    );
    expect(priceFor(catalog, 'anthropic', 'claude-exact').inputUsdPerMillion).toBe('3');
    expect(priceFor(catalog, 'openai', 'future-model').outputUsdPerMillion).toBe('8');
    expect(() => priceFor(catalog, 'azure-openai', 'missing')).toThrow(/refusing zero-cost/u);
  });

  it.each([undefined, '', '{}', '{bad json', '{"version":"v","models":{}}'])(
    'fails closed for unusable catalogue %s',
    (raw) => {
      expect(() => parsePricingCatalog(raw)).toThrow();
    },
  );
});
