#!/usr/bin/env node
// Week-over-week KPI movement, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`,
// no shell):
//
//   analyse.mjs <export.csv|export.xlsx> [--week YYYY-MM-DD] [--threshold <percent>]
//
// It reads a weekly KPI export (one row per week and metric; the Japanese or the English column
// names) with the built-in table reader (ADR-0173) and prints JSON on stdout: for the week (default:
// the export's last), each metric's value, its value in the metric's previous week in the export,
// the change (value − previous, to two decimals), the change % (of the previous value, rounded half
// away from zero to one decimal, null when the previous value is 0), the mean of the metric's four
// weeks before (two decimals, null with fewer than four), and whether it moved: its printed change
// % is at least the threshold away from zero (default 10), or it changed from zero. Values are read
// to two decimals. A file, row, column, value or option it cannot read prints `{ "error",
// "message" }` on stderr and exits 1 (2 for the arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The export's columns: the Japanese and the English name, and what a value must be. */
const COLUMNS = /** @type {const} */ ({
  week: { names: ['週', 'week'], type: 'date' },
  metric: ['指標', 'metric'],
  value: { names: ['値', 'value'], type: 'decimal' },
  unit: ['単位', 'unit'],
  note: { names: ['備考', 'note'], optional: true },
});

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <export.csv|export.xlsx> [--week YYYY-MM-DD] [--threshold <percent>]',
  positionals: ['file'],
  options: { week: {}, threshold: { default: '10' } },
};

/** `x` rounded half away from zero to a whole number. */
const round = (/** @type {number} */ x) => Math.sign(x) * Math.round(Math.abs(x));

/**
 * The analysis of the export's rows; `rowNumbers[i]` is where `rows[i]` is in the file.
 * @param {{ rows: readonly { week: string, metric: string, value: number, unit: string, note: string | null }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ week?: string, threshold?: string }>} options `week` (YYYY-MM-DD) and `threshold` (percent)
 * @throws {TableError}
 */
export function analyse({ rows, rowNumbers }, options) {
  const limit = options.threshold ?? '10';
  if (!/^\d+(?:\.\d+)?$/u.test(limit))
    throw new TableError('usage', `--threshold "${limit}" is not a percent`);
  const threshold = Number(limit);
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  // The reader refuses a week that is no calendar date. In hundredths, so differences and sums
  // carry no float noise; a value is printed as read, to two decimals.
  const all = rows.map((row, at) => ({
    ...row,
    row: Number(rowNumbers[at]),
    at: round(row.value * 100),
  }));
  all.sort((a, b) => a.week.localeCompare(b.week));
  const ids = all.map((line) => `${line.week} ${line.metric}`);
  const twice = ids.findIndex((id, at) => ids.indexOf(id) !== at);
  if (twice !== -1) {
    const { row } = /** @type {(typeof all)[number]} */ (all[twice]);
    throw new TableError('duplicate_row', `${String(ids[twice])} appears in more than one row`, {
      row,
    });
  }
  const weeks = [...new Set(all.map((line) => line.week))];
  const asked = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u.exec(options.week ?? '');
  const pad = (/** @type {string | undefined} */ part) => String(part).padStart(2, '0');
  const named =
    asked === null ? options.week : `${String(asked[1])}-${pad(asked[2])}-${pad(asked[3])}`;
  const week = named ?? String(weeks.at(-1));
  if (!weeks.includes(week))
    throw new TableError('unknown_week', `no week ${week} in the export: ${weeks.join(', ')}`);
  const metrics = all
    .filter((line) => line.week === week)
    .map(({ metric, unit, note, at }) => {
      const before = all.filter((line) => line.metric === metric && line.week < week);
      const [last, four] = [before.at(-1), before.slice(-4)];
      const avg4 =
        four.length < 4 ? null : round(four.reduce((sum, line) => sum + line.at, 0) / 4) / 100;
      const value = at / 100;
      const row = { metric, unit, value, previous: null, change: null, changePct: null, avg4 };
      if (last === undefined) return { ...row, moved: false, note };
      const change = at - last.at;
      const changePct = last.at === 0 ? null : round((change * 1000) / last.at) / 10;
      const moved = change !== 0 && (changePct === null || Math.abs(changePct) >= threshold);
      return { ...row, previous: last.at / 100, change: change / 100, changePct, moved, note };
    });
  const size = (/** @type {number | null} */ pct) => (pct === null ? Infinity : Math.abs(pct));
  const moved = metrics.filter((line) => line.moved);
  moved.sort((a, b) => size(b.changePct) - size(a.changePct));
  const previousWeek = weeks.filter((one) => one < week).at(-1) ?? null;
  const changes = metrics.flatMap(({ metric, changePct }) =>
    changePct === null ? [] : [{ metric, changePct }],
  );
  return { week, previousWeek, threshold, metrics, moved, changes };
}

/**
 * The command line: read the export named first, then analyse it with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
