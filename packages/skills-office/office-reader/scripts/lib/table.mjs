// A table from a CSV or .xlsx file, with typed columns, for a use case's own skill script
// (ADR-0173). Plain JavaScript that runs with Node alone in a run's sandbox: an entry's script
// imports it as `@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs`, which
// `run_skill_script` resolves to this file of the placed office-reader skill.
//
// It never guesses: a stray or unclosed quote, a row with more or fewer cells than the header, a
// missing column, an empty required cell, a number it cannot read, an .xlsx error cell, a number
// that is only part of a merged range and a date cell read as anything but a date are each a
// TableError naming the row (as a person finds it: the file's line, or the sheet's row), the
// column and the value.
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { TextDecoder } from 'node:util';

import { OoxmlRefusal, columnIndex, readXlsx } from '../ooxml.mjs';

/** What one table file may cost; an .xlsx is also held to `OOXML_LIMITS`. */
export const TABLE_LIMITS = Object.freeze({ fileBytes: 50 * 1024 * 1024 });

/** Why a table was refused; `code` is the name an agent reports, the rest says where. */
export class TableError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ row?: number, column?: string, value?: string }} [where]
   */
  constructor(code, message, where = {}) {
    super(message);
    this.name = 'TableError';
    this.code = code;
    if (where.row !== undefined) this.row = where.row;
    if (where.column !== undefined) this.column = where.column;
    if (where.value !== undefined) this.value = where.value;
  }

  toJSON() {
    const { code, message, row, column, value } = this;
    const where = Object.entries({ row, column, value }).filter(([, part]) => part !== undefined);
    return { error: code, message, ...Object.fromEntries(where) };
  }
}

const at = (row, column) => `row ${row}${column === undefined ? '' : `, column ${column}`}`;

// ---------- CSV ----------

/**
 * The records of a CSV text as RFC 4180 writes them, each with the line it starts on. A quote opens
 * a field only as its first character; inside a quoted field a doubled quote is one quote and a
 * line break is kept. A byte order mark is dropped, CRLF, LF and CR all end a record, and a record
 * whose cells are all blank is skipped.
 *
 * @param {string} text
 * @returns {{ line: number, cells: string[] }[]}
 * @throws {TableError} `stray_quote` or `unclosed_quote`.
 */
export function parseCsv(text) {
  const records = [];
  let cells = [];
  let cell = '';
  let state = 'start';
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  const endCell = () => {
    cells.push(cell);
    cell = '';
    state = 'start';
  };
  const endRecord = () => {
    endCell();
    if (cells.some((value) => value.trim() !== '')) records.push({ line: recordLine, cells });
    cells = [];
    recordLine = line;
  };
  const stray = () =>
    new TableError('stray_quote', `${at(line, cells.length + 1)}: a quote inside a field`, {
      row: line,
      column: String(cells.length + 1),
    });
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const isBreak = char === '\n' || char === '\r';
    if (isBreak && char === '\r' && source[index + 1] === '\n') index += 1;
    if (state === 'quoted') {
      if (char === '"') state = 'closed';
      else cell += isBreak ? '\n' : char;
      if (isBreak) line += 1;
      continue;
    }
    if (char === '"' && state === 'start') {
      state = 'quoted';
      quoteLine = line;
    } else if (char === '"' && state === 'closed') {
      cell += '"';
      state = 'quoted';
    } else if (char === ',') endCell();
    else if (isBreak) {
      line += 1;
      endRecord();
    } else if (char === '"' || state === 'closed') throw stray();
    else {
      cell += char;
      state = 'field';
    }
  }
  if (state === 'quoted')
    throw new TableError('unclosed_quote', `${at(quoteLine)}: a quoted field is never closed`, {
      row: quoteLine,
    });
  endRecord();
  return records;
}

// ---------- columns and values ----------

const WHOLE = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/u;
const DECIMAL = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u;

const cellText = (value) => (value === null ? '' : String(value).trim());

/**
 * A whole number from a cell: digits with an optional sign and optional thousands commas
 * (`-1,234`), or an .xlsx number that is a safe integer.
 *
 * @param {string | number | boolean | null} value
 * @param {{ row: number, column: string }} where
 * @returns {number}
 * @throws {TableError} `not_a_whole_number`.
 */
export function wholeNumber(value, where) {
  const text = cellText(value);
  const number = typeof value === 'number' ? value : Number(text.replaceAll(',', ''));
  if ((typeof value === 'number' || WHOLE.test(text)) && Number.isSafeInteger(number))
    return number;
  throw new TableError(
    'not_a_whole_number',
    `${at(where.row, where.column)}: ${JSON.stringify(text)} is not a whole number`,
    { ...where, value: text },
  );
}

/**
 * A decimal number from a cell: `1234.5`, `-1,234.5`, or a finite .xlsx number. No exponent, no
 * percent sign and no currency symbol.
 *
 * @param {string | number | boolean | null} value
 * @param {{ row: number, column: string }} where
 * @returns {number}
 * @throws {TableError} `not_a_decimal`.
 */
export function decimalNumber(value, where) {
  const text = cellText(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'number' && DECIMAL.test(text)) return Number(text.replaceAll(',', ''));
  throw new TableError(
    'not_a_decimal',
    `${at(where.row, where.column)}: ${JSON.stringify(text)} is not a decimal number`,
    { ...where, value: text },
  );
}

const DATE_TEXT = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u;
/** An ISO date cell (`t="d"`) at midnight: the only time of day a date may carry. */
const ISO_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?Z?)?$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Day 0 of each .xlsx date system; the 1900 system counts a 1900-02-29 that never was. */
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
/** The first serial day of the 1900 system that the phantom 1900-02-29 does not shift. */
const FIRST_SURE_SERIAL = 61;

/**
 * A calendar date, `YYYY-MM-DD`, from a cell: text `2026-09-30` or `2026/9/30`, or an .xlsx
 * number whose style shows a date (`isDateCell`), a serial day of the workbook's date system
 * (`date1904`), or an ISO date cell (`t="d"`, `isDateCell`) at midnight. A number without a date
 * style, a serial or ISO date with a time of day, a serial before 1900-03-01 and a day that does
 * not exist are refused: none is a date it can be sure of.
 *
 * @param {string | number | boolean | null} value
 * @param {{ row: number, column: string }} where
 * @param {{ isDateCell?: boolean, date1904?: boolean }} [options]
 * @returns {string}
 * @throws {TableError} `not_a_date`.
 */
export function dateValue(value, where, { isDateCell = false, date1904 = false } = {}) {
  const text = cellText(value);
  const refuse = (why) =>
    new TableError('not_a_date', `${at(where.row, where.column)}: ${JSON.stringify(text)} ${why}`, {
      ...where,
      value: text,
    });
  if (typeof value === 'number') {
    if (!isDateCell) throw refuse('is a number without a date format, not a date');
    if (!Number.isInteger(value) || (!date1904 && value < FIRST_SURE_SERIAL))
      throw refuse('is not a whole day this reader can date');
    const epoch = date1904 ? EPOCH_1904 : EPOCH_1900;
    return new Date(epoch + value * DAY_MS).toISOString().slice(0, 10);
  }
  const iso = isDateCell ? (ISO_MIDNIGHT.exec(text)?.[1] ?? text) : text;
  const [, year, month, day] = DATE_TEXT.exec(iso) ?? [];
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    year === undefined ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCMonth() !== Number(month) - 1
  )
    throw refuse('is not a date (YYYY-MM-DD or YYYY/M/D)');
  return date.toISOString().slice(0, 10);
}

const PARSERS = {
  text: (value) => cellText(value),
  whole: wholeNumber,
  decimal: decimalNumber,
};
const TYPES = ['text', 'whole', 'decimal', 'date'];

/** `{ names, type, optional }` of a column spec; a bare array is a required text column. */
function specOf(key, spec) {
  const { names, type = 'text', optional = false } = Array.isArray(spec) ? { names: spec } : spec;
  if (!Array.isArray(names) || names.length === 0 || !TYPES.includes(type))
    throw new TypeError(
      `column ${key}: names must be a non-empty array, type text|whole|decimal|date`,
    );
  return { names, type, optional };
}

/**
 * One requested cell, read as its column's type. `mark` is what the .xlsx said of the cell beyond
 * its value: an error, a date style, or a place inside a merged range other than its top left.
 * A merged text or date repeats, as on screen; a merged number would be counted twice.
 */
function readCell(value, mark, column, where, date1904) {
  const { type, optional } = column;
  const text = cellText(value);
  const refuse = (code, why) =>
    new TableError(code, `${at(where.row, where.column)}: ${why}`, { ...where, value: text });
  if (mark?.error === true) throw refuse('error_cell', `the cell holds the error ${text}`);
  if (typeof value === 'number' && !Number.isFinite(value))
    throw refuse('unreadable_cell', 'the cell holds no number this reader can read');
  if (text === '') {
    if (optional) return null;
    throw new TableError('empty_cell', `${at(where.row, where.column)}: the cell is empty`, where);
  }
  if (type === 'date')
    return dateValue(value, where, { isDateCell: mark?.date === true, date1904 });
  if (mark?.date === true)
    throw refuse('date_cell', 'the cell shows a date; read the column as type date');
  if (mark?.merged === true && type !== 'text')
    throw refuse('merged_cell', 'the number belongs to a merged range, not to this cell');
  return PARSERS[type](value, where);
}

/** Where each requested column is in the header, and how its cells are read. */
function locate(header, headerRow, columns) {
  const names = header.map(cellText);
  const index = [];
  for (const [key, raw] of Object.entries(columns)) {
    const spec = specOf(key, raw);
    const found = names.flatMap((name, position) => (spec.names.includes(name) ? [position] : []));
    if (found.length === 0)
      throw new TableError(
        'missing_column',
        `${at(headerRow)}: no column ${spec.names.join(' / ')}; the header is ${names.join(', ')}`,
        { row: headerRow, column: spec.names.join(' / ') },
      );
    if (found.length > 1)
      throw new TableError(
        'duplicate_column',
        `${at(headerRow)}: ${found.map((position) => names[position]).join(' and ')} both name ${key}`,
        { row: headerRow, column: spec.names.join(' / ') },
      );
    index.push({ key, ...spec, position: found[0], name: names[found[0]] });
  }
  return index;
}

/** Every header name as its own optional text column, when no columns are requested. */
function wholeHeader(header, headerRow) {
  const columns = new Map();
  for (const [position, raw] of header.entries()) {
    const name = cellText(raw);
    if (name === '' || columns.has(name))
      throw new TableError(
        name === '' ? 'empty_header' : 'duplicate_column',
        `${at(headerRow, String(position + 1))}: ${name === '' ? 'a column has no name' : `${name} appears twice`}`,
        { row: headerRow, column: name === '' ? String(position + 1) : name },
      );
    columns.set(name, { names: [name], optional: true });
  }
  // `Object.fromEntries` defines each name as an own property, a `__proto__` header included.
  return Object.fromEntries(columns);
}

/**
 * Typed rows from header-and-cells records (`records[0]` is the header). A record's `marks`, when
 * an .xlsx gives them, say which cells are errors, dates or inside a merged range.
 *
 * @param {readonly { line: number, cells: readonly (string | number | boolean | null)[], marks?: readonly ({ error?: boolean, date?: boolean, merged?: boolean } | undefined)[] }[]} records
 * @param {Readonly<Record<string, unknown>> | undefined} columns
 * @param {{ date1904?: boolean }} [options]
 */
export function tableOf(records, columns, { date1904 = false } = {}) {
  const [head, ...body] = records;
  if (head === undefined) throw new TableError('no_header', 'the table has no header row');
  const index = locate(head.cells, head.line, columns ?? wholeHeader(head.cells, head.line));
  const rows = body.map(({ line, cells, marks }) => {
    if (cells.length !== head.cells.length)
      throw new TableError(
        'cell_count',
        `${at(line)}: ${cells.length} cells, but the header has ${head.cells.length}`,
        { row: line },
      );
    const entries = index.map((column) => [
      column.key,
      readCell(
        cells[column.position],
        marks?.[column.position],
        column,
        { row: line, column: column.name },
        date1904,
      ),
    ]);
    return Object.fromEntries(entries);
  });
  return {
    columns: head.cells.map(cellText),
    rows,
    rowNumbers: body.map((record) => record.line),
  };
}

// ---------- files ----------

/** The file's bytes, its size checked on the descriptor it is then read from. */
function fileBytes(file) {
  const unreadable = () => new TableError('unreadable_file', `${file} is not a readable file`);
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    throw unreadable();
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw unreadable();
    if (stat.size > TABLE_LIMITS.fileBytes)
      throw new TableError(
        'file_too_large',
        `${file} is ${stat.size} bytes; at most ${TABLE_LIMITS.fileBytes} are read`,
      );
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function csvRecords(file, bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TableError('not_utf8', `${file} is not UTF-8 text; save the CSV as UTF-8`);
  }
  return parseCsv(text);
}

function xlsxRecords(file, bytes, sheetName) {
  let sheets;
  let date1904;
  try {
    ({ sheets, date1904 } = readXlsx(bytes));
  } catch (error) {
    if (!(error instanceof OoxmlRefusal)) throw error;
    throw new TableError('unreadable_workbook', `${file}: ${error.message} (${error.code})`);
  }
  const sheet = sheetName === undefined ? sheets[0] : sheets.find((s) => s.name === sheetName);
  if (sheet === undefined)
    throw new TableError(
      'unknown_sheet',
      `${file} has no ${sheetName === undefined ? 'sheet' : `sheet ${sheetName}`}; its sheets are ${sheets.map((s) => s.name).join(', ')}`,
    );
  const marks = marksOf(sheet);
  const records = sheet.rows
    .map((cells, index) => ({ line: index + 1, cells: trimEnd(cells) }))
    .filter(({ cells }) => cells.length > 0);
  // A sheet's rows are as wide as its widest row, so a row is cut to the header's width unless a
  // cell past it is filled, which `tableOf` then refuses as `cell_count`.
  const width = records[0]?.cells.length ?? 0;
  return {
    date1904,
    records: records.map(({ line, cells }) => {
      const kept = cells.length > width ? cells : sheet.rows[line - 1].slice(0, width);
      return { line, cells: kept, marks: kept.map((_, column) => marks.get(`${line}:${column}`)) };
    }),
  };
}

/** `{ error?, date?, merged? }` of each marked cell of a sheet, by `<row>:<column index>`. */
function marksOf(sheet) {
  const marks = new Map();
  const mark = (key, flag) => marks.set(key, { ...marks.get(key), [flag]: true });
  const place = (ref) => {
    const [, letters, row] = /^([A-Z]+)(\d+)$/u.exec(ref);
    return { row: Number(row), column: columnIndex(letters) };
  };
  const keyOf = (ref) => {
    const { row, column } = place(ref);
    return `${row}:${column}`;
  };
  for (const ref of sheet.errors) mark(keyOf(ref), 'error');
  for (const ref of sheet.dates) mark(keyOf(ref), 'date');
  for (const range of sheet.merges) {
    const [from, to] = range.split(':').map(place);
    for (let row = from.row; row <= to.row && row <= sheet.rows.length; row += 1)
      for (let column = from.column; column <= to.column; column += 1)
        if (row !== from.row || column !== from.column) mark(`${row}:${column}`, 'merged');
  }
  return marks;
}

/** The cells up to the last one that is not blank. */
function trimEnd(cells) {
  let end = cells.length;
  while (end > 0 && cellText(cells[end - 1]) === '') end -= 1;
  return cells.slice(0, end);
}

const OPTIONS = ['columns', 'sheet'];

/**
 * A table from a `.csv` (UTF-8) or `.xlsx` file: the first non-blank row is the header, and a
 * record whose cells are all blank is skipped, in a CSV and in a sheet alike.
 *
 * `columns` maps each key the script wants to the header names it may have (Japanese and English,
 * say), as `['年月', 'month']` for a required text column or `{ names, type, optional }` with
 * `type` `text` (trimmed), `whole`, `decimal` or `date` (`YYYY-MM-DD`; see {@link dateValue}); an
 * `optional` empty cell is `null`. Each row is then `{ [key]: value }`. Without `columns`, every
 * header name is an optional text column. `sheet` names the .xlsx sheet (default: the first).
 * `rowNumbers[i]` is where `rows[i]` is.
 *
 * @throws {TableError} for the file; a `TypeError` for options the script got wrong.
 */
export function readTable(file, options = {}) {
  const unknown = Object.keys(options).find((key) => !OPTIONS.includes(key));
  if (unknown !== undefined)
    throw new TypeError(`readTable: unknown option ${unknown} (${OPTIONS.join(', ')})`);
  const format = extname(file).toLowerCase();
  if (format !== '.csv' && format !== '.xlsx')
    throw new TableError('unsupported_format', `${file}: read a .csv or .xlsx file`);
  if (format === '.csv' && options.sheet !== undefined)
    throw new TypeError(`readTable: ${file} is a CSV, which has no sheet ${options.sheet}`);
  const bytes = fileBytes(file);
  if (format === '.csv') return tableOf(csvRecords(file, bytes), options.columns);
  const { records, date1904 } = xlsxRecords(file, bytes, options.sheet);
  return tableOf(records, options.columns, { date1904 });
}
