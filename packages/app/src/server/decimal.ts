/**
 * Exact addition of the platform's decimal amounts (issue #1522). A run's `cost.amount` is a
 * decimal string such as `"0.012345"`, never a float, so the dashboard's spend is summed here on
 * `BigInt`-scaled digits: `0.1 + 0.2` is `"0.3"`, not `0.30000000000000004`. Pure, with no
 * dependency.
 */

/** A non-negative decimal: digits, then optionally a point and digits. Bounded, so a sum is cheap. */
const DECIMAL = /^(\d{1,64})(?:\.(\d{1,32}))?$/u;

/** A decimal as an integer of units and the number of digits after its point. */
interface Scaled {
  readonly units: bigint;
  readonly scale: number;
}

function scaledOf(value: string): Scaled {
  const match = DECIMAL.exec(value);
  if (match === null) throw new RangeError('not a non-negative decimal string');
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function rescaled(value: Scaled, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function textOf(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  return `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
}

/** Whether `value` is a decimal string {@link addDecimal} adds. */
export function isDecimal(value: string): boolean {
  return DECIMAL.test(value);
}

/**
 * `a + b` exactly, for two non-negative decimal strings, at the larger of their two scales:
 * `addDecimal('0.1', '0.2')` is `'0.3'` and `addDecimal('0.000000', '0.10')` is `'0.100000'`.
 *
 * @throws {RangeError} when either is not a non-negative decimal string ({@link isDecimal}).
 */
export function addDecimal(a: string, b: string): string {
  const left = scaledOf(a);
  const right = scaledOf(b);
  const scale = Math.max(left.scale, right.scale);
  return textOf(rescaled(left, scale) + rescaled(right, scale), scale);
}
