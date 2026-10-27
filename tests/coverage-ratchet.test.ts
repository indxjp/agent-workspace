import { describe, expect, it } from 'vitest';

import {
  parseFloors,
  parseMeasured,
  TOLERANCE,
  verdict,
} from '../scripts/check-coverage-ratchet.mjs';

describe('the coverage ratchet verdict', () => {
  it('holds while the floor is at or just under the measured value', () => {
    expect(verdict('lines', 85, 88.08, 85)).toEqual({ failure: null, warning: null });
    expect(verdict('lines', 85, 85 + TOLERANCE, undefined)).toEqual({
      failure: null,
      warning: null,
    });
  });

  it('passes a raised or equal floor', () => {
    expect(verdict('lines', 86, 88, 85).failure).toBeNull();
    expect(verdict('lines', 85, 88, 85).failure).toBeNull();
  });

  it('fails a lowered floor, even by one point', () => {
    expect(verdict('lines', 84, 88, 85).failure).toMatch(/lowered from 85% to 84%/u);
  });

  it('skips the lowering comparison when there is no base', () => {
    expect(verdict('lines', 1, 1, undefined).failure).toBeNull();
  });

  it('fails when coverage is under the floor', () => {
    expect(verdict('branches', 74, 73.9, 74).failure).toMatch(/below the floor/u);
  });

  it('only warns when the floor trails the measured value', () => {
    const { failure, warning } = verdict('lines', 60, 88.08, 60);
    expect(failure).toBeNull();
    expect(warning).toMatch(/raise it to about 85/u);
  });
});

describe('the coverage ratchet inputs', () => {
  const config = `thresholds: {
        // comment
        lines: 20,
        functions: 21,
        statements: 22.5,
        branches: 15,
      },`;

  it('reads the four floors', () => {
    expect(parseFloors(config)).toEqual({
      lines: 20,
      functions: 21,
      statements: 22.5,
      branches: 15,
    });
  });

  it('fails closed on a config or summary it cannot read', () => {
    expect(() => parseFloors('export default {}')).toThrow(/thresholds/u);
    expect(() => parseFloors('thresholds: { lines: 1, }')).toThrow(/functions/u);
    expect(() => parseMeasured({})).toThrow(/lines/u);
    expect(() => parseMeasured(null)).toThrow(/lines/u);
    const pct = { pct: 1 };
    expect(
      parseMeasured({ total: { lines: pct, functions: pct, statements: pct, branches: pct } }),
    ).toEqual({
      lines: 1,
      functions: 1,
      statements: 1,
      branches: 1,
    });
  });
});
