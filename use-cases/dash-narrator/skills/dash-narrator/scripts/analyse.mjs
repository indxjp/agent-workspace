#!/usr/bin/env node
// What a dashboard's charts show, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`,
// no shell):
//
//   analyse.mjs <export.csv|export.xlsx> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--z <number>]
//
// It reads the data behind a dashboard (one row per date and metric, the Japanese or the English
// column names) with the built-in table reader (ADR-0173) and prints JSON on stdout: for each metric
// over the range (default: every date in the export), its first and last value, the change and the
// change % (of the first value, rounded half away from zero to one decimal, null when the first is
// 0), the mean, the peak and the low, and every unusual point: one whose distance from the mean is at
// least `z` population standard deviations (default 2; none when the metric never changes). Other
// figures are rounded half away from zero to two decimals. A file, row, column, value or option it
// cannot read prints `{ "error", "message" }` on stderr and exits 1 (2 for the arguments): it never
// guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The export's columns: the Japanese and the English name, and what a value must be. */
const COLUMNS = /** @type {const} */ ({
  date: { names: ['日付', 'date'], type: 'date' },
  metric: ['指標', 'metric'],
  value: { names: ['値', 'value'], type: 'decimal' },
});

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage:
    'analyse.mjs <export.csv|export.xlsx> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--z <number>]',
  positionals: ['file'],
  options: { from: {}, to: {}, z: { default: '2' } },
};

/** `value` rounded half away from zero to `places` decimals. */
const round = (/** @type {number} */ value, /** @type {number} */ places) =>
  (Math.sign(value) * Math.round(Math.abs(value) * 10 ** places)) / 10 ** places;

/**
 * The analysis of the export's rows; `rowNumbers[i]` is where `rows[i]` is in the file.
 * @param {{ rows: readonly { date: string, metric: string, value: number }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ from?: string, to?: string, z?: string }>} options
 * @throws {TableError}
 */
export function analyse({ rows, rowNumbers }, options) {
  const z = options.z ?? '2';
  if (!/^\d+(?:\.\d+)?$/u.test(z) || Number(z) === 0)
    throw new TableError('usage', `--z "${z}" is not a positive number`);
  for (const key of /** @type {const} */ (['from', 'to'])) {
    const day = options[key];
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(day))
      throw new TableError('usage', `--${key} "${day}" is not YYYY-MM-DD`);
  }
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  const ids = rows.map((row) => `${row.date} ${row.metric}`);
  const twice = ids.findIndex((id, at) => ids.indexOf(id) !== at);
  if (twice !== -1)
    throw new TableError('duplicate_row', `${String(ids[twice])} appears in more than one row`, {
      row: Number(rowNumbers[twice]),
    });
  const dates = rows.map((row) => row.date).sort();
  const [from, to] = [options.from ?? String(dates[0]), options.to ?? String(dates.at(-1))];
  if (from > to) throw new TableError('usage', `--from ${from} is after --to ${to}`);
  const inRange = rows
    .filter((row) => row.date >= from && row.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (inRange.length === 0) throw new TableError('empty_range', `no rows from ${from} to ${to}`);
  const threshold = Number(z);
  /** @type {{ metric: string, date: string, value: number, z: number }[]} */
  const unusual = [];
  const metrics = [...new Set(inRange.map((row) => row.metric))].map((metric) => {
    const points = inRange.filter((row) => row.metric === metric);
    const values = points.map((point) => point.value);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const sd = Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
    );
    for (const { date, value } of points) {
      const score = sd === 0 ? 0 : round((value - mean) / sd, 2);
      if (Math.abs(score) >= threshold) unusual.push({ metric, date, value, z: score });
    }
    const [first, last] = [Number(values[0]), Number(values.at(-1))];
    const at = (/** @type {number} */ value) => ({
      date: /** @type {{ date: string }} */ (points[values.indexOf(value)]).date,
      value,
    });
    return {
      metric,
      first,
      last,
      change: round(last - first, 2),
      changePct: first === 0 ? null : round(((last - first) * 100) / first, 1),
      mean: round(mean, 2),
      peak: at(Math.max(...values)),
      low: at(Math.min(...values)),
    };
  });
  unusual.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  const changes = metrics.flatMap(({ metric, changePct }) =>
    changePct === null ? [] : [{ metric, changePct }],
  );
  return { from, to, z: threshold, metrics, unusual, changes };
}

/**
 * The command line: read the export named first, then analyse it with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
