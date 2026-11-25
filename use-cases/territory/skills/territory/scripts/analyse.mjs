#!/usr/bin/env node
// A territory split proposal, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`,
// no shell):
//
//   analyse.mjs <export.csv|export.xlsx> [--territories <2-9>] [--by sales|visits|accounts]
//
// It reads a CRM customer export (one row per customer; the Japanese or the English column names)
// with the built-in table reader (ADR-0173), totals each area (prefecture): accounts, annual sales
// and visits, and splits the areas into the given number of territories (default 3) so that the
// chosen measure (default sales) is as even as a fixed rule makes it: the areas, largest first
// (ties by name), each go to the territory with the least so far (ties: the first). It prints
// JSON on stdout: each territory's areas, totals and share of the measure, the spread between the
// largest and the smallest territory, the areas, and every note in the export as data. It never
// reads the owner column: it plans territories, never a person. A file, row, column, value or
// option it cannot read prints `{ "error", "message" }` on stderr and exits 1 (2 for the
// arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The export's columns: the Japanese and the English name, and what a value must be. */
const COLUMNS = /** @type {const} */ ({
  id: ['顧客ID', 'customer_id'],
  customer: ['顧客名', 'customer'],
  area: ['都道府県', 'prefecture'],
  sales: { names: ['年間売上_千円', 'annual_sales_jpy_k'], type: 'whole' },
  visits: { names: ['訪問回数', 'visits'], type: 'whole' },
  note: { names: ['備考', 'note'], optional: true },
});

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <export.csv|export.xlsx> [--territories <2-9>] [--by sales|visits|accounts]',
  positionals: ['file'],
  options: { territories: { default: '3' }, by: { default: 'sales' } },
};

/** `x` to one decimal, half up (every `x` here is at least 0). */
const tenth = (/** @type {number} */ x) => Math.round(x * 10) / 10;

/**
 * The proposal for the export's rows; `rowNumbers[i]` is where `rows[i]` is in the file.
 * @param {{ rows: readonly { id: string, customer: string, area: string, sales: number, visits: number, note: string | null }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ territories?: string, by?: string }>} options
 * @throws {TableError}
 */
export function analyse({ rows, rowNumbers }, options) {
  const [count, by] = [options.territories ?? '3', options.by ?? 'sales'];
  if (!/^[2-9]$/u.test(count))
    throw new TableError('usage', `--territories "${count}" is not a whole number from 2 to 9`);
  if (by !== 'sales' && by !== 'visits' && by !== 'accounts')
    throw new TableError('usage', `--by "${by}" is not sales, visits or accounts`);
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  /** @type {Map<string, { area: string, accounts: number, sales: number, visits: number }>} */
  const areas = new Map();
  const seen = new Set();
  rows.forEach((row, at) => {
    const where = { row: Number(rowNumbers[at]) };
    if (seen.has(row.id))
      throw new TableError('duplicate_row', `customer ${row.id} appears twice`, where);
    if (row.sales < 0 || row.visits < 0)
      throw new TableError('negative_value', `customer ${row.id} has a negative value`, where);
    seen.add(row.id);
    const area = areas.get(row.area) ?? { area: row.area, accounts: 0, sales: 0, visits: 0 };
    areas.set(row.area, {
      area: row.area,
      accounts: area.accounts + 1,
      sales: area.sales + row.sales,
      visits: area.visits + row.visits,
    });
  });
  const n = Number(count);
  if (n > areas.size)
    throw new TableError('too_few_areas', `${count} territories, but only ${areas.size} areas`);
  const list = [...areas.values()].sort((a, b) => b[by] - a[by] || (a.area < b.area ? -1 : 1));
  const total = list.reduce((sum, area) => sum + area[by], 0);
  if (total === 0) throw new TableError('nothing_to_balance', `every ${by} value is 0`);
  const plan = Array.from({ length: n }, (_, at) => ({
    territory: `T${String(at + 1)}`,
    areas: /** @type {string[]} */ ([]),
    accounts: 0,
    sales: 0,
    visits: 0,
  }));
  for (const area of list) {
    const target = plan.reduce((least, one) => (one[by] < least[by] ? one : least));
    target.areas.push(area.area);
    target.accounts += area.accounts;
    target.sales += area.sales;
    target.visits += area.visits;
  }
  const territories = plan.map((one) => ({
    ...one,
    value: one[by],
    sharePct: tenth((one[by] * 100) / total),
  }));
  const values = territories.map((one) => one.value);
  const spread = Math.max(...values) - Math.min(...values);
  const notes = rows.flatMap(({ id, customer, area, note }) =>
    note === null ? [] : [{ id, customer, area, note }],
  );
  return {
    by,
    count: n,
    total,
    spread,
    spreadPct: tenth((spread * 100 * n) / total),
    territories,
    areas: list,
    notes,
  };
}

/**
 * The command line: read the export named first, then plan with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
