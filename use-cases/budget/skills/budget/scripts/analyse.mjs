#!/usr/bin/env node
// Budget versus actual, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <export.csv|export.xlsx> [--month YYYY-MM] [--threshold <percent>]
//
// It reads a budget-and-actual export (one row per month, department and account; the Japanese or
// the English column names) with the built-in table reader (ADR-0173) and prints JSON on stdout:
// for the month (default: the export's last), each line's budget, actual, variance (actual −
// budget) and variance % (of the budget, rounded half away from zero to one decimal, null when the
// budget is 0), the same from the export's first month to that month (YTD), and whether the line
// is flagged: its printed variance % is at least the threshold away from zero (default 5), or it
// spent with no budget. Department totals and each month's total are the chart rows. A file, row,
// column, value or option it cannot read prints `{ "error", "message" }` on stderr and exits 1
// (2 for the arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The export's columns: the Japanese and the English name, and what a value must be. */
const COLUMNS = /** @type {const} */ ({
  month: ['年月', 'month'],
  department: ['部門', 'department'],
  account: ['勘定科目', 'account'],
  budget: { names: ['予算', 'budget'], type: 'whole' },
  actual: { names: ['実績', 'actual'], type: 'whole' },
});

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <export.csv|export.xlsx> [--month YYYY-MM] [--threshold <percent>]',
  positionals: ['file'],
  options: { month: {}, threshold: { default: '5' } },
};

/**
 * Budget, actual, variance and variance % of the lines summed.
 * @param {readonly { budget: number, actual: number }[]} lines
 */
function figures(lines) {
  const budget = lines.reduce((sum, line) => sum + line.budget, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  const variance = actual - budget;
  const tenths = Math.round(Math.abs((variance * 1000) / budget)); // half away from zero
  const variancePct = budget === 0 ? null : (Math.sign(variance) * tenths) / 10;
  return { budget, actual, variance, variancePct };
}

/**
 * The figures of each department (or month) of the lines, in their order.
 * @template {{ department: string, month: string, budget: number, actual: number }} L
 * @param {readonly L[]} lines
 * @param {'department' | 'month'} key
 */
const groups = (lines, key) =>
  [...new Set(lines.map((line) => line[key]))].map((name) => ({
    [key]: name,
    ...figures(lines.filter((line) => line[key] === name)),
  }));

/**
 * The analysis of the export's rows; `rowNumbers[i]` is where `rows[i]` is in the file.
 * @param {{ rows: readonly { month: string, department: string, account: string, budget: number, actual: number }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ month?: string, threshold?: string }>} options `month` (YYYY-MM) and `threshold` (percent)
 * @throws {TableError}
 */
export function analyse({ rows, rowNumbers }, options) {
  const limit = options.threshold ?? '5';
  if (!/^\d+(?:\.\d+)?$/u.test(limit))
    throw new TableError('usage', `--threshold "${limit}" is not a percent`);
  const threshold = Number(limit);
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  const all = rows.map((row, at) => {
    const where = { row: Number(rowNumbers[at]), column: 'month', value: row.month };
    if (!/^\d{4}[-/]\d{2}$/u.test(row.month))
      throw new TableError(
        'not_a_month',
        `row ${String(where.row)}: "${row.month}" is not YYYY-MM`,
        where,
      );
    return { ...row, month: row.month.replace('/', '-'), row: where.row };
  });
  all.sort((a, b) => a.month.localeCompare(b.month));
  const ids = all.map((line) => `${line.month} ${line.department} ${line.account}`);
  const twice = ids.findIndex((id, at) => ids.indexOf(id) !== at);
  if (twice !== -1) {
    const { row } = /** @type {(typeof all)[number]} */ (all[twice]);
    throw new TableError('duplicate_row', `${String(ids[twice])} appears in more than one row`, {
      row,
    });
  }
  const months = [...new Set(all.map((line) => line.month))];
  const month = options.month ?? String(months.at(-1));
  if (!months.includes(month))
    throw new TableError('unknown_month', `no ${month} in the export: ${months.join(', ')}`);
  const upTo = all.filter((line) => line.month <= month);
  const inMonth = upTo.filter((line) => line.month === month);
  const keys = new Map(upTo.map((line) => [`${line.department}/${line.account}`, line]));
  const lines = [...keys.values()].map(({ department, account }) => {
    const own = upTo.filter((line) => line.department === department && line.account === account);
    const current = figures(own.filter((line) => line.month === month));
    const { variance, variancePct } = current;
    const flagged = variance !== 0 && (variancePct === null || Math.abs(variancePct) >= threshold);
    return { department, account, ...current, ytd: figures(own), flagged };
  });
  const [total, ytd] = [figures(inMonth), figures(upTo)];
  const [departments, trend] = [groups(inMonth, 'department'), groups(upTo, 'month')];
  const flagged = lines.filter((line) => line.flagged);
  return { month, from: months[0], threshold, total, ytd, departments, trend, flagged, lines };
}

/**
 * The command line: read the export named first, then analyse it with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
