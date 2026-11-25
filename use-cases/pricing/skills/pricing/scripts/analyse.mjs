#!/usr/bin/env node
// What a price change did before, and what the same response would mean for a new one, by rule, as
// `run_skill_script` runs it (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <sales.csv|sales.xlsx> --change <percent>
//
// It reads a monthly sales export (one row per month and product: the unit price in whole yen and
// the quantity sold) with the built-in table reader (ADR-0173) and prints JSON on stdout. For each
// product, every month whose price differs from the product's month before it in the export is a
// past price change, with its arc elasticity: the change in quantity over the change in price, each
// relative to the two months' midpoint. The product's elasticity is their mean, rounded to two
// decimals. Applied to the last month's price and quantity, a `--change` of the price (a percent,
// -50 to 50) gives the new price (rounded to whole yen), the estimated quantity (the quantity × (1 +
// elasticity × change / 100), rounded, never below 0) and revenue, and the change in revenue in yen
// and as a percent (one decimal; null when the last month sold nothing); `total` adds up the
// products estimated. This is a straight-line reading of past changes, not a forecast. A product
// whose price never changed has no estimate (`noHistory`). A file, row, value or option it cannot
// read prints `{ "error", "message" }` on stderr and exits 1 (2 for the arguments): it never
// guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

const COLUMNS = /** @type {const} */ ({
  month: ['年月', 'month'],
  productCode: ['商品コード', 'product_code'],
  productName: ['商品名', 'product_name'],
  price: { names: ['単価', 'price'], type: 'whole' },
  quantity: { names: ['数量', 'quantity'], type: 'whole' },
});

/** The command line `run_skill_script` passes: the export, then the change of price. */
export const SPEC = {
  usage: 'analyse.mjs <sales.csv|sales.xlsx> --change <percent>',
  positionals: ['file'],
  options: { change: {} },
};

/** `value` rounded half away from zero to `places` decimals. */
const round = (/** @type {number} */ value, /** @type {number} */ places) =>
  (Math.sign(value) * Math.round(Math.abs(value) * 10 ** places)) / 10 ** places;

/**
 * The estimate for each product of the export's rows; `rowNumbers[i]` is where `rows[i]` is.
 * @param {{ rows: readonly { month: string, productCode: string, productName: string, price: number, quantity: number }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ change?: string }>} options `change`: the change of price, a percent
 * @throws {TableError}
 */
export function analyse({ rows, rowNumbers }, options) {
  const text = String(options.change);
  const change = /^[+-]?\d+(?:\.\d)?$/u.test(text) ? Number(text) : Number.NaN;
  if (!(Math.abs(change) <= 50))
    throw new TableError('usage', `--change "${text}" is not a percent from -50 to 50`);
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  const seen = new Set();
  for (const [at, row] of rows.entries()) {
    const id = `${row.month} ${row.productCode}`;
    const problem = !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(row.month)
      ? 'not_a_month'
      : seen.has(id)
        ? 'duplicate_row'
        : (row.price < 1 || row.quantity < 0) && 'out_of_range';
    const where = { row: Number(rowNumbers[at]) };
    if (problem)
      throw new TableError(problem, `row ${String(where.row)}: ${id}: ${problem}`, where);
    seen.add(id);
  }
  const sorted = [...rows].sort((a, b) => a.month.localeCompare(b.month));
  const codes = [...new Set(sorted.map((row) => row.productCode))];
  const estimates = codes.map((code) => {
    const own = sorted.filter((row) => row.productCode === code);
    const changes = own.slice(1).flatMap((now, at) => {
      const before = /** @type {(typeof own)[number]} */ (own[at]);
      if (now.price === before.price) return [];
      const sold = before.quantity + now.quantity;
      const quantityShift = sold === 0 ? 0 : (now.quantity - before.quantity) / sold;
      const priceShift = (now.price - before.price) / (now.price + before.price);
      const elasticity = round(quantityShift / priceShift, 2);
      return [{ month: now.month, fromPrice: before.price, toPrice: now.price, elasticity }];
    });
    const last = /** @type {(typeof own)[number]} */ (own.at(-1));
    const { productName, price, quantity } = last;
    if (changes.length === 0) return { productCode: code, productName, changes };
    const elasticity = round(changes.reduce((sum, c) => sum + c.elasticity, 0) / changes.length, 2);
    const newPrice = Math.round((price * (100 + change)) / 100);
    const estQuantity = Math.max(0, Math.round(quantity * (1 + (elasticity * change) / 100)));
    const [revenue, estRevenue] = [price * quantity, newPrice * estQuantity];
    const revenueChange = estRevenue - revenue;
    const revenueChangePct = revenue === 0 ? null : round((revenueChange * 100) / revenue, 1);
    const estimate = { newPrice, estQuantity, estRevenue, revenueChange, revenueChangePct };
    return {
      productCode: code,
      productName,
      price,
      quantity,
      revenue,
      elasticity,
      changes,
      ...estimate,
    };
  });
  const months = [...new Set(sorted.map((row) => row.month))];
  const trend = months.map((month) => ({
    month,
    revenue: sorted.reduce(
      (sum, row) => sum + (row.month === month ? row.price * row.quantity : 0),
      0,
    ),
  }));
  const products = estimates.filter((product) => 'elasticity' in product);
  const noHistory = estimates
    .filter((product) => !('elasticity' in product))
    .map(({ productCode, productName }) => ({ productCode, productName }));
  const sum = (/** @type {'revenue' | 'estRevenue'} */ key) =>
    products.reduce((total, product) => total + Number(product[key]), 0);
  const total = { revenue: sum('revenue'), estRevenue: sum('estRevenue') };
  const totalChange = { ...total, revenueChange: total.estRevenue - total.revenue };
  return {
    change,
    from: months[0],
    to: months.at(-1),
    products,
    total: totalChange,
    noHistory,
    trend,
  };
}

/**
 * The command line: read the export named first, then estimate with the change of price.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
