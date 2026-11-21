/**
 * The office-writer model's validation (ADR-0167 D2–D4): what is accepted, and each refusal with
 * the JSON path an agent repairs.
 */
import { describe, expect, it } from 'vitest';

import {
  OFFICE_WRITER_LIMITS,
  OfficeWriterRefusal,
  parseModel,
  type ModelIssue,
} from '../office-writer/scripts/lib/model.mjs';

function issuesOf(value: unknown): readonly ModelIssue[] {
  try {
    parseModel(value);
  } catch (error) {
    if (error instanceof OfficeWriterRefusal) return error.issues;
    throw error;
  }
  return [];
}

const docx = (blocks: unknown, extra: Record<string, unknown> = {}) => ({
  format: 'docx',
  blocks,
  ...extra,
});
const pptx = (slides: unknown) => ({ format: 'pptx', slides });
const xlsx = (sheets: unknown) => ({ format: 'xlsx', sheets });
const sheet = (rows: unknown, extra: Record<string, unknown> = {}) => ({
  name: 'S',
  rows,
  ...extra,
});

describe('office-writer model', () => {
  it('accepts a model of every block, slide and cell kind, and returns it unchanged', () => {
    const models = [
      docx(
        [
          { type: 'heading', level: 6, text: '見出し' },
          { type: 'paragraph', text: '' },
          { type: 'list', items: ['a'] },
          { type: 'list', ordered: false, items: ['b'] },
          { type: 'table', header: ['x', 'y'], rows: [['', 1.5]] },
          { type: 'table', rows: [['tab\tand\nline 📊']] },
        ],
        { title: '題' },
      ),
      pptx([{ title: 'T' }, { title: 'U', bullets: ['b'], table: { rows: [[1]] } }]),
      xlsx([
        sheet([['s', 1, true, null, { date: '2024-02-29' }]], { header: ['h', 2] }),
        sheet([['x']], { name: 's2' }),
      ]),
    ];
    for (const model of models) expect(parseModel(model)).toBe(model);
  });

  it('names an unknown or missing format', () => {
    expect(issuesOf({ format: 'odt' })).toStrictEqual([
      { path: '$.format', message: 'must be "docx", "pptx" or "xlsx"' },
    ]);
    expect(issuesOf(['docx'])).toHaveLength(1);
    expect(issuesOf(null)).toHaveLength(1);
  });

  it('refuses unknown and missing fields', () => {
    expect(issuesOf({ format: 'docx', block: [] })).toStrictEqual([
      { path: '$.block', message: 'is not a field of this object' },
      { path: '$.blocks', message: 'is required' },
    ]);
  });

  it('checks text: a string, not blank, within the length, and XML-safe', () => {
    const paragraph = (text: unknown) => issuesOf(docx([{ type: 'heading', level: 1, text }]));
    expect(paragraph(1)[0]?.message).toBe('must be a string');
    expect(paragraph('  ')[0]?.message).toBe('must not be empty');
    expect(paragraph('x'.repeat(OFFICE_WRITER_LIMITS.textLength + 1))[0]?.message).toMatch(
      /longer than 32767/u,
    );
    for (const unsafe of ['a\u0001', '\ud800', 'x￾', '￿'])
      expect(paragraph(unsafe)[0]).toStrictEqual({
        path: '$.blocks[0].text',
        message: 'holds a control character an Office file cannot',
      });
    expect(paragraph('ok\r\n\t')).toStrictEqual([]);
  });

  it('checks each block kind, with the path of the first issue in each', () => {
    expect(
      issuesOf(
        docx([
          { type: 'heading', level: 7, text: 'h' },
          { type: 'heading', level: 1.5, text: 'h' },
          { type: 'heading', level: 0, text: 'h' },
          { type: 'list', ordered: 'yes', items: ['a'] },
          { type: 'list', items: [''] },
          { type: 'quote', text: 'q' },
          'paragraph',
          { type: 'paragraph', text: 'p', style: 'Heading1' },
        ]),
      ),
    ).toStrictEqual([
      { path: '$.blocks[0].level', message: 'must be an integer from 1 to 6' },
      { path: '$.blocks[1].level', message: 'must be an integer from 1 to 6' },
      { path: '$.blocks[2].level', message: 'must be an integer from 1 to 6' },
      { path: '$.blocks[3].ordered', message: 'must be true or false' },
      { path: '$.blocks[4].items[0]', message: 'must not be empty' },
      { path: '$.blocks[5].type', message: 'must be "heading", "paragraph", "list" or "table"' },
      { path: '$.blocks[6].type', message: 'must be "heading", "paragraph", "list" or "table"' },
      { path: '$.blocks[7].style', message: 'is not a field of this object' },
    ]);
    expect(issuesOf(docx([], { title: '' }))).toStrictEqual([
      { path: '$.title', message: 'must not be empty' },
    ]);
  });

  it('checks lists: an array, not empty, within its limit', () => {
    expect(issuesOf(docx('blocks'))[0]).toStrictEqual({
      path: '$.blocks',
      message: 'must be an array',
    });
    expect(issuesOf(docx([]))[0]?.message).toBe('must not be empty');
    const many = Array.from({ length: OFFICE_WRITER_LIMITS.blocks + 1 }, () => ({
      type: 'paragraph',
      text: 'p',
    }));
    expect(issuesOf(docx(many))).toStrictEqual([
      { path: '$.blocks', message: 'holds more than 5000 items' },
    ]);
  });

  it('checks tables: one width, typed cells, and the column limit', () => {
    const table = (fields: Record<string, unknown>) =>
      issuesOf(docx([{ type: 'table', ...fields }]));
    expect(table({ header: ['a', 'b'], rows: [['x']] })).toStrictEqual([
      {
        path: '$.blocks[0].rows[0]',
        message: 'must have 2 cells, as many as the header or the first row',
      },
    ]);
    expect(table({ rows: [['x'], ['y', 'z']] })[0]?.path).toBe('$.blocks[0].rows[1]');
    expect(table({ header: ['', 'b'], rows: [['x', Number.NaN]] })).toStrictEqual([
      { path: '$.blocks[0].header[0]', message: 'must not be empty' },
      { path: '$.blocks[0].rows[0][1]', message: 'must be a finite number' },
    ]);
    expect(table({ rows: null })[0]).toStrictEqual({
      path: '$.blocks[0].rows',
      message: 'must be an array',
    });
    expect(table({ header: 'a', rows: [['x']] })[0]?.path).toBe('$.blocks[0].header');
    expect(table({ rows: [Array.from({ length: 33 }, () => 'c')] })[0]?.message).toBe(
      'holds more than 32 items',
    );
    expect(table({ rows: [[true]] })[0]?.message).toBe('must be a string');
    expect(table({ header: ['a'] })[0]).toStrictEqual({
      path: '$.blocks[0].rows',
      message: 'is required',
    });
  });

  it('checks slides: a title, at most 20 bullets, and a table that fits', () => {
    expect(
      issuesOf(
        pptx([
          { bullets: ['b'] },
          { title: 'T', bullets: Array.from({ length: 21 }, () => 'b') },
          { title: 'T', table: { rows: Array.from({ length: 16 }, () => ['r']) } },
          { title: 'T', table: { rows: [Array.from({ length: 9 }, () => 'c')] } },
          { title: 'T', notes: 'n' },
        ]),
      ).map((issue) => issue.path),
    ).toStrictEqual([
      '$.slides[0].title',
      '$.slides[1].bullets',
      '$.slides[2].table.rows',
      '$.slides[3].table.rows[0]',
      '$.slides[4].notes',
    ]);
    expect(issuesOf(pptx([{ title: 'T', bullets: [''] }]))[0]?.path).toBe('$.slides[0].bullets[0]');
    expect(issuesOf({ format: 'pptx', slides: [], extra: 1 })[0]?.path).toBe('$.extra');
    expect(issuesOf(pptx(['slide', { title: 'T', table: [['a']] }]))).toStrictEqual([
      { path: '$.slides[0]', message: 'must be an object' },
      { path: '$.slides[1].table', message: 'must be an object' },
    ]);
  });

  it('checks cells: dates are real days from 1900-03-01, and objects are only dates', () => {
    const cell = (value: unknown) => issuesOf(xlsx([sheet([[value]])]));
    expect(cell({ date: '2026-11-21' })).toStrictEqual([]);
    for (const date of ['2026-02-30', '1900-02-28', '2026-1-01', 20_261_121])
      expect(cell({ date })).toStrictEqual([
        {
          path: '$.sheets[0].rows[0][0].date',
          message: 'must be a day written YYYY-MM-DD, from 1900-03-01',
        },
      ]);
    expect(cell({ date: '2026-11-21', time: '09:00' })[0]?.path).toBe(
      '$.sheets[0].rows[0][0].time',
    );
    expect(cell(Number.POSITIVE_INFINITY)[0]?.message).toBe('must be a finite number');
    expect(cell('\u0007')[0]?.path).toBe('$.sheets[0].rows[0][0]');
  });

  it("checks sheets: Excel's name rules, case-blind uniqueness, and the header", () => {
    const names = (...list: unknown[]) =>
      issuesOf(xlsx(list.map((name) => ({ name, rows: [['x']] })))).map((issue) => issue.message);
    expect(names('x'.repeat(32))).toStrictEqual(['is longer than 31 characters']);
    for (const name of [
      'a/b',
      'a[1]',
      "'quoted",
      "quoted'",
      'a:b',
      'a*',
      'a?',
      'a\\b',
      'a\tb',
      'a\nb',
      'a\rb',
    ])
      expect(names(name)).toStrictEqual([
        "must not hold [ ] : * ? / \\, a tab or a line break, or start or end with '",
      ]);
    for (const name of ['History', 'HISTORY', 'history'])
      expect(names(name)).toStrictEqual(['is a name Excel reserves']);
    expect(names('Histories')).toStrictEqual([]);
    expect(names('売上', 'Sales', 'SALES')).toStrictEqual([
      'names another sheet too (names ignore case)',
    ]);
    expect(names('')).toStrictEqual(['must not be empty']);
    expect(issuesOf(xlsx([sheet([['x']], { header: [] })]))[0]?.path).toBe('$.sheets[0].header');
    expect(issuesOf(xlsx([{ rows: [['x']] }]))[0]?.path).toBe('$.sheets[0].name');
    expect(issuesOf({ format: 'xlsx', sheets: [sheet([['x']])], title: 't' })[0]?.path).toBe(
      '$.title',
    );
  });

  it('refuses a workbook of more than a million cells', () => {
    const row = Array.from({ length: OFFICE_WRITER_LIMITS.sheetColumns }, () => null);
    const rows = Array.from({ length: 62 }, () => row);
    expect(issuesOf(xlsx([sheet(rows)]))).toStrictEqual([
      { path: '$.sheets', message: 'holds more than 1000000 cells' },
    ]);
  });

  it('reports the count and the first issue, and lists at most 50 issues', () => {
    const one = (() => {
      try {
        return parseModel({ format: 'docx' });
      } catch (error) {
        return error as OfficeWriterRefusal;
      }
    })();
    expect(one).toBeInstanceOf(OfficeWriterRefusal);
    expect((one as OfficeWriterRefusal).message).toBe(
      'the model has 1 issue; the first is $.blocks is required',
    );
    const many = Array.from({ length: 60 }, () => ({ type: 'paragraph', text: 1 }));
    let refusal: OfficeWriterRefusal | undefined;
    try {
      parseModel(docx(many));
    } catch (error) {
      refusal = error as OfficeWriterRefusal;
    }
    expect(refusal?.code).toBe('invalid_model');
    expect(refusal?.message).toMatch(
      /^the model has 60 issues; the first is \$\.blocks\[0\]\.text/u,
    );
    expect(refusal?.issues).toHaveLength(OFFICE_WRITER_LIMITS.reportedIssues);
    expect(refusal?.toJSON()).toMatchObject({ error: 'invalid_model' });
    expect(new OfficeWriterRefusal('output_exists', 'x').toJSON()).toStrictEqual({
      error: 'output_exists',
      message: 'x',
    });
  });
});
