#!/usr/bin/env node
// An engagement survey, by team, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`):
//
//   analyse.mjs <survey.csv|survey.xlsx> [--previous <earlier.csv|earlier.xlsx>] [--drop <points>]
//
// It reads the survey tool's export (one row per response: the period, the team and five ratings
// from 1 to 5) with the built-in table reader (ADR-0173) and prints JSON on stdout. Every figure is
// an aggregate of the teams with at least MIN_GROUP respondents: a smaller team is named in
// `heldBack` and left out of every figure, the company's included, so no figure can be taken apart
// to reach a smaller group; a survey with no team that large is refused. Per question, per team and
// per team and question, the favourable share (answers of 4 or 5, a percent to one decimal), and
// with `--previous` the earlier survey's share and the change in points (null where the earlier
// survey has no figure). The team-and-question items that fell by `--drop` points or more (default 10) are
// listed in `drops`. It never prints a response ID or a comment, so no answer can be traced to a
// respondent. A file, row, value or option it cannot read prints `{ "error", "message" }` on
// stderr and exits 1 (2 for the arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The fewest respondents a team may have before any figure of it is printed. */
export const MIN_GROUP = 5;
const QUESTIONS = /** @type {const} */ ({
  work: ['やりがい', 'Meaningful work'],
  dialogue: ['上司との対話', 'Manager dialogue'],
  workload: ['業務量', 'Workload'],
  growth: ['成長の機会', 'Growth'],
  relations: ['人間関係', 'Relationships'],
});
const KEYS = /** @type {(keyof typeof QUESTIONS)[]} */ (Object.keys(QUESTIONS));
const whole = (/** @type {readonly string[]} */ names) => ({
  names,
  type: /** @type {const} */ ('whole'),
});
const COLUMNS = /** @type {const} */ ({
  period: ['実施回', 'period'],
  id: ['回答ID', 'response_id'],
  team: ['部署', 'team'],
  ...Object.fromEntries(KEYS.map((key) => [key, whole(QUESTIONS[key])])),
});

/** The command line `run_skill_script` passes: the survey, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <survey.csv|survey.xlsx> [--previous <earlier.csv>] [--drop <points>]',
  positionals: ['file'],
  options: { previous: {}, drop: { default: '10' } },
};

/** @typedef {Readonly<Record<string, string | number>>} Row */

/** The share of the answers of `rows` (to `key`, or to every question) that are 4 or 5, in %. */
function favourable(/** @type {readonly Row[]} */ rows, /** @type {string | undefined} */ key) {
  const scores = rows.flatMap((row) => (key === undefined ? KEYS : [key]).map((k) => row[k]));
  return (
    Math.round((scores.filter((score) => Number(score) >= 4).length * 1000) / scores.length) / 10
  );
}

/**
 * One survey's favourable shares, keyed `team|question` (team '' for the company, question ''
 * for every question), its question names (its header as written) and its teams.
 * @param {{ columns: readonly string[], rows: readonly Row[], rowNumbers: readonly number[] }} table
 * @throws {TableError}
 */
export function summarise({ columns, rows, rowNumbers }) {
  const ids = new Set();
  for (const [at, row] of rows.entries()) {
    const problem = !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(String(row['period']))
      ? 'not_a_month'
      : ids.has(row['id'])
        ? 'duplicate_row'
        : KEYS.some((key) => Math.abs(Number(row[key]) - 3) > 2) && 'out_of_range';
    const where = { row: Number(rowNumbers[at]) };
    if (problem) throw new TableError(problem, `row ${String(where.row)}: ${problem}`, where);
    ids.add(row['id']);
  }
  const periods = [...new Set(rows.map((row) => String(row['period'])))];
  if (periods.length > 1) throw new TableError('mixed_periods', `periods ${periods.join(', ')}`);
  const all = [...new Set(rows.map((row) => String(row['team'])))];
  const groups = all.map((team) => ({ team, rows: rows.filter((row) => row['team'] === team) }));
  const teams = groups.filter((group) => group.rows.length >= MIN_GROUP);
  const covered = teams.flatMap((group) => group.rows);
  if (covered.length === 0)
    throw new TableError('too_few_responses', `no team has ${String(MIN_GROUP)} or more responses`);
  const names = KEYS.map((key) =>
    String(columns.find((name) => QUESTIONS[key].some((k) => k === name))),
  );
  /** @type {Map<string, number>} */
  const shares = new Map();
  for (const { team, rows: own } of [{ team: '', rows: covered }, ...teams]) {
    shares.set(`${team}|`, favourable(own, undefined));
    KEYS.forEach((key, at) => shares.set(`${team}|${String(names[at])}`, favourable(own, key)));
  }
  const heldBack = groups.filter((group) => group.rows.length < MIN_GROUP).map((g) => g.team);
  return { period: String(periods[0]), responses: covered.length, names, teams, heldBack, shares };
}

/**
 * The analysis of a survey, against an earlier one when given.
 * @param {ReturnType<typeof summarise>} now
 * @param {ReturnType<typeof summarise> | null} before
 * @param {Readonly<{ drop?: string }>} options `drop`: the fall in points to list (the command line's default is 10)
 * @throws {TableError}
 */
export function analyse(now, before, options) {
  const limit = String(options.drop);
  if (!/^\d+(?:\.\d)?$/u.test(limit))
    throw new TableError('usage', `--drop "${limit}" is not points`);
  /** The share of `key` now, and its change in points since `before` (null without a figure). */
  const item = (/** @type {string} */ key) => {
    const [share, earlier] = [Number(now.shares.get(key)), before?.shares.get(key)];
    const change = earlier === undefined ? null : Math.round((share - earlier) * 10) / 10;
    return { favourable: share, previous: earlier ?? null, change };
  };
  const questions = now.names.map((question) => ({ question, ...item(`|${question}`) }));
  const teams = now.teams.map(({ team, rows }) => ({
    team,
    responses: rows.length,
    ...item(`${team}|`),
  }));
  const items = now.teams.flatMap(({ team }) =>
    now.names.map((question) => ({ team, question, ...item(`${team}|${question}`) })),
  );
  const drops = items.filter((row) => row.change !== null && row.change <= -Number(limit));
  const { period, responses, heldBack } = now;
  const previousPeriod = before?.period ?? null;
  const fixed = { period, previousPeriod, responses, minGroup: MIN_GROUP, drop: Number(limit) };
  return { ...fixed, questions, teams, items, drops, heldBack };
}

/**
 * The command line: read the survey and the earlier one, if any, then analyse them.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export function compute({ positionals, options }) {
  const read = (/** @type {string} */ file) => summarise(readTable(file, { columns: COLUMNS }));
  const earlier = options['previous'];
  const before = earlier === undefined ? null : read(earlier);
  return analyse(read(String(positionals['file'])), before, options);
}

runWhenMain(import.meta.url, SPEC, compute);
