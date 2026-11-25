#!/usr/bin/env node
// A customer survey, tallied by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`):
//
//   analyse.mjs <responses.csv|responses.xlsx> [--month YYYY-MM]
//
// It reads a survey tool's export (one row per response: the date, the support channel, three
// ratings from 1 to 5, a recommend score from 0 to 10 and an optional comment) with the built-in
// table reader (ADR-0173), and prints JSON on stdout for the month (default: the export's last).
// Every figure is an aggregate of the channels with at least MIN_GROUP responses; a smaller
// channel is named in `heldBack` and left out of every figure, so no figure can be taken apart to
// reach a smaller group. Per rating, the mean (two decimals) and the favourable share (4 or 5, a
// percent to one decimal); the Net Promoter Score (promoters 9–10 minus detractors 0–6, a percent
// of the responses to one decimal); per channel, the mean overall rating and its score; and the
// comments as text, with no response ID or date. A month with no channel that large is refused.
// It never prints a response ID, so no answer can be traced to a respondent. A file, row, value or
// option it cannot read prints `{ "error", "message" }` on stderr and exits 1 (2 for the
// arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The fewest responses a group may have before any figure of it is printed. */
export const MIN_GROUP = 5;
const whole = (/** @type {string[]} */ names) => ({ names, type: /** @type {const} */ ('whole') });
const RATINGS = /** @type {const} */ ({
  overall: ['総合満足度', 'overall'],
  speed: ['対応の速さ', 'speed'],
  clarity: ['説明のわかりやすさ', 'clarity'],
});
const COLUMNS = {
  date: { names: ['回答日', 'submitted_on'], type: /** @type {const} */ ('date') },
  channel: ['窓口', 'channel'],
  overall: whole([...RATINGS.overall]),
  speed: whole([...RATINGS.speed]),
  clarity: whole([...RATINGS.clarity]),
  recommend: whole(['推奨度', 'recommend']),
  comment: { names: ['自由記述', 'comment'], optional: true },
};

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <responses.csv|responses.xlsx> [--month YYYY-MM]',
  positionals: ['file'],
  options: { month: {} },
};

/** `part` of `whole` as a percent, rounded half away from zero to one decimal. */
const percent = (/** @type {number} */ part, /** @type {number} */ all) =>
  (Math.sign(part) * Math.round(Math.abs(part * 1000) / all)) / 10;

/** The mean of `values`, rounded half away from zero to two decimals. */
const mean = (/** @type {readonly number[]} */ values) =>
  Math.round((values.reduce((sum, value) => sum + value, 0) * 100) / values.length) / 100;

/**
 * The Net Promoter Score of the recommend scores.
 * @param {readonly { recommend: number }[]} rows
 */
function nps(rows) {
  const promoters = rows.filter((row) => row.recommend >= 9).length;
  const detractors = rows.filter((row) => row.recommend <= 6).length;
  const passives = rows.length - promoters - detractors;
  return { promoters, passives, detractors, score: percent(promoters - detractors, rows.length) };
}

/**
 * The tally of the export's rows; `columns` is its header as written (it names the questions).
 * @param {{ columns: readonly string[], rows: readonly { date: string, channel: string, overall: number, speed: number, clarity: number, recommend: number, comment: string | null }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ month?: string }>} options `month` (YYYY-MM)
 * @throws {TableError}
 */
export function analyse({ columns, rows, rowNumbers }, options) {
  for (const [at, row] of rows.entries()) {
    const ratings = [row.overall, row.speed, row.clarity];
    const bad = ratings.some((value) => value < 1 || value > 5) || Math.abs(row.recommend - 5) > 5;
    if (bad)
      throw new TableError('out_of_range', `row ${String(rowNumbers[at])}: a score is off scale`, {
        row: Number(rowNumbers[at]),
      });
  }
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  const months = [...new Set(rows.map((row) => row.date.slice(0, 7)))].sort();
  const month = options.month ?? String(months.at(-1));
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month))
    throw new TableError('usage', `--month "${month}" is not YYYY-MM`);
  if (!months.includes(month))
    throw new TableError('unknown_month', `no ${month} in the export: ${months.join(', ')}`);
  const inMonth = rows.filter((row) => row.date.startsWith(month));
  const groups = [...new Set(inMonth.map((row) => row.channel))].map((channel) => ({
    channel,
    rows: inMonth.filter((row) => row.channel === channel),
  }));
  const shown = groups.filter((group) => group.rows.length >= MIN_GROUP);
  const covered = shown.flatMap((group) => group.rows);
  if (covered.length === 0)
    throw new TableError(
      'too_few_responses',
      `no channel has ${String(MIN_GROUP)} or more responses in ${month}`,
    );
  const questions = Object.entries(RATINGS).map(([key, names]) => {
    const scores = covered.map((row) => row[/** @type {keyof typeof RATINGS} */ (key)]);
    return {
      question: String(columns.find((name) => names.some((known) => known === name))),
      mean: mean(scores),
      favourable: percent(scores.filter((score) => score >= 4).length, scores.length),
    };
  });
  const channels = shown.map(({ channel, rows: own }) => ({
    channel,
    responses: own.length,
    overall: mean(own.map((row) => row.overall)),
    nps: nps(own).score,
  }));
  const heldBack = groups.filter((group) => group.rows.length < MIN_GROUP).map((g) => g.channel);
  const comments = covered.flatMap((row) => (row.comment === null ? [] : [row.comment]));
  return {
    month,
    responses: covered.length,
    minGroup: MIN_GROUP,
    questions,
    nps: nps(covered),
    channels,
    heldBack,
    comments,
  };
}

/**
 * The command line: read the export named first, then tally it with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
