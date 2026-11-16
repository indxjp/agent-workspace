/**
 * A run tree's cost (ADR-0104 acceptance decision 7; spec 04 §5.12 "Run trees"): the root's
 * `cost.amount` plus each child's, summed at read time with exact decimal arithmetic. There is no
 * stored total, so the sum cannot disagree with its parts, and no float ever touches money.
 *
 * Pure: no I/O, no clock. Amounts are the non-negative decimal strings `runs.cost_usd`
 * (`numeric(14, 6)`) renders as; anything else is a broken invariant and throws.
 */

/** A non-negative decimal: digits, optionally a point and more digits. */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/u;

interface Scaled {
  readonly units: bigint;
  readonly scale: number;
}

function parseAmount(amount: string): Scaled {
  const match = DECIMAL.exec(amount);
  if (match === null) {
    throw new Error(`${JSON.stringify(amount)} is not a non-negative decimal amount`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function render(units: bigint, scale: number): string {
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/**
 * The exact sum of `amounts`, at the largest scale any of them carries (`'0.010000'` and
 * `'0.000500'` sum to `'0.010500'`). An empty list sums to `'0'`.
 */
export function sumDecimalAmounts(amounts: readonly string[]): string {
  const parsed = amounts.map(parseAmount);
  const scale = parsed.reduce((widest, each) => Math.max(widest, each.scale), 0);
  const total = parsed.reduce(
    (sum, each) => sum + each.units * 10n ** BigInt(scale - each.scale),
    0n,
  );
  return render(total, scale);
}

/** A rendered run's cost, as far as the tree sum reads it. */
interface Costed {
  readonly cost: { readonly amount: string; readonly currency: string };
}

/**
 * `treeCost` for a root and its children. Every run of this release is priced in one currency
 * (`runs.cost_currency` holds only `USD`); a tree that mixed two would have no single sum, so it
 * throws rather than add unlike amounts.
 */
export function treeCostOf(
  root: Costed,
  children: readonly Costed[],
): { readonly amount: string; readonly currency: string } {
  const currency = root.cost.currency;
  const mixed = children.find((child) => child.cost.currency !== currency);
  if (mixed !== undefined) {
    throw new Error(
      `a run tree mixes ${currency} and ${mixed.cost.currency}; its cost has no single sum`,
    );
  }
  return {
    amount: sumDecimalAmounts([root.cost.amount, ...children.map((child) => child.cost.amount)]),
    currency,
  };
}
