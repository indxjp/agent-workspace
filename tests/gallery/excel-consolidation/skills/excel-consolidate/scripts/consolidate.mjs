#!/usr/bin/env node
/* global process */ // The root ESLint config declares no environment globals.
// Consolidate branch sales workbooks into one table, by a mapping plan a person has confirmed.
//
// It reads the .xlsx files itself, with `./xlsx.mjs` (a copy of office-reader's reader): a
// `run_skill_script` call starts one script, so one script cannot take another's output from a
// pipe. A skill is uploaded as its own directory, so that sibling file is the only import. A result
// goes to stdout and, with `--out`, also to that file (under `outputs/`, where a run may write), for
// the next call to read.
//
//   consolidate.mjs inspect <book.xlsx>...                       → each sheet's first rows, lettered, and its unit
//   consolidate.mjs apply <plan.json> <book.xlsx>... [--out f]   → { rows, totals, skipped }
//   consolidate.mjs compare <applied.json> <from> <to> [--out f] → applied + { comparison }
//   consolidate.mjs sheet <report.json> [--out f]                → { sheets } for office-reader's `ooxml.mjs write`
//
// Every row keeps `@src`: the `file!sheet!cell` each value came from. Units and dates are converted
// here, by rule, never by the model: 千円 × 1,000, 百万円 × 1,000,000, 令和/平成/昭和 → ISO.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OoxmlRefusal, readXlsx } from './xlsx.mjs';

export const UNITS = { 円: 1, 千円: 1_000, 百万円: 1_000_000 };
export const DATE_FORMATS = ['wareki', 'ymd', 'serial'];
export const FIELDS = ['date', 'category', 'amount'];

/** Thrown for a plan or a workbook the script will not guess about; the CLI prints it and exits 1. */
export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

const fail = (message) => {
  throw new PlanError(message);
};

const normalize = (value) => String(value).normalize('NFKC').trim();

// ---------- dates ----------

/** Era name → [Gregorian year of its first year, first day, last day (inclusive) or null]. */
const ERAS = {
  令和: [2019, '2019-05-01', null],
  平成: [1989, '1989-01-08', '2019-04-30'],
  昭和: [1926, '1926-12-25', '1989-01-07'],
};
const ERA_LETTERS = { R: '令和', H: '平成', S: '昭和' };

const pad = (number) => String(number).padStart(2, '0');

function isoOf(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    fail(`${year}-${month}-${day} is not a calendar date`);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** '令和7年5月12日', '令和元年5月1日', 'R7.5.12', 'H31/4/30' → ISO date. */
export function warekiToIso(text) {
  const value = normalize(text);
  const long = /^(令和|平成|昭和)(元|\d{1,2})年(\d{1,2})月(\d{1,2})日$/u.exec(value);
  const short = /^([RHS])(\d{1,2})[./](\d{1,2})[./](\d{1,2})$/u.exec(value);
  const match = long ?? short;
  if (match === null) fail(`not a 和暦 date: ${value}`);
  const era = ERA_LETTERS[match[1]] ?? match[1];
  const [firstYear, first, last] = ERAS[era];
  const eraYear = match[2] === '元' ? 1 : Number(match[2]);
  const iso = isoOf(firstYear + eraYear - 1, Number(match[3]), Number(match[4]));
  if (iso < first || (last !== null && iso > last)) fail(`${value} is outside the ${era} era`);
  return iso;
}

/** An Excel serial day number (1900 date system) → ISO date. */
export function serialToIso(serial) {
  if (!Number.isInteger(serial) || serial < 61) fail(`not an Excel date serial: ${serial}`);
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
  return isoOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** '2025/05/08', '2025-5-8', '2025年5月8日' → ISO date. */
export function ymdToIso(text) {
  const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/u.exec(normalize(text));
  if (match === null) fail(`not a yyyy/mm/dd date: ${normalize(text)}`);
  return isoOf(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function parseDate(value, format) {
  if (format === 'serial') return serialToIso(value);
  if (typeof value !== 'string') fail(`expected a ${format} date string, got ${String(value)}`);
  return format === 'wareki' ? warekiToIso(value) : ymdToIso(value);
}

// ---------- the plan ----------

const COLUMN = /^[A-Z]{1,3}$/u;

function columnIndex(letters) {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** The unit a header label states, if it states one. */
export function unitInLabel(label) {
  const text = normalize(label);
  if (text.includes('百万円')) return '百万円';
  if (text.includes('千円')) return '千円';
  if (text.includes('円')) return '円';
  return null;
}

function checkLayout(layout, index) {
  const at = `layouts[${index}]`;
  if (typeof layout?.branch !== 'string' || layout.branch === '') fail(`${at}.branch is required`);
  if (!Array.isArray(layout.files) || layout.files.length === 0) fail(`${at}.files is empty`);
  if (typeof layout.sheet !== 'string' || layout.sheet === '') fail(`${at}.sheet is required`);
  if (
    !Array.isArray(layout.headerRows) ||
    layout.headerRows.length === 0 ||
    !layout.headerRows.every((row) => Number.isInteger(row) && row >= 1)
  )
    fail(`${at}.headerRows must list 1-based row numbers`);
  for (const field of FIELDS) {
    if (!COLUMN.test(layout.columns?.[field] ?? ''))
      fail(`${at}.columns.${field} must be a column letter`);
  }
  if (!Object.hasOwn(UNITS, layout.unit))
    fail(`${at}.unit must be one of ${Object.keys(UNITS).join(', ')}`);
  if (!DATE_FORMATS.includes(layout.dateFormat))
    fail(`${at}.dateFormat must be one of ${DATE_FORMATS.join(', ')}`);
  if (layout.skip !== undefined && !Array.isArray(layout.skip)) fail(`${at}.skip must be a list`);
}

// ---------- apply ----------

/**
 * Apply `plan` to `books` (file path as the plan names it → `readXlsx` result) and return every
 * data row with its sources, the totals by month and branch, and every row left out, with why.
 */
export function applyPlan(plan, books) {
  if (!Array.isArray(plan?.layouts) || plan.layouts.length === 0) fail('plan.layouts is empty');
  plan.layouts.forEach(checkLayout);
  const rows = [];
  const skipped = [];
  const totals = {};
  for (const layout of plan.layouts) {
    const multiplier = UNITS[layout.unit];
    const skip = (layout.skip ?? []).map(normalize);
    const lastHeader = Math.max(...layout.headerRows);
    for (const file of layout.files) {
      const book = books[file] ?? fail(`no workbook given for ${file}`);
      const sheet =
        book.sheets.find((candidate) => candidate.name === layout.sheet) ??
        fail(`${file} has no sheet named ${layout.sheet}`);
      const at = (field, row) => `${file}!${sheet.name}!${layout.columns[field]}${row}`;
      const valueAt = (field, row) =>
        sheet.rows[row - 1]?.[columnIndex(layout.columns[field])] ?? null;

      // The amount column's header must not contradict the plan's unit: 千円 read as 円 is the
      // classic thousand-fold error in a consolidated report.
      const label = [...new Set(layout.headerRows.map((row) => valueAt('amount', row)))]
        .filter((value) => value !== null)
        .join(' / ');
      const stated = unitInLabel(label);
      if (stated !== null && stated !== layout.unit)
        fail(
          `${at('amount', lastHeader)} says ${stated} (${label}) but the plan says ${layout.unit}`,
        );

      for (let row = lastHeader + 1; row <= sheet.rows.length; row += 1) {
        const cells = sheet.rows[row - 1] ?? [];
        if (cells.every((value) => value === null)) continue;
        // Subtotal and note markers are looked for in the identifying columns only, so a remark
        // such as ※値引後 in a notes column does not drop a real sale.
        const marker = [valueAt('date', row), valueAt('category', row)]
          .filter((value) => typeof value === 'string')
          .map(normalize)
          .find((text) => skip.some((prefix) => text.startsWith(prefix)));
        if (marker !== undefined) {
          skipped.push({ src: `${file}!${sheet.name}!${row}`, reason: 'skip', text: marker });
          continue;
        }
        const amount = valueAt('amount', row);
        if (typeof amount !== 'number') {
          skipped.push({
            src: at('amount', row),
            reason: 'amount is not a number',
            text: String(amount),
          });
          continue;
        }
        const date = parseDate(valueAt('date', row), layout.dateFormat);
        const category = valueAt('category', row);
        const yen = Math.round(amount * multiplier);
        const month = date.slice(0, 7);
        rows.push({
          branch: layout.branch,
          date,
          month,
          category: category === null ? null : normalize(category),
          amount: yen,
          raw: { amount, unit: layout.unit },
          '@src': {
            date: at('date', row),
            category: at('category', row),
            amount: at('amount', row),
          },
        });
        totals[month] ??= {};
        totals[month][layout.branch] = (totals[month][layout.branch] ?? 0) + yen;
      }
    }
  }
  // A branch may need two layouts (福岡 renames its sheet every month); it is still one branch.
  const branches = [...new Set(plan.layouts.map((layout) => layout.branch))];
  return { branches, rows, totals, skipped };
}

// ---------- compare ----------

const percent = (diff, previous) =>
  previous === 0 ? null : Math.round((diff / previous) * 1000) / 10;

/** Month-over-month by branch, in the plan's branch order, and for all branches together. */
export function compare(applied, from, to) {
  const before = applied.totals[from] ?? fail(`no rows dated ${from}`);
  const after = applied.totals[to] ?? fail(`no rows dated ${to}`);
  const branches = applied.branches.map((branch) => {
    const previous = before[branch] ?? 0;
    const current = after[branch] ?? 0;
    const diff = current - previous;
    return { branch, previous, current, diff, pct: percent(diff, previous) };
  });
  const previous = branches.reduce((sum, entry) => sum + entry.previous, 0);
  const current = branches.reduce((sum, entry) => sum + entry.current, 0);
  return {
    ...applied,
    comparison: {
      from,
      to,
      branches,
      total: {
        previous,
        current,
        diff: current - previous,
        pct: percent(current - previous, previous),
      },
    },
  };
}

/**
 * The report as a workbook for `ooxml.mjs write`: 明細 (every row with its source cell) and 前月比
 * (each branch, then the total). Values are the report's own; nothing is recomputed here.
 */
export function workbookSpec(report) {
  const { from, to, branches, total } = report.comparison;
  const change = (label, entry) => [label, entry.previous, entry.current, entry.diff, entry.pct];
  return {
    sheets: [
      {
        name: '明細',
        rows: [
          ['拠点', '日付', '区分', '金額(円)', '出典'],
          ...report.rows.map((row) => [
            row.branch,
            row.date,
            row.category,
            row.amount,
            row['@src'].amount,
          ]),
        ],
      },
      {
        name: '前月比',
        rows: [
          ['拠点', from, to, '差額(円)', '増減率(%)'],
          ...branches.map((entry) => change(entry.branch, entry)),
          change('合計', total),
        ],
      },
    ],
  };
}

// ---------- inspect ----------

const letter = (index) => {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
};

const UNIT_ROW = /単位\s*[:：]\s*(百万円|千円|円)/u;
const UNIT_HEADER = /[（(]\s*(百万円|千円|円)\s*[）)]/u;

/**
 * The unit a sheet states in its first `count` rows, with the cell that says so: a 単位 row
 * (「単位：千円」) wins over a header label (「金額（千円）」). `null` when neither is there.
 */
export function detectUnit(sheet, count = 8) {
  const found = [];
  sheet.rows.slice(0, count).forEach((cells, rowIndex) => {
    cells.forEach((value, column) => {
      if (typeof value !== 'string') return;
      const text = normalize(value);
      const row = UNIT_ROW.exec(text);
      const header = UNIT_HEADER.exec(text);
      const cell = `${letter(column)}${String(rowIndex + 1)}`;
      if (row) found.push({ rank: 0, unit: row[1], cell, text });
      else if (header) found.push({ rank: 1, unit: header[1], cell, text });
    });
  });
  const best = found.sort((left, right) => left.rank - right.rank)[0];
  return best === undefined ? null : { unit: best.unit, cell: best.cell, text: best.text };
}

/** The first `count` rows of each sheet, keyed by row number and column letter, and its unit: what to map. */
export function inspect(book, count = 8) {
  return book.sheets.map((sheet) => {
    const unit = detectUnit(sheet, count);
    return {
      sheet: sheet.name,
      unit: unit?.unit ?? null,
      unitFrom: unit === null ? null : `${unit.cell} ${unit.text}`,
      merges: sheet.merges,
      rowCount: sheet.rows.length,
      rows: sheet.rows.slice(0, count).map((cells, index) => ({
        row: index + 1,
        cells: Object.fromEntries(
          cells.flatMap((value, column) => (value === null ? [] : [[letter(column), value]])),
        ),
      })),
    };
  });
}

// ---------- command line ----------

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const readBook = (file) => readXlsx(readFileSync(file));

/** Workbooks are matched to plan entries by file name, so a plan may name a path the run reads elsewhere. */
function booksFor(plan, bookFiles) {
  const byName = new Map(bookFiles.map((file) => [path.basename(file), file]));
  const books = {};
  for (const file of plan.layouts.flatMap((layout) => layout.files)) {
    const found =
      byName.get(path.basename(file)) ?? fail(`no ${path.basename(file)} given for ${file}`);
    books[file] = readBook(found);
  }
  return books;
}

function main(args) {
  const [command, ...rest] = args;
  if (command === 'inspect' && rest.length >= 1)
    return rest.map((file) => ({ file: path.basename(file), sheets: inspect(readBook(file)) }));
  if (command === 'apply' && rest.length >= 2) {
    const plan = readJson(rest[0]);
    return applyPlan(plan, booksFor(plan, rest.slice(1)));
  }
  if (command === 'compare' && rest.length === 3)
    return compare(readJson(rest[0]), rest[1], rest[2]);
  if (command === 'sheet' && rest.length === 1) return workbookSpec(readJson(rest[0]));
  process.stderr.write(
    'usage: consolidate.mjs inspect <book.xlsx>... | apply <plan.json> <book.xlsx>... [--out <file>] | compare <applied.json> <YYYY-MM> <YYYY-MM> [--out <file>] | sheet <report.json> [--out <file>]\n',
  );
  process.exit(2);
}

/** `--out <file>` and the arguments without it. */
function splitOut(argv) {
  const at = argv.indexOf('--out');
  if (at === -1) return { out: null, args: argv };
  const out = argv[at + 1];
  if (out === undefined || out.startsWith('--')) fail('--out needs a file name');
  return { out, args: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { out, args } = splitOut(process.argv.slice(2));
    const json = `${JSON.stringify(main(args), null, 2)}\n`;
    if (out !== null) writeFileSync(out, json);
    process.stdout.write(json);
  } catch (error) {
    if (!(error instanceof PlanError || error instanceof OoxmlRefusal)) throw error;
    process.stderr.write(`consolidate: ${error.message}\n`);
    process.exit(1);
  }
}
