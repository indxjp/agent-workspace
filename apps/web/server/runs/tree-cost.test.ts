import { describe, expect, it } from 'vitest';

import { sumDecimalAmounts, treeCostOf } from './tree-cost';

const usd = (amount: string) => ({ cost: { amount, currency: 'USD' } });

describe('sumDecimalAmounts', () => {
  it('adds exactly, at the widest scale, where a float would not', () => {
    expect(sumDecimalAmounts(['0.100000', '0.200000'])).toBe('0.300000');
    expect(sumDecimalAmounts(['0.010000', '0.000500'])).toBe('0.010500');
    expect(sumDecimalAmounts(['12', '0.5'])).toBe('12.5');
    expect(sumDecimalAmounts(['99999999.999999', '0.000001'])).toBe('100000000.000000');
  });

  it('sums nothing to zero and one amount to itself', () => {
    expect(sumDecimalAmounts([])).toBe('0');
    expect(sumDecimalAmounts(['0.000000'])).toBe('0.000000');
  });

  it('refuses an amount that is not a non-negative decimal', () => {
    for (const bad of ['-1', '1e3', '', '.5', '1.', 'NaN']) {
      expect(() => sumDecimalAmounts([bad]), bad).toThrow(/not a non-negative decimal/u);
    }
  });
});

describe('treeCostOf', () => {
  it('is the root alone for a run with no children', () => {
    expect(treeCostOf(usd('0.012000'), [])).toEqual({ amount: '0.012000', currency: 'USD' });
  });

  it('adds every child to the root', () => {
    expect(treeCostOf(usd('0.012000'), [usd('0.003000'), usd('0.000250')])).toEqual({
      amount: '0.015250',
      currency: 'USD',
    });
  });

  it('refuses a tree priced in two currencies', () => {
    expect(() => treeCostOf(usd('1'), [{ cost: { amount: '1', currency: 'EUR' } }])).toThrow(
      /no single sum/u,
    );
  });
});
