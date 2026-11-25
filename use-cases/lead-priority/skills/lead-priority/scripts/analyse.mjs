#!/usr/bin/env node
// Lead priority, by rule, as `run_skill_script` runs it (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <leads.csv|leads.xlsx> [--as-of YYYY-MM-DD] [--source <source>] [--top <n>]
//
// It reads a lead export (one row per lead, that is one enquiry from one company; the Japanese or
// the English column names) with the built-in table reader (ADR-0173) and prints JSON on stdout:
// each lead's points by fixed rules (where it came from, the company's size, its web visits in the
// last 30 days and how recently it was contacted, as of the export's latest contact unless given),
// their sum as the score out of 100, and the leads in order of score (then lead id), with the
// average score per source as the chart rows. It scores leads, never a person: the export holds no
// person, and nothing here reads one. A file, row, column, value or option it cannot read prints
// `{ "error", "message" }` on stderr and exits 1 (2 for the arguments): it never guesses. It
// writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The export's columns: the Japanese and the English name, and what a value must be. */
const COLUMNS = /** @type {const} */ ({
  leadId: ['リードID', 'lead_id'],
  company: ['会社名', 'company'],
  industry: ['業種', 'industry'],
  source: ['流入元', 'source'],
  employees: { names: ['従業員数', 'employees'], type: 'whole' },
  visits: { names: ['直近30日の訪問数', 'visits_30d'], type: 'whole' },
  lastContact: { names: ['最終接触日', 'last_contact'], type: 'date' },
});

/**
 * Each source by its Japanese and its English name: one code, and its points.
 * @type {ReadonlyMap<string, { code: string, points: number }>}
 */
const SOURCES = new Map(
  /** @type {const} */ ([
    ['問い合わせ', 'inquiry', 40],
    ['展示会', 'event', 25],
    ['ウェビナー', 'webinar', 20],
    ['資料請求', 'download', 15],
  ]).flatMap(([ja, code, points]) => [
    [ja, { code, points }],
    [code, { code, points }],
  ]),
);

/** The command line `run_skill_script` passes: the export, then the options. */
export const SPEC = {
  usage: 'analyse.mjs <leads.csv|leads.xlsx> [--as-of YYYY-MM-DD] [--source <source>] [--top <n>]',
  positionals: ['file'],
  options: { 'as-of': {}, source: {}, top: { default: '10' } },
};

const DAY = 86_400_000;

/**
 * The scored leads of the export's rows; `rowNumbers[i]` is where `rows[i]` is in the file.
 * @param {{ rows: readonly { leadId: string, company: string, industry: string, source: string, employees: number, visits: number, lastContact: string }[], rowNumbers: readonly number[] }} table
 * @param {Readonly<{ 'as-of'?: string, source?: string, top?: string }>} options
 * @throws {TableError}
 */
export function analyse({ rows, rowNumbers }, options) {
  const top = options.top ?? '10';
  if (!/^[1-9]\d*$/u.test(top)) throw new TableError('usage', `--top "${top}" is not a count`);
  const only = options.source === undefined ? undefined : SOURCES.get(options.source)?.code;
  if (only === undefined && options.source !== undefined)
    throw new TableError('usage', `--source "${options.source}" is not a source`);
  if (rows.length === 0) throw new TableError('no_rows', 'the export has no rows under its header');
  const latest = rows.map((row) => row.lastContact).sort();
  const asOf = options['as-of'] ?? String(latest.at(-1));
  const time = Date.parse(asOf);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf) || !new Date(time || 0).toISOString().startsWith(asOf))
    throw new TableError('usage', `--as-of "${asOf}" is not a date (YYYY-MM-DD)`);
  const seen = new Set();
  const scored = rows.map((row, at) => {
    const where = { row: Number(rowNumbers[at]) };
    const source = SOURCES.get(row.source);
    if (source === undefined) {
      const cell = { ...where, column: 'source', value: row.source };
      throw new TableError(
        'unknown_source',
        `row ${String(where.row)}: no source "${row.source}"`,
        cell,
      );
    }
    if (seen.has(row.leadId))
      throw new TableError('duplicate_lead', `${row.leadId} appears in more than one row`, where);
    seen.add(row.leadId);
    const days = (time - Date.parse(row.lastContact)) / DAY;
    if (days < 0) {
      const cell = { ...where, column: 'last_contact', value: row.lastContact };
      throw new TableError('after_as_of', `row ${String(where.row)}: after ${asOf}`, cell);
    }
    const points = {
      source: source.points,
      size: row.employees >= 300 ? 20 : row.employees >= 50 ? 10 : 0,
      visits: Math.min(row.visits, 10) * 3,
      recency: days <= 7 ? 10 : days <= 30 ? 5 : 0,
    };
    const score = points.source + points.size + points.visits + points.recency;
    const { leadId, company, industry } = row;
    const lead = { leadId, company, industry, source: row.source, daysSinceContact: days };
    return { ...lead, score, points, code: source.code };
  });
  scored.sort((a, b) => b.score - a.score || a.leadId.localeCompare(b.leadId));
  const picked = scored.filter((lead) => only === undefined || lead.code === only);
  const leads = picked
    .slice(0, Number(top))
    .map(({ code, ...lead }, at) => ({ rank: at + 1, ...lead, code }));
  const sources = [...new Set(scored.map((lead) => lead.source))].map((source) => {
    const own = scored.filter((lead) => lead.source === source);
    const sum = own.reduce((total, lead) => total + lead.score, 0);
    return { source, leads: own.length, averageScore: Math.round((sum * 10) / own.length) / 10 };
  });
  return { asOf, source: options.source ?? null, count: picked.length, leads, sources };
}

/**
 * The command line: read the export named first, then score it with the options.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(readTable(String(positionals['file']), { columns: COLUMNS }), options);

runWhenMain(import.meta.url, SPEC, compute);
