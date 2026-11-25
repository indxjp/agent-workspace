#!/usr/bin/env node
// One read-only aggregate query, proposed as SQL and answered from a table export, as
// `run_skill_script` runs it (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <export.csv|export.xlsx> --table <name> --group <column> [--sum <column>]
//     [--where <column>=<value>] [--exclude <column>=<value>] [--month <column>=YYYY-MM]
//
// It reads the export of one database table (its column names as the database has them) with the
// built-in table reader (ADR-0173), keeps the rows the filters keep (`--where`: the column equals
// the value; `--exclude`: it does not; `--month`: the date column is in that month), and totals
// them by the group column: the sum of a whole-number column, or the count of rows. It prints JSON
// on stdout: the `SELECT` statement that asks a database the same question (it never connects to
// one), the rows read and kept, and each group's total, largest first (ties by name). Names are
// letters, digits and underscores; a value is quoted as SQL quotes it. A file, row, column, value
// or option it cannot read prints `{ "error", "message" }` on stderr and exits 1 (2 for the
// arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage:
    'analyse.mjs <export.csv|export.xlsx> --table <name> --group <column> [--sum <column>] [--where <column>=<value>] [--exclude <column>=<value>] [--month <column>=YYYY-MM]',
  positionals: ['file'],
  options: { table: {}, group: {}, sum: {}, where: {}, exclude: {}, month: {} },
};

/** `value` as a table or column name, or a usage refusal naming `option`. */
function nameOf(/** @type {string} */ option, /** @type {string | undefined} */ value) {
  if (value === undefined || !/^[a-z_][a-z0-9_]*$/u.test(value))
    throw new TableError('usage', `--${option} "${String(value)}" is not a name (a-z, 0-9, _)`);
  return value;
}

/** `--<option> <column>=<value>` as `[column, value]`, or `undefined` when it is not given. */
function pairOf(/** @type {string} */ option, /** @type {string | undefined} */ text) {
  if (text === undefined) return undefined;
  const at = text.indexOf('=');
  const value = text.slice(at + 1);
  if (at < 1 || value === '')
    throw new TableError('usage', `--${option} "${text}" is not <column>=<value>`);
  return /** @type {const} */ ([nameOf(option, text.slice(0, at)), value]);
}

/** `value` quoted as an SQL string literal. */
const quote = (/** @type {string} */ value) => `'${value.replaceAll("'", "''")}'`;

/**
 * The query the options describe: its parts, the table reader's columns and the row filter.
 * @param {Readonly<{ table?: string, group?: string, sum?: string, where?: string, exclude?: string, month?: string }>} options
 */
export function queryOf(options) {
  const [table, group] = [nameOf('table', options.table), nameOf('group', options.group)];
  const sum = options.sum === undefined ? undefined : nameOf('sum', options.sum);
  const [where, exclude, month] = [
    pairOf('where', options.where),
    pairOf('exclude', options.exclude),
    pairOf('month', options.month),
  ];
  const conditions = [];
  if (where !== undefined) conditions.push(`${where[0]} = ${quote(where[1])}`);
  if (exclude !== undefined) conditions.push(`${exclude[0]} <> ${quote(exclude[1])}`);
  if (month !== undefined) {
    const ym = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(month[1]);
    if (ym === null)
      throw new TableError('usage', `--month "${month.join('=')}" is not <column>=YYYY-MM`);
    const [year, mon] = [Number(ym[1]), Number(ym[2])];
    const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
    conditions.push(`${month[0]} >= '${month[1]}-01' AND ${month[0]} < '${next}-01'`);
  }
  const measure = sum === undefined ? 'COUNT(*)' : `SUM(${sum})`;
  const sql = [
    `SELECT ${group}, ${measure} AS total`,
    `FROM ${table}`,
    ...conditions.map((condition, at) => `${at === 0 ? 'WHERE' : '  AND'} ${condition}`),
    `GROUP BY ${group}`,
    `ORDER BY total DESC, ${group};`,
  ].join('\n');
  /** @type {Record<string, import('@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs').ColumnSpec>} */
  const columns = {
    group: [group],
    ...(sum === undefined ? {} : { sum: { names: [sum], type: 'whole' } }),
    ...(where === undefined ? {} : { where: [where[0]] }),
    ...(exclude === undefined ? {} : { exclude: [exclude[0]] }),
    ...(month === undefined ? {} : { month: { names: [month[0]], type: 'date' } }),
  };
  /** @param {Readonly<Record<string, string | number>>} row */
  const keeps = (row) =>
    (where === undefined || row['where'] === where[1]) &&
    (exclude === undefined || row['exclude'] !== exclude[1]) &&
    (month === undefined || String(row['month']).startsWith(`${month[1]}-`));
  return { table, measure, sql, columns, keeps };
}

/**
 * The answer for the export's rows under `query`.
 * @param {{ rows: readonly Readonly<Record<string, string | number>>[] }} table
 * @param {ReturnType<typeof queryOf>} query
 */
export function analyse({ rows }, { table, measure, sql, keeps }) {
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  const kept = rows.filter(keeps);
  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const row of kept) {
    const group = String(row['group']);
    totals.set(
      group,
      (totals.get(group) ?? 0) + (row['sum'] === undefined ? 1 : Number(row['sum'])),
    );
  }
  const result = [...totals].map(([group, total]) => ({ group, total }));
  result.sort((a, b) => b.total - a.total || (a.group < b.group ? -1 : 1));
  const total = result.reduce((sum, row) => sum + row.total, 0);
  return { table, measure, sql, rowsRead: rows.length, rowsKept: kept.length, total, rows: result };
}

/**
 * The command line: the query from the options, then the export named first.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) => {
  const query = queryOf(options);
  return analyse(readTable(String(positionals['file']), { columns: query.columns }), query);
};

runWhenMain(import.meta.url, SPEC, compute);
