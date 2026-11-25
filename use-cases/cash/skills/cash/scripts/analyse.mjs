#!/usr/bin/env node
// A 13-week cash forecast, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <flows.csv|flows.xlsx> <balances.csv|balances.xlsx> [--minimum <yen>]
//
// It reads the bank balances (one row per account, all as of one date) and the scheduled receipts
// and payments (one row per flow; the Japanese or the English column names) with the built-in table
// reader (ADR-0173) and prints JSON on stdout: the opening balance (the accounts' sum), then 13
// weeks from the day after the balance date, each ending on its seventh day, with its receipts,
// payments, net flow and closing balance, and whether that closing is below the minimum (default
// 0); the lowest week; the weeks below the minimum; and the file rows of the flows outside those
// weeks (on or before the balance date, which the balance already holds, or after the 13th week).
// A file, row, column, value or option it cannot read prints `{ "error", "message" }` on stderr and
// exits 1 (2 for the arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The flows' columns: the Japanese and the English name, and what a value must be. */
const FLOWS = /** @type {const} */ ({
  date: { names: ['予定日', 'date'], type: 'date' },
  direction: ['区分', 'direction'],
  counterparty: ['取引先', 'counterparty'],
  amount: { names: ['金額', 'amount'], type: 'whole' },
});
/** The balances' columns. */
const BALANCES = /** @type {const} */ ({
  asOf: { names: ['基準日', 'as_of'], type: 'date' },
  account: ['口座', 'account'],
  balance: { names: ['残高', 'balance'], type: 'whole' },
});
/** A flow's direction as the export writes it: a receipt adds, a payment subtracts. */
const SIGN = new Map([
  ['入金', 1],
  ['in', 1],
  ['出金', -1],
  ['out', -1],
]);
const WEEKS = 13;
const DAY_MS = 86_400_000;

/** The command line `run_skill_script` passes: the two exports, then the option. */
export const SPEC = {
  usage: 'analyse.mjs <flows.csv|flows.xlsx> <balances.csv|balances.xlsx> [--minimum <yen>]',
  positionals: ['flows', 'balances'],
  options: { minimum: { default: '0' } },
};

/**
 * The `YYYY-MM-DD` `days` after `date`.
 * @param {string} date
 * @param {number} days
 */
const addDays = (date, days) =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The forecast of the two tables; `rowNumbers[i]` is where `rows[i]` is in its file.
 * @param {{ rows: readonly { date: string, direction: string, counterparty: string, amount: number }[], rowNumbers: readonly number[] }} flows
 * @param {{ rows: readonly { asOf: string, account: string, balance: number }[] }} balances
 * @param {Readonly<{ minimum?: string }>} options `minimum` in whole yen
 * @throws {TableError}
 */
export function forecast(flows, balances, options) {
  const limit = options.minimum ?? '0';
  if (!/^\d+$/u.test(limit)) throw new TableError('usage', `--minimum "${limit}" is not whole yen`);
  const minimum = Number(limit);
  const [first] = balances.rows;
  if (first === undefined) throw new TableError('no_rows', 'the balances have no rows');
  const { asOf } = first;
  if (balances.rows.some((row) => row.asOf !== asOf))
    throw new TableError('mixed_dates', 'the balances are not all as of one date');
  const opening = balances.rows.reduce((sum, row) => sum + row.balance, 0);
  const weeks = Array.from({ length: WEEKS }, (_, at) => ({
    week: addDays(asOf, 7 * (at + 1)),
    inflow: 0,
    outflow: 0,
  }));
  /** @type {number[]} */
  const outside = [];
  flows.rows.forEach((flow, at) => {
    const row = Number(flows.rowNumbers[at]);
    const sign = SIGN.get(flow.direction);
    if (sign === undefined)
      throw new TableError('unknown_direction', `row ${String(row)}: "${flow.direction}"`, {
        row,
        column: 'direction',
        value: flow.direction,
      });
    if (flow.amount <= 0)
      throw new TableError('not_positive', `row ${String(row)}: an amount must be above 0`, {
        row,
        column: 'amount',
        value: String(flow.amount),
      });
    // Day 1 is the day after the balance date; a flow on or before it, or after day 91, has no week.
    const day = (Date.parse(flow.date) - Date.parse(asOf)) / DAY_MS;
    const week = weeks[Math.ceil(day / 7) - 1];
    if (week === undefined) outside.push(row);
    else if (sign > 0) week.inflow += flow.amount;
    else week.outflow += flow.amount;
  });
  let closing = opening;
  const rows = weeks.map(({ week, inflow, outflow }) => {
    closing += inflow - outflow;
    return { week, inflow, outflow, net: inflow - outflow, closing, short: closing < minimum };
  });
  const lowest = rows.reduce((low, row) => (row.closing < low.closing ? row : low));
  const short = rows.filter((row) => row.short).map((row) => row.week);
  return {
    asOf,
    opening,
    minimum,
    weeks: rows,
    lowest: { week: lowest.week, closing: lowest.closing },
    short,
    outside,
  };
}

/**
 * The command line: read the two exports named, then forecast with the option.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  forecast(
    readTable(String(positionals['flows']), { columns: FLOWS }),
    readTable(String(positionals['balances']), { columns: BALANCES }),
    options,
  );

runWhenMain(import.meta.url, SPEC, compute);
