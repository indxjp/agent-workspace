#!/usr/bin/env node
// Spare parts to order, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <stock.csv|stock.xlsx> <usage.csv|usage.xlsx> [--months <n>]
//
// It reads the stock list (one row per part: on hand, on order, lead time in days, order lot) and
// the usage log (one row per month and part: how many were used in repairs) with the built-in table
// reader (ADR-0173), and prints JSON on stdout. Over the window (the last `n` months of the log,
// default all of them), each part's use, its average per month (rounded half away from zero to two
// decimals), its reorder point (the use over the lead time plus one month of cover, rounded up:
// ceil(used × (lead days + 30) / (30 × months)), in whole numbers), what is available (on hand plus
// on order), what to order (the shortfall below the reorder point rounded up to a whole lot, 0 when
// none), and whether its use is rising (the last half of the window used more than the first half;
// with an odd window the middle month is in neither). A file, row, value or option it cannot read
// prints `{ "error", "message" }` on stderr and exits 1 (2 for the arguments): it never guesses. It
// writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';
const whole = (/** @type {string[]} */ names) => ({ names, type: /** @type {const} */ ('whole') });

/** The two exports' columns: the Japanese and the English name, and what a value must be. */
const STOCK = {
  partNo: ['部品番号', 'part_no'],
  partName: ['部品名', 'part_name'],
  equipment: ['設備', 'equipment'],
  onHand: whole(['在庫数', 'on_hand']),
  onOrder: whole(['発注残', 'on_order']),
  leadDays: whole(['調達日数', 'lead_days']),
  lot: whole(['発注単位', 'lot']),
};
const USAGE = {
  month: ['年月', 'month'],
  partNo: ['部品番号', 'part_no'],
  used: whole(['使用数', 'used']),
};

/** The command line `run_skill_script` passes: the two exports, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <stock.csv|stock.xlsx> <usage.csv|usage.xlsx> [--months <n>]',
  positionals: ['stock', 'usage'],
  options: { months: {} },
};

/**
 * Refuse a row of `table` that `problem` names (`[code, column, why]`), or whose `key` repeats.
 * @template {Record<string, string | number>} R
 * @param {{ rows: readonly R[], rowNumbers: readonly number[] }} table
 * @param {(row: R) => string} key
 * @param {(row: R) => [string, string, string] | null} problem
 */
function check({ rows, rowNumbers }, key, problem) {
  const seen = new Set();
  for (const [at, row] of rows.entries()) {
    const found =
      problem(row) ?? (seen.has(key(row)) ? ['duplicate_row', 'part_no', 'appears twice'] : null);
    const where = { row: Number(rowNumbers[at]) };
    seen.add(key(row));
    if (found === null) continue;
    const [code, column, why] = found;
    throw new TableError(code, `row ${String(where.row)}: ${key(row)} ${why}`, {
      ...where,
      column,
    });
  }
}

/**
 * The suggestion from the stock list and the usage log; `rowNumbers[i]` is where `rows[i]` is.
 * @param {{ rows: readonly { partNo: string, partName: string, equipment: string, onHand: number, onOrder: number, leadDays: number, lot: number }[], rowNumbers: readonly number[] }} stock
 * @param {{ rows: readonly { month: string, partNo: string, used: number }[], rowNumbers: readonly number[] }} usage
 * @param {Readonly<{ months?: string }>} options `months`: how many of the last months to use
 * @throws {TableError}
 */
export function analyse(stock, usage, options) {
  const limits = /** @type {const} */ ([
    ['onHand', 'on_hand', 0],
    ['onOrder', 'on_order', 0],
    ['leadDays', 'lead_days', 0],
    ['lot', 'lot', 1],
  ]);
  /** @type {(row: { onHand: number, onOrder: number, leadDays: number, lot: number }) => [string, string, string] | null} */
  const range = (row) => {
    const [, column, min] = limits.find(([key, , least]) => row[key] < least) ?? [];
    return column === undefined ? null : ['out_of_range', column, `has ${column} below ${min}`];
  };
  check(stock, (row) => row.partNo, range);
  const known = new Set(stock.rows.map((row) => row.partNo));
  check(
    usage,
    (row) => `${row.month} ${row.partNo}`,
    (row) => {
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(row.month))
        return ['not_a_month', 'month', 'has no YYYY-MM month'];
      if (!known.has(row.partNo)) return ['unknown_part', 'part_no', 'is not in the stock list'];
      return row.used < 0 ? ['out_of_range', 'used', 'has a negative amount'] : null;
    },
  );
  const all = [...new Set(usage.rows.map((row) => row.month))].sort();
  if (all.length === 0)
    throw new TableError('no_rows', 'the usage log has no rows under its header');
  const count = options.months ?? String(all.length);
  if (!/^\d+$/u.test(count) || Number(count) < 1 || Number(count) > all.length)
    throw new TableError('usage', `--months "${count}" is not between 1 and ${String(all.length)}`);
  const months = all.slice(-Number(count));
  const half = Math.floor(months.length / 2);
  const usedIn = (/** @type {string} */ part, /** @type {readonly string[]} */ window) =>
    usage.rows
      .filter((row) => row.partNo === part && window.includes(row.month))
      .reduce((sum, row) => sum + row.used, 0);
  const parts = stock.rows.map(({ onHand, onOrder, leadDays, lot, ...named }) => {
    const used = usedIn(named.partNo, months);
    const reorderPoint = Math.ceil((used * (leadDays + 30)) / (30 * months.length));
    const available = onHand + onOrder;
    const order = available < reorderPoint ? Math.ceil((reorderPoint - available) / lot) * lot : 0;
    const avgMonthly = Math.round((used * 100) / months.length) / 100;
    const [first, last] = [months.slice(0, half), months.slice(months.length - half)];
    const rising = usedIn(named.partNo, last) > usedIn(named.partNo, first);
    const coveredByOrder = order === 0 && onHand < reorderPoint;
    const stocked = { onHand, onOrder, available, coveredByOrder };
    return { ...named, used, avgMonthly, reorderPoint, ...stocked, order, rising };
  });
  const trend = months.map((month) => ({
    month,
    used: usage.rows.reduce((sum, row) => sum + (row.month === month ? row.used : 0), 0),
  }));
  const toOrder = parts.filter((part) => part.order > 0);
  return { from: months[0], to: months.at(-1), months: months.length, toOrder, trend, parts };
}

/**
 * The command line: read the stock list and the usage log, then analyse them with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(
    readTable(String(positionals['stock']), { columns: STOCK }),
    readTable(String(positionals['usage']), { columns: USAGE }),
    options,
  );

runWhenMain(import.meta.url, SPEC, compute);
