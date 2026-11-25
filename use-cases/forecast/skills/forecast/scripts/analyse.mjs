#!/usr/bin/env node
// A quarter's sales forecast, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`, no
// shell):
//
//   analyse.mjs <export.csv|export.xlsx> [--quarter YYYY-Qn] [--target <yen>]
//
// It reads a CRM deal export (one row per deal; the Japanese or the English column names) with the
// built-in table reader (ADR-0173) and prints JSON on stdout for the quarter (default: the quarter
// of the export's latest close month): per month and in total, the won amount, the open pipeline,
// the weighted pipeline (each open deal's amount × its probability / 100, rounded half away from
// zero to whole yen) and the forecast (won + weighted); the best case (won + pipeline); the lost
// deals' count and amount; the open deals by weighted amount; and, with a target, the gap
// (forecast − target) and the attainment % (one decimal, half away from zero). A file, row, column,
// value or option it cannot read prints `{ "error", "message" }` on stderr and exits 1 (2 for the
// arguments): it never guesses. It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The export's columns: the Japanese and the English name, and what a value must be. */
const COLUMNS = /** @type {const} */ ({
  deal: ['案件ID', 'deal_id'],
  customer: ['顧客', 'customer'],
  stage: ['ステージ', 'stage'],
  amount: { names: ['金額', 'amount'], type: 'whole' },
  probability: { names: ['確度', 'probability'], type: 'whole' },
  month: ['受注予定月', 'close_month'],
});

/** The stages, in either language. */
const STAGES = new Map(Object.entries({ 受注: 'won', 商談中: 'open', 失注: 'lost' }));
for (const stage of ['won', 'open', 'lost']) STAGES.set(stage, stage);

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <export.csv|export.xlsx> [--quarter YYYY-Qn] [--target <yen>]',
  positionals: ['file'],
  options: { quarter: {}, target: {} },
};

/** @param {string} month YYYY-MM */
const quarterOf = (month) =>
  `${month.slice(0, 4)}-Q${String(Math.ceil(Number(month.slice(5)) / 3))}`;

/**
 * @typedef {{ deal: string, customer: string, stage: string, amount: number, probability: number, month: string, weighted: number }} Deal
 * @param {readonly Deal[]} deals
 * @param {'amount' | 'weighted'} key
 */
const sum = (deals, key) => deals.reduce((total, deal) => total + deal[key], 0);

/** Won, weighted, pipeline and forecast of the deals. @param {readonly Deal[]} deals */
function figures(deals) {
  const of = (/** @type {string} */ stage) => deals.filter((deal) => deal.stage === stage);
  const [won, weighted] = [sum(of('won'), 'amount'), sum(of('open'), 'weighted')];
  return { won, weighted, pipeline: sum(of('open'), 'amount'), forecast: won + weighted };
}

/**
 * The forecast of the export's rows; `rowNumbers[i]` is where `rows[i]` is in the file.
 * @param {{ rows: readonly { deal: string, customer: string, stage: string, amount: number, probability: number, month: string }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ quarter?: string, target?: string }>} options
 * @throws {TableError}
 */
export function analyse({ rows, rowNumbers }, options) {
  const { quarter: asked, target } = options;
  if (asked !== undefined && !/^\d{4}-Q[1-4]$/u.test(asked))
    throw new TableError('usage', `--quarter "${asked}" is not YYYY-Qn`);
  if (target !== undefined && !/^[1-9]\d*$/u.test(target))
    throw new TableError('usage', `--target "${target}" is not whole yen`);
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  const seen = new Set();
  /** @type {Deal[]} */
  const deals = rows.map((row, at) => {
    /** A refusal of `value` in `column` of this row. @param {string} code @param {keyof typeof COLUMNS} column @param {string | number} value @param {string} why */
    const refuse = (code, column, value, why) => {
      const where = { row: Number(rowNumbers[at]), column, value: String(value) };
      return new TableError(code, `row ${String(where.row)}: "${where.value}" ${why}`, where);
    };
    const stage = STAGES.get(row.stage);
    if (stage === undefined)
      throw refuse('unknown_stage', 'stage', row.stage, 'is not a stage it knows');
    if (!/^\d{4}[-/](?:0[1-9]|1[0-2])$/u.test(row.month))
      throw refuse('not_a_month', 'month', row.month, 'is not YYYY-MM');
    if (row.amount < 0) throw refuse('not_an_amount', 'amount', row.amount, 'is below zero');
    if (row.probability < 0 || row.probability > 100)
      throw refuse('not_a_probability', 'probability', row.probability, 'is not 0 to 100');
    if (seen.has(row.deal))
      throw refuse('duplicate_deal', 'deal', row.deal, 'appears in more than one row');
    seen.add(row.deal);
    const weighted = stage === 'open' ? Math.round((row.amount * row.probability) / 100) : 0;
    return { ...row, stage, month: row.month.replace('/', '-'), weighted };
  });
  const months = deals.map((deal) => deal.month).sort();
  const quarter = asked ?? quarterOf(String(months.at(-1)));
  const inQuarter = deals.filter((deal) => quarterOf(deal.month) === quarter);
  if (inQuarter.length === 0) {
    const known = [...new Set(months.map(quarterOf))].join(', ');
    throw new TableError('unknown_quarter', `no deal closes in ${quarter}: ${known}`);
  }
  const first = (Number(quarter.slice(6)) - 1) * 3;
  const byMonth = [1, 2, 3].map((n) => {
    const month = `${quarter.slice(0, 4)}-${String(first + n).padStart(2, '0')}`;
    return { month, ...figures(inQuarter.filter((deal) => deal.month === month)) };
  });
  const all = figures(inQuarter);
  const total = { ...all, bestCase: all.won + all.pipeline };
  const lostDeals = inQuarter.filter((deal) => deal.stage === 'lost');
  const open = inQuarter
    .filter((deal) => deal.stage === 'open')
    .sort((a, b) => b.weighted - a.weighted || a.deal.localeCompare(b.deal))
    .map(({ deal, customer, amount, probability, month, weighted }) => ({
      deal,
      customer,
      amount,
      probability,
      month,
      weighted,
    }));
  const goal = Number(target);
  const attainmentPct = Math.round((total.forecast * 1000) / goal) / 10;
  const versus =
    target === undefined ? null : { target: goal, gap: total.forecast - goal, attainmentPct };
  const lost = { count: lostDeals.length, amount: sum(lostDeals, 'amount') };
  return { quarter, months: byMonth, total, target: versus, lost, deals: open };
}

/**
 * The command line: read the export named first, then forecast it with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
