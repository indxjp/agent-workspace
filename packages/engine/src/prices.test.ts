/**
 * The provisional price table the adapter-level budget caps share (ADR-0074 D7, ADR-0081 D6).
 */
import { describe, expect, it } from 'vitest';

import { PROVISIONAL_MODEL_PRICES, provisionalPriceFor } from './prices.js';

describe('provisionalPriceFor', () => {
  it('prices a listed model and nothing else', () => {
    expect(provisionalPriceFor('claude-sonnet-4-5')).toEqual({
      inputUsdPerMillion: '3',
      outputUsdPerMillion: '15',
      cachedInputUsdPerMillion: '0.3',
    });
    expect(provisionalPriceFor('claude-unlisted')).toBeNull();
    expect(provisionalPriceFor(null)).toBeNull();
  });

  it('does not price a key inherited from Object.prototype', () => {
    expect(provisionalPriceFor('toString')).toBeNull();
    expect(provisionalPriceFor('__proto__')).toBeNull();
  });

  it('states every rate as a decimal the gateway arithmetic can read', () => {
    for (const price of Object.values(PROVISIONAL_MODEL_PRICES)) {
      for (const rate of Object.values(price)) {
        expect(rate).toMatch(/^(0|[1-9]\d{0,7})(\.\d{1,6})?$/u);
      }
    }
  });
});
