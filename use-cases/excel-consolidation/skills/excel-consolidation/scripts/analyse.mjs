#!/usr/bin/env node
// Branch sales workbooks of different layouts consolidated into one table, as `run_skill_script`
// runs it:
//
//   analyse.mjs <folder> --from <YYYY-MM> --to <YYYY-MM> [--book outputs/<name>.json]
//
// It reads every .xlsx under the folder (one subfolder per branch, its name the branch's) with the
// built-in table reader (ADR-0173): the first sheet, its first non-blank row the header. It finds
// the date, category and amount columns by their names, in Japanese or English, whatever their
// order (a unit in brackets after the name is the amount's: 千円 / thousand is ×1000, else yen);
// keeps each row with a date (YYYY-MM-DD or YYYY/M/D) and a number, and skips a subtotal or total
// row and a note, naming each. A workbook without those three columns (an expense report) or with
// no row (a template) is left out with the reason. It prints, in yen, each branch's total of the
// two months, the change and the change % (of the first month, rounded half up to one
// decimal, null from 0), largest change first, and the total; with `--book`, it also writes the
// consolidated table as an office-writer model (a detail sheet with each row's source and the
// comparison) for `write.mjs` to render. Anything it cannot read is refused on stderr.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import * as table from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

export const SPEC = {
  usage: 'analyse.mjs <folder> --from <YYYY-MM> --to <YYYY-MM> [--book outputs/<name>.json]',
  positionals: ['folder'],
  options: { from: {}, to: {}, book: { default: '' } },
};
const NAMES = {
  date: ['日付', '売上日', '計上日', 'date', 'sales date', 'booked on'],
  category: ['区分', '品目', 'category', 'item'],
  amount: ['金額', '売上金額', '売上', 'amount', 'sales'],
};
const TOTAL = /^(小計|合計|subtotal|total)/iu;
const DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u;
const MONTH = /^\d{4}-\d{2}$/u;

/** The change % of `to` against `from`, rounded half up to one decimal; null from 0. */
/** @param {number} from @param {number} to */
const pct = (from, to) => (from === 0 ? null : Math.round(((to - from) * 1000) / from) / 10);

/** @param {string} file one workbook: its rows in yen, or why it is left out */
function read(file) {
  const { columns, rows, rowNumbers } = table.readTable(file);
  /** @param {string[]} names the header names a column may have, before a bracketed unit */
  const pick = (names) =>
    columns.find((h) => names.includes(h.replace(/\s*[（(].*$/u, '').toLowerCase()));
  const [date, category, amount] = [pick(NAMES.date), pick(NAMES.category), pick(NAMES.amount)];
  if (!date || !category || !amount) return { reason: 'no date, category and amount columns' };
  if (rows.length === 0) return { reason: 'no rows' };
  const unit = /千円|thousand/iu.test(amount) ? 1000 : 1;
  /** @type {{ date: string, category: string, yen: number, row: number }[]} */
  const kept = [];
  /** @type {{ row: number, cells: string }[]} */
  const skipped = [];
  for (const [at, row] of rows.entries()) {
    const [said, kind, figure] = [date, category, amount].map((key) => `${row[key] ?? ''}`.trim());
    const day = DATE.exec(String(said));
    const yen = Number(String(figure).replaceAll(',', '')) * unit;
    const where = { row: Number(rowNumbers[at]), cells: [said, kind, figure].join(' ').trim() };
    if (day === null || TOTAL.test(String(kind)) || figure === '' || !Number.isFinite(yen))
      skipped.push(where);
    else {
      const [, y, m, d] = /** @type {[string, string, string, string]} */ ([...day]);
      const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      kept.push({ date, category: String(kind), yen, row: where.row });
    }
  }
  return { unit: unit === 1 ? '円' : '千円', kept, skipped };
}

/** @param {import('@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs').ParsedArgs} args */
export function compute({ positionals, options }) {
  const folder = String(positionals['folder']);
  const [from, to] = [String(options['from']), String(options['to'])];
  const out = String(options['book']);
  if (out !== '' && existsSync(out))
    throw new table.TableError('output_exists', `${out} exists already`);
  if (!MONTH.test(from) || !MONTH.test(to))
    throw new table.TableError('usage', '--from and --to are YYYY-MM');
  const files = readdirSync(folder, { recursive: true, encoding: 'utf8' });
  /** @type {{ file: string, branch: string, unit: string, rows: number, skipped: { row: number, cells: string }[] }[]} */
  const layouts = [];
  /** @type {{ file: string, reason: string }[]} */
  const excluded = [];
  /** @type {{ branch: string, date: string, category: string, yen: number, row: number, source: string }[]} */
  const lines = [];
  for (const file of files.filter((name) => name.endsWith('.xlsx')).sort()) {
    const [branch, source] = [path.dirname(file), path.join(folder, file)];
    const result = read(source);
    if ('reason' in result) excluded.push({ file: source, reason: result.reason });
    else {
      const { unit, kept, skipped } = result;
      layouts.push({ file: source, branch, unit, rows: kept.length, skipped });
      lines.push(
        ...kept.map((line) => ({ branch, ...line, source: `${source} row ${String(line.row)}` })),
      );
    }
  }
  const period = lines.filter((line) => [from, to].includes(line.date.slice(0, 7)));
  const sum = (/** @type {typeof lines} */ own, /** @type {string} */ month) =>
    own.filter((line) => line.date.startsWith(month)).reduce((total, line) => total + line.yen, 0);
  const figures = (/** @type {typeof lines} */ own) => {
    const [before, after] = [sum(own, from), sum(own, to)];
    return { from: before, to: after, change: after - before, changePct: pct(before, after) };
  };
  const largest = (/** @type {{ change: number }} */ a, /** @type {{ change: number }} */ b) =>
    Math.abs(b.change) - Math.abs(a.change);
  /** @param {typeof lines} own one branch's lines: each category's figures, largest change first */
  const categories = (own) =>
    [...new Set(own.map((line) => line.category))]
      .map((category) => ({ category, ...figures(own.filter((l) => l.category === category)) }))
      .sort(largest);
  const branches = [...new Set(period.map((line) => line.branch))]
    .map((branch) => period.filter((line) => line.branch === branch))
    .map((own) => ({
      branch: String(own.map((l) => l.branch)[0]),
      ...figures(own),
      categories: categories(own),
    }))
    .sort(largest);
  const total = figures(period);
  const compared = [...branches, { branch: '合計 / Total', ...total }];
  const book = {
    format: 'xlsx',
    sheets: [
      {
        name: 'Detail',
        header: ['拠点 Branch', '日付 Date', '区分 Category', '金額 JPY', '出典 Source'],
        rows: period.map((l) => [l.branch, { date: l.date }, l.category, l.yen, l.source]),
      },
      {
        name: 'Comparison',
        header: ['拠点 Branch', from, to, '増減 Change', '増減率 Change %'],
        rows: compared.map((b) => [b.branch, b.from, b.to, b.change, b.changePct]),
      },
    ],
  };
  if (out !== '') writeFileSync(out, `${JSON.stringify(book, null, 2)}\n`);
  return { from, to, layouts, excluded, branches, total, book: out === '' ? null : out };
}

runWhenMain(import.meta.url, SPEC, compute);
