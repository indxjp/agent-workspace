#!/usr/bin/env node
// Signs that a customer account may leave, by rule, as `run_skill_script` runs it
// (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <usage.csv|usage.xlsx> [--month YYYY-MM] [--signs <n>]
//
// It reads a subscription service's monthly usage export (one row per month and customer account:
// contracted seats, active users, logins and support tickets) with the built-in table reader
// (ADR-0173) and prints JSON on stdout. For the month (default: the export's last), each account
// is compared with its own baseline, the mean of up to BASELINE months before it in the export,
// and shows a sign by fixed rules: active users or logins at 70% of the baseline or lower, fewer
// seats than the month before, 3 or more tickets and at least twice the baseline, and active users
// under half the seats. The accounts with `--signs` signs or more (default 2) are listed in
// `atRisk`, most signs first. It is a reading of usage, not a prediction; an account with no
// month before has no baseline (`notAssessed`). It reads customer accounts only. A file, row,
// value or option it cannot read prints `{ "error", "message" }` on stderr and exits 1 (2 for the
// arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

const BASELINE = 3;
/** The signs in order, with their Japanese and English names. */
const SIGNS = /** @type {const} */ ({
  activeDrop: ['利用者数の減少', 'Fewer active users'],
  loginDrop: ['ログイン数の減少', 'Fewer logins'],
  seatsCut: ['契約席数の削減', 'Seats cut'],
  ticketsUp: ['問い合わせの増加', 'More support tickets'],
  lowAdoption: ['利用率の低さ', 'Low adoption'],
});
const COLUMNS = /** @type {const} */ ({
  month: ['年月', 'month'],
  accountId: ['顧客ID', 'account_id'],
  accountName: ['顧客名', 'account_name'],
  seats: { names: ['契約席数', 'seats'], type: 'whole' },
  activeUsers: { names: ['利用者数', 'active_users'], type: 'whole' },
  logins: { names: ['ログイン数', 'logins'], type: 'whole' },
  tickets: { names: ['問い合わせ件数', 'tickets'], type: 'whole' },
});

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <usage.csv|usage.xlsx> [--month YYYY-MM] [--signs <n>]',
  positionals: ['file'],
  options: { month: {}, signs: { default: '2' } },
};

/** `value` rounded half away from zero to one decimal. */
const tenths = (/** @type {number} */ value) =>
  (Math.sign(value) * Math.round(Math.abs(value) * 10)) / 10;
/** The change from `base` to `now` in percent, or null from a base of 0. */
const changeOf = (/** @type {number} */ now, /** @type {number} */ base) =>
  base === 0 ? null : tenths(((now - base) * 100) / base);

/**
 * The signs of each account in the month; `columns` is the header as written (it sets the language).
 * @param {{ columns: readonly string[], rows: readonly { month: string, accountId: string, accountName: string, seats: number, activeUsers: number, logins: number, tickets: number }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ month?: string, signs?: string }>} options `month` (YYYY-MM), `signs` (1 to 5)
 * @throws {TableError}
 */
export function analyse({ columns, rows, rowNumbers }, options) {
  const seen = new Set();
  for (const [at, row] of rows.entries()) {
    const id = `${row.month} ${row.accountId}`;
    const problem = !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(row.month)
      ? 'not_a_month'
      : seen.has(id)
        ? 'duplicate_row'
        : (row.seats < 1 || row.activeUsers > row.seats) && 'out_of_range';
    const where = { row: Number(rowNumbers[at]) };
    if (problem)
      throw new TableError(problem, `row ${String(where.row)}: ${id}: ${problem}`, where);
    seen.add(id);
  }
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  const months = [...new Set(rows.map((row) => row.month))].sort();
  const month = options.month ?? String(months.at(-1));
  if (!months.includes(month))
    throw new TableError('unknown_month', `no ${month} in the export: ${months.join(', ')}`);
  const lang = columns.includes('顧客ID') ? 0 : 1;
  const inMonth = rows.filter((row) => row.month === month);
  const assessed = inMonth.flatMap((now) => {
    const base = rows
      .filter((row) => row.accountId === now.accountId && row.month < month)
      .sort((x, y) => x.month.localeCompare(y.month))
      .slice(-BASELINE);
    const last = base.at(-1);
    if (last === undefined) return [];
    const mean = (/** @type {'activeUsers' | 'logins' | 'tickets'} */ key) =>
      base.reduce((sum, row) => sum + row[key], 0) / base.length;
    const [active, usual, calls] = [mean('activeUsers'), mean('logins'), mean('tickets')];
    const shown = [
      now.activeUsers * 10 <= active * 7 && active > 0,
      now.logins * 10 <= usual * 7 && usual > 0,
      now.seats < last.seats,
      now.tickets >= 3 && now.tickets >= calls * 2,
      now.activeUsers * 2 < now.seats,
    ];
    const signs = Object.values(SIGNS).flatMap((names, at) => (shown[at] ? [names[lang]] : []));
    const { accountId, accountName, seats, activeUsers, logins, tickets } = now;
    const figures = { accountId, accountName, seats, activeUsers, logins, tickets };
    const bases = {
      baseActive: tenths(active),
      baseLogins: tenths(usual),
      baseTickets: tenths(calls),
    };
    const changes = {
      activeChange: changeOf(activeUsers, active),
      loginChange: changeOf(logins, usual),
    };
    const adoption = tenths((now.activeUsers * 100) / now.seats);
    return [{ ...figures, adoption, ...bases, ...changes, signs, signCount: signs.length }];
  });
  const least = Number(options.signs);
  if (!(least >= 1 && least <= 5 && Number.isInteger(least)))
    throw new TableError(
      'usage',
      `--signs "${String(options.signs)}" is not a whole number from 1 to 5`,
    );
  const atRisk = assessed.filter((account) => account.signCount >= least);
  atRisk.sort((a, b) => b.signCount - a.signCount);
  const assessedIds = new Set(assessed.map((account) => account.accountId));
  const notAssessed = inMonth
    .filter((row) => !assessedIds.has(row.accountId))
    .map(({ accountId, accountName }) => ({ accountId, accountName }));
  return {
    month,
    baseline: BASELINE,
    signsAtLeast: least,
    atRisk,
    accounts: assessed,
    notAssessed,
  };
}

/**
 * The command line: read the export named first, then read the signs with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
