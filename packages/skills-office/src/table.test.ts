/**
 * The table reader a use case's skill script imports (ADR-0173): strict RFC 4180 CSV, .xlsx through
 * office-reader, typed columns, and refusals that name the row, the column and the value.
 */
import { mkdir, mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeXlsx, writeZip } from '../office-reader/scripts/ooxml.mjs';
import {
  TABLE_LIMITS,
  TableError,
  dateValue,
  decimalNumber,
  parseCsv,
  readTable,
  tableOf,
  wholeNumber,
} from '../office-reader/scripts/lib/table.mjs';

async function file(name: string, content: string | Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'table-'));
  const target = path.join(dir, name);
  await writeFile(target, content);
  return target;
}

/** The TableError `run` throws, as JSON. */
function refusal(run: () => unknown): ReturnType<TableError['toJSON']> {
  try {
    run();
  } catch (error) {
    if (error instanceof TableError) return error.toJSON();
    throw error;
  }
  throw new Error('expected a TableError');
}

const BUDGET = {
  month: ['年月', 'month'],
  budget: { names: ['予算', 'budget'], type: 'whole' },
  rate: { names: ['rate'], type: 'decimal', optional: true },
} as const;

describe('parseCsv', () => {
  it('reads quoted commas, doubled quotes and line breaks, drops a BOM and blank records', () => {
    const text = '﻿a,b\r\n1,"x,""y""\r\nz"\r\n\r\n , \n"",""\n2,\rlast,"q"';
    expect(parseCsv(text)).toStrictEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['1', 'x,"y"\nz'] },
      { line: 7, cells: ['2', ''] },
      { line: 8, cells: ['last', 'q'] },
    ]);
  });

  it('counts a CRLF inside a quoted field as one line', () => {
    expect(parseCsv('"a\r\nb",c\nd,e\n').map((record) => record.line)).toStrictEqual([1, 3]);
  });

  it('refuses a quote inside an unquoted field instead of swallowing the rows after it', () => {
    expect(refusal(() => parseCsv('a,b\n1,x"y\n2,3\n'))).toStrictEqual({
      error: 'stray_quote',
      message: 'row 2, column 2: a quote inside a field',
      row: 2,
      column: '2',
    });
  });

  it('refuses text after a closing quote, and a quote after a leading space', () => {
    expect(refusal(() => parseCsv('a\n"x"y\n')).error).toBe('stray_quote');
    expect(refusal(() => parseCsv('a,b\n1, "x"\n')).column).toBe('2');
  });

  it('refuses a quoted field that never closes, naming the line it opened on', () => {
    expect(refusal(() => parseCsv('a,b\n1,2\n3,"open\n4,5\n'))).toStrictEqual({
      error: 'unclosed_quote',
      message: 'row 3: a quoted field is never closed',
      row: 3,
    });
  });
});

describe('wholeNumber and decimalNumber', () => {
  const where = { row: 4, column: '予算' };

  it('read signs, thousands commas, surrounding spaces and .xlsx numbers', () => {
    expect(wholeNumber(' -1,234,567 ', where)).toBe(-1234567);
    expect(wholeNumber('+42', where)).toBe(42);
    expect(wholeNumber(1200, where)).toBe(1200);
    expect(decimalNumber('1,234.50', where)).toBe(1234.5);
    expect(decimalNumber('-0.25', where)).toBe(-0.25);
    expect(decimalNumber(0.1, where)).toBe(0.1);
  });

  it('refuse what is not a number, naming the row, the column and the value', () => {
    expect(refusal(() => wholeNumber('1.5', where))).toStrictEqual({
      error: 'not_a_whole_number',
      message: 'row 4, column 予算: "1.5" is not a whole number',
      row: 4,
      column: '予算',
      value: '1.5',
    });
    for (const value of ['12,34', '1e3', '¥100', '', true, 1.5, 2 ** 60, '9007199254740993'])
      expect(refusal(() => wholeNumber(value, where)).error).toBe('not_a_whole_number');
    for (const value of ['1.', '.5', '1e3', '12%', false, Number.NaN, Number.POSITIVE_INFINITY])
      expect(refusal(() => decimalNumber(value, where)).error).toBe('not_a_decimal');
  });
});

describe('tableOf', () => {
  const header = { line: 1, cells: [' 年月 ', '予算', 'rate', 'note'] };
  const records = [
    header,
    { line: 2, cells: ['2026-09', '1,000', '0.5', 'x'] },
    { line: 4, cells: ['2026-10', '2000', ' ', 'y'] },
  ];

  it('types the requested columns by any of their names and leaves the others out', () => {
    expect(tableOf(records, BUDGET)).toStrictEqual({
      columns: ['年月', '予算', 'rate', 'note'],
      rows: [
        { month: '2026-09', budget: 1000, rate: 0.5 },
        { month: '2026-10', budget: 2000, rate: null },
      ],
      rowNumbers: [2, 4],
    });
  });

  it('without columns, gives every header name as an optional text column', () => {
    expect(tableOf(records).rows[1]).toStrictEqual({
      年月: '2026-10',
      予算: '2000',
      rate: null,
      note: 'y',
    });
  });

  it('refuses a row with more or fewer cells than the header', () => {
    for (const cells of [
      ['2026-09', '1'],
      ['2026-09', '1', '0.5', 'x', 'extra'],
    ])
      expect(refusal(() => tableOf([header, { line: 3, cells }], BUDGET))).toStrictEqual({
        error: 'cell_count',
        message: `row 3: ${cells.length} cells, but the header has 4`,
        row: 3,
      });
  });

  it('refuses an empty required cell, and a value its column cannot read', () => {
    const row = (cells: string[]) => [header, { line: 9, cells }];
    expect(refusal(() => tableOf(row([' ', '1', '', '']), BUDGET))).toStrictEqual({
      error: 'empty_cell',
      message: 'row 9, column 年月: the cell is empty',
      row: 9,
      column: '年月',
    });
    expect(refusal(() => tableOf(row(['2026-09', '1万', '', '']), BUDGET)).value).toBe('1万');
  });

  it('refuses a missing column, and a column that two of its names both match', () => {
    expect(refusal(() => tableOf([{ line: 2, cells: ['年月'] }], BUDGET))).toStrictEqual({
      error: 'missing_column',
      message: 'row 2: no column 予算 / budget; the header is 年月',
      row: 2,
      column: '予算 / budget',
    });
    const both = [{ line: 1, cells: ['年月', 'month', '予算'] }];
    expect(refusal(() => tableOf(both, BUDGET)).message).toBe(
      'row 1: 年月 and month both name month',
    );
  });

  it('keeps a header named __proto__ as an ordinary column', () => {
    const table = tableOf([
      { line: 1, cells: ['__proto__', 'a'] },
      { line: 2, cells: ['x', 'y'] },
    ]);
    expect(Object.keys(table.rows[0] ?? {})).toStrictEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(table.rows[0])).toBe(Object.prototype);
  });

  it('without columns, refuses a header with an empty or a repeated name', () => {
    expect(refusal(() => tableOf([{ line: 1, cells: ['a', ''] }]))).toStrictEqual({
      error: 'empty_header',
      message: 'row 1, column 2: a column has no name',
      row: 1,
      column: '2',
    });
    expect(refusal(() => tableOf([{ line: 1, cells: ['a', 'a'] }])).error).toBe('duplicate_column');
  });

  it('refuses a table with no header, and rejects a malformed column spec as a programming error', () => {
    expect(refusal(() => tableOf([]))).toStrictEqual({
      error: 'no_header',
      message: 'the table has no header row',
    });
    expect(() => tableOf(records, { month: [] })).toThrow(TypeError);
    expect(() => tableOf(records, { month: { names: ['年月'], type: 'time' as 'text' } })).toThrow(
      'column month: names must be a non-empty array, type text|whole|decimal|date',
    );
  });
});

describe('readTable', () => {
  it('reads a UTF-8 CSV with typed columns', async () => {
    const csv = await file('予実.CSV', '﻿年月,予算,rate\r\n2026-09,"1,200",\r\n');
    expect(readTable(csv, { columns: BUDGET })).toStrictEqual({
      columns: ['年月', '予算', 'rate'],
      rows: [{ month: '2026-09', budget: 1200, rate: null }],
      rowNumbers: [2],
    });
  });

  it('reads the first sheet of an .xlsx, or the one named, by the sheet’s row numbers', async () => {
    const xlsx = await file(
      'book.xlsx',
      writeXlsx({
        sheets: [
          {
            name: 'notes',
            rows: [
              ['note', null],
              ['a', null],
              [null, null],
            ],
          },
          {
            name: '予実',
            rows: [[], ['month', 'budget', null], ['2026-09', 1200, null], [], ['2026-10', '900']],
          },
        ],
      }),
    );
    expect(readTable(xlsx)).toStrictEqual({
      columns: ['note'],
      rows: [{ note: 'a' }],
      rowNumbers: [2],
    });
    const columns = { month: ['month'], budget: { names: ['budget'], type: 'whole' } } as const;
    expect(readTable(xlsx, { sheet: '予実', columns })).toStrictEqual({
      columns: ['month', 'budget'],
      rows: [
        { month: '2026-09', budget: 1200 },
        { month: '2026-10', budget: 900 },
      ],
      rowNumbers: [3, 5],
    });
  });

  it('refuses a filled .xlsx cell past the header, and a sheet it does not have', async () => {
    const xlsx = await file(
      'book.xlsx',
      writeXlsx({ sheets: [{ name: 'a', rows: [['x'], ['1', null, 'stray']] }] }),
    );
    expect(refusal(() => readTable(xlsx))).toStrictEqual({
      error: 'cell_count',
      message: 'row 2: 3 cells, but the header has 1',
      row: 2,
    });
    expect(refusal(() => readTable(xlsx, { sheet: 'b' }))).toStrictEqual({
      error: 'unknown_sheet',
      message: `${xlsx} has no sheet b; its sheets are a`,
    });
  });

  it('refuses a workbook without sheets, an empty sheet and a corrupt archive', async () => {
    const workbook = (sheets: string, sheet = '') =>
      writeZip([
        { name: 'xl/workbook.xml', data: `<workbook><sheets>${sheets}</sheets></workbook>` },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: '<Relationships><Relationship Id="r1" Target="worksheets/s.xml"/></Relationships>',
        },
        {
          name: 'xl/worksheets/s.xml',
          data: `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
        },
      ]);
    const none = await file('none.xlsx', workbook(''));
    expect(refusal(() => readTable(none)).message).toBe(`${none} has no sheet; its sheets are `);
    const empty = await file('empty.xlsx', workbook('<sheet name="s" r:id="r1"/>'));
    expect(refusal(() => readTable(empty)).error).toBe('no_header');
    const corrupt = await file('corrupt.xlsx', 'not a zip');
    expect(refusal(() => readTable(corrupt))).toMatchObject({ error: 'unreadable_workbook' });
    const broken = await file(
      'broken.xlsx',
      workbook('<sheet name="s" r:id="r1"/>', '<row><c r="a1"><v>1</v></c></row>'),
    );
    expect(() => readTable(broken)).toThrow('not a cell reference: a1');
  });

  it('refuses another format, a missing file, a folder, a large file and text that is not UTF-8', async () => {
    expect(refusal(() => readTable('data.xls'))).toStrictEqual({
      error: 'unsupported_format',
      message: 'data.xls: read a .csv or .xlsx file',
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'table-'));
    expect(refusal(() => readTable(path.join(dir, 'missing.csv'))).error).toBe('unreadable_file');
    await mkdir(path.join(dir, 'folder.csv'));
    expect(refusal(() => readTable(path.join(dir, 'folder.csv'))).error).toBe('unreadable_file');
    const large = await file('large.csv', '');
    await truncate(large, TABLE_LIMITS.fileBytes + 1);
    expect(refusal(() => readTable(large)).error).toBe('file_too_large');
    const latin = await file('sjis.csv', Buffer.from([0x94, 0x4e, 0x8c, 0x8e]));
    expect(refusal(() => readTable(latin))).toStrictEqual({
      error: 'not_utf8',
      message: `${latin} is not UTF-8 text; save the CSV as UTF-8`,
    });
  });
});

describe('dateValue', () => {
  const where = { row: 2, column: '日付' };

  it('reads YYYY-MM-DD and YYYY/M/D text, and a date-styled serial in either date system', () => {
    expect(dateValue(' 2026/9/3 ', where)).toBe('2026-09-03');
    expect(dateValue('2026-09-30', where)).toBe('2026-09-30');
    expect(dateValue(46295, where, { isDateCell: true })).toBe('2026-09-30');
    expect(dateValue(61, where, { isDateCell: true })).toBe('1900-03-01');
    expect(dateValue(0, where, { isDateCell: true, date1904: true })).toBe('1904-01-01');
  });

  it('refuses what it cannot be sure is a date', () => {
    expect(refusal(() => dateValue(46295, where))).toStrictEqual({
      error: 'not_a_date',
      message: 'row 2, column 日付: "46295" is a number without a date format, not a date',
      row: 2,
      column: '日付',
      value: '46295',
    });
    for (const serial of [46295.5, 60, 1])
      expect(refusal(() => dateValue(serial, where, { isDateCell: true })).message).toContain(
        'is not a whole day this reader can date',
      );
    for (const text of ['2026-02-30', '2026-13-01', '2026年9月30日', '30/09/2026', true])
      expect(refusal(() => dateValue(text, where)).message).toContain(
        'is not a date (YYYY-MM-DD or YYYY/M/D)',
      );
  });
});

/** An .xlsx with one sheet `s` of raw `<row>` XML, a style sheet and an optional 1904 system. */
function workbook(rows: string, options: { merges?: string; date1904?: boolean } = {}): Buffer {
  // Styles: 0 General, 1 built-in date (14), 2 a custom 年月 date format, 3 a custom 円 number.
  const styles =
    '<styleSheet><numFmts>' +
    '<numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;"/>' +
    '<numFmt numFmtId="165" formatCode="#,##0&quot;円&quot;"/>' +
    '</numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/>' +
    '<xf numFmtId="165"/></cellXfs></styleSheet>';
  const pr = options.date1904 === true ? '<workbookPr date1904="1"/>' : '';
  const merges = options.merges === undefined ? '' : `<mergeCells>${options.merges}</mergeCells>`;
  return writeZip([
    {
      name: 'xl/workbook.xml',
      data: `<workbook>${pr}<sheets><sheet name="s" r:id="r1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<Relationships><Relationship Id="r1" Target="worksheets/s.xml"/></Relationships>',
    },
    { name: 'xl/styles.xml', data: styles },
    {
      name: 'xl/worksheets/s.xml',
      data: `<worksheet><sheetData>${rows}</sheetData>${merges}</worksheet>`,
    },
  ]);
}

const text = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const num = (ref: string, value: number, style = 0) =>
  `<c r="${ref}" s="${String(style)}"><v>${String(value)}</v></c>`;
const HEADER = `<row r="1">${text('A1', 'date')}${text('B1', 'amount')}</row>`;
const DATED = {
  date: { names: ['date'], type: 'date' },
  amount: { names: ['amount'], type: 'whole' },
} as const;

describe('readTable over .xlsx cells that are more than their value', () => {
  it('reads a date-styled serial as a date, in the 1900 and the 1904 system', async () => {
    const rows = `${HEADER}<row r="2">${num('A2', 46295, 1)}${num('B2', 1200, 3)}</row><row r="3">${num('A3', 46296, 2)}${num('B3', 5)}</row>`;
    expect(readTable(await file('d.xlsx', workbook(rows)), { columns: DATED }).rows).toStrictEqual([
      { date: '2026-09-30', amount: 1200 },
      { date: '2026-10-01', amount: 5 },
    ]);
    const old = `${HEADER}<row r="2">${num('A2', 0, 1)}${num('B2', 1)}</row>`;
    expect(
      readTable(await file('d.xlsx', workbook(old, { date1904: true })), { columns: DATED }).rows,
    ).toStrictEqual([{ date: '1904-01-01', amount: 1 }]);
  });

  it('refuses a date-styled cell read as a number or as text, and a plain number read as a date', async () => {
    const swapped = await file(
      'd.xlsx',
      workbook(`${HEADER}<row r="2">${num('A2', 7)}${num('B2', 46295, 1)}</row>`),
    );
    expect(refusal(() => readTable(swapped, { columns: DATED }))).toStrictEqual({
      error: 'not_a_date',
      message: 'row 2, column date: "7" is a number without a date format, not a date',
      row: 2,
      column: 'date',
      value: '7',
    });
    const asText = { amount: ['amount'] };
    expect(refusal(() => readTable(swapped, { columns: asText }))).toStrictEqual({
      error: 'date_cell',
      message: 'row 2, column amount: the cell shows a date; read the column as type date',
      row: 2,
      column: 'amount',
      value: '46295',
    });
    expect(refusal(() => readTable(swapped)).error).toBe('date_cell');
  });

  it('reads an ISO date cell (t="d") at midnight as a date, and never as text or a number', async () => {
    const iso = (ref: string, value: string) => `<c r="${ref}" t="d"><v>${value}</v></c>`;
    const rows = `${HEADER}<row r="2">${iso('A2', '2026-09-30T00:00:00Z')}${num('B2', 1)}</row><row r="3">${iso('A3', '2026-10-01')}${num('B3', 2)}</row>`;
    const book = await file('iso.xlsx', workbook(rows));
    expect(readTable(book, { columns: DATED }).rows).toStrictEqual([
      { date: '2026-09-30', amount: 1 },
      { date: '2026-10-01', amount: 2 },
    ]);
    expect(refusal(() => readTable(book, { columns: { date: ['date'] } }))).toMatchObject({
      error: 'date_cell',
      row: 2,
      value: '2026-09-30T00:00:00Z',
    });
    const timed = `${HEADER}<row r="2">${iso('A2', '2026-09-30T09:30:00')}${num('B2', 1)}</row>`;
    const timedBook = await file('t.xlsx', workbook(timed));
    expect(refusal(() => readTable(timedBook, { columns: DATED }))).toMatchObject({
      error: 'not_a_date',
      value: '2026-09-30T09:30:00',
    });
  });

  it('refuses a number cell that holds no finite number instead of reading "NaN"', async () => {
    const rows = `${HEADER}<row r="2">${num('A2', 46295, 1)}<c r="B2"><v>junk</v></c></row>`;
    const book = await file('nan.xlsx', workbook(rows));
    for (const columns of [{ amount: ['amount'] }, DATED])
      expect(refusal(() => readTable(book, { columns }))).toStrictEqual({
        error: 'unreadable_cell',
        message: 'row 2, column amount: the cell holds no number this reader can read',
        row: 2,
        column: 'amount',
        value: 'NaN',
      });
  });

  it('refuses an error cell, even in an optional column', async () => {
    const rows = `${HEADER}<row r="2">${num('A2', 46295, 1)}<c r="B2" t="e"><v>#DIV/0!</v></c></row>`;
    const book = await file('e.xlsx', workbook(rows));
    const optional = { amount: { names: ['amount'], type: 'whole', optional: true } } as const;
    expect(refusal(() => readTable(book, { columns: optional }))).toStrictEqual({
      error: 'error_cell',
      message: 'row 2, column amount: the cell holds the error #DIV/0!',
      row: 2,
      column: 'amount',
      value: '#DIV/0!',
    });
  });

  it('repeats a merged text, and refuses a number that is only part of a merged range', async () => {
    const book = await file(
      'm.xlsx',
      writeXlsx({
        sheets: [
          {
            name: 'm',
            rows: [
              ['部門', '予算'],
              ['営業', 300],
              [null, null],
              ['開発', 100],
            ],
            merges: ['A2:A3', 'B2:B3'],
          },
        ],
      }),
    );
    expect(readTable(book, { columns: { department: ['部門'] } }).rows).toStrictEqual([
      { department: '営業' },
      { department: '営業' },
      { department: '開発' },
    ]);
    expect(
      refusal(() => readTable(book, { columns: { budget: { names: ['予算'], type: 'whole' } } })),
    ).toStrictEqual({
      error: 'merged_cell',
      message: 'row 3, column 予算: the number belongs to a merged range, not to this cell',
      row: 3,
      column: '予算',
      value: '300',
    });
  });

  it('ignores a merged range that reaches past the last row', async () => {
    const rows = `${HEADER}<row r="2">${num('A2', 46295, 1)}${num('B2', 1)}</row>`;
    const book = await file('m.xlsx', workbook(rows, { merges: '<mergeCell ref="A2:A9"/>' }));
    expect(readTable(book, { columns: DATED }).rows).toStrictEqual([
      { date: '2026-09-30', amount: 1 },
    ]);
  });
});

describe('readTable options', () => {
  it('reads a date column from CSV text', async () => {
    const csv = await file('d.csv', 'date,amount\n2026/9/30,"1,000"\n');
    expect(readTable(csv, { columns: DATED }).rows).toStrictEqual([
      { date: '2026-09-30', amount: 1000 },
    ]);
  });

  it('rejects an unknown option and a sheet for a CSV as programming errors', async () => {
    const csv = await file('d.csv', 'a\n1\n');
    expect(() => readTable(csv, { colums: {} } as never)).toThrow(
      'readTable: unknown option colums (columns, sheet)',
    );
    expect(() => readTable(csv, { sheet: 'x' })).toThrow(TypeError);
  });
});
