import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { addDecimal, isDecimal } from './decimal.js';

/** A decimal string of `units` at `scale`, written the long way, as a reference to check against. */
function written(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

const scaled = fc.record({
  units: fc.bigInt({ min: 0n, max: 10n ** 30n }),
  scale: fc.integer({ min: 0, max: 12 }),
});

describe('addDecimal', () => {
  it('adds exactly where a float does not', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(addDecimal('0.000000', '0.10')).toBe('0.100000');
    expect(addDecimal('9.999999', '0.000001')).toBe('10.000000');
    expect(addDecimal('12', '0.5')).toBe('12.5');
    expect(addDecimal('0', '0')).toBe('0');
    expect(addDecimal('007', '1')).toBe('8');
  });

  it('agrees with BigInt-scaled arithmetic for any two decimals', () => {
    fc.assert(
      fc.property(scaled, scaled, (a, b) => {
        const scale = Math.max(a.scale, b.scale);
        const expected =
          a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale);
        const sum = addDecimal(written(a.units, a.scale), written(b.units, b.scale));
        expect(sum).toBe(written(expected, scale));
        expect(addDecimal(written(b.units, b.scale), written(a.units, a.scale))).toBe(sum);
      }),
    );
  });

  it('refuses what is not a non-negative decimal string', () => {
    for (const bad of ['', '-1', '1e3', '1.', '.5', '0x10', ' 1', 'NaN', '1,5']) {
      expect(isDecimal(bad)).toBe(false);
      expect(() => addDecimal(bad, '1')).toThrow(RangeError);
      expect(() => addDecimal('1', bad)).toThrow(RangeError);
    }
    expect(isDecimal('0.000000')).toBe(true);
  });
});
