import { describe, expect, it } from 'vitest';

import { effectiveSpendCeiling } from './spend-ceiling';

describe('effectiveSpendCeiling (ADR-0162 decision 2)', () => {
  it('is the lowest value that is set, as a six-place decimal', () => {
    expect(effectiveSpendCeiling(2, undefined, 0.5)).toEqual({
      kind: 'ok',
      spendCeilingUsd: '0.500000',
    });
    expect(effectiveSpendCeiling(2, 1.25, undefined)).toEqual({
      kind: 'ok',
      spendCeilingUsd: '1.250000',
    });
    expect(effectiveSpendCeiling(null, undefined, 3)).toEqual({
      kind: 'ok',
      spendCeilingUsd: '3.000000',
    });
    expect(effectiveSpendCeiling(0.75, null, undefined)).toEqual({
      kind: 'ok',
      spendCeilingUsd: '0.750000',
    });
  });

  it('is no ceiling when nothing sets one', () => {
    expect(effectiveSpendCeiling(null, undefined, undefined)).toEqual({
      kind: 'ok',
      spendCeilingUsd: null,
    });
  });

  it('refuses a requested ceiling above the limit, and accepts one equal to it', () => {
    expect(effectiveSpendCeiling(1, undefined, 1.000001)).toEqual({ kind: 'widens' });
    expect(effectiveSpendCeiling(1, undefined, 1)).toEqual({
      kind: 'ok',
      spendCeilingUsd: '1.000000',
    });
  });

  it('never stores zero and never stores more than the column holds', () => {
    expect(effectiveSpendCeiling(0.0000001, undefined, undefined)).toEqual({
      kind: 'ok',
      spendCeilingUsd: '0.000001',
    });
    expect(effectiveSpendCeiling(1e12, undefined, undefined)).toEqual({
      kind: 'ok',
      spendCeilingUsd: '99999999.999999',
    });
  });
});
