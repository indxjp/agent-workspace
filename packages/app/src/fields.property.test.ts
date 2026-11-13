/**
 * Property tests for the field types: "Zod accepts what the column stores", checked without a
 * database. For each field type, every valid value parses with the field's `zod`, survives a JSON
 * round trip unchanged, and has the shape its `column.sql` kind stores. The PostgreSQL side is
 * re-checked by the store's tests. On a failure fast-check prints the seed that reproduces it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bool,
  date,
  dateTime,
  enumOf,
  files,
  money,
  number,
  person,
  ref,
  richText,
  tags,
  text,
  type AnyField,
  type ColumnSql,
} from './index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Whether `value` has the shape a column of `sql` stores. */
function matchesColumn(sql: ColumnSql, value: unknown): boolean {
  switch (sql) {
    case 'text':
      return typeof value === 'string';
    case 'jsonb':
      return Array.isArray(value) || (typeof value === 'object' && value !== null);
    case 'numeric':
      return (
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'object' && value !== null && 'amount' in value)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
    case 'timestamptz':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'uuid':
      return typeof value === 'string' && UUID.test(value);
    case 'uuid[]':
      return (
        Array.isArray(value) && value.every((item) => typeof item === 'string' && UUID.test(item))
      );
    case 'text[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
}

const day = fc
  .date({
    min: new Date('0001-01-01T00:00:00Z'),
    max: new Date('9999-12-31T23:59:59Z'),
    noInvalidDate: true,
  })
  .map((value) => value.toISOString());

type Block = { type: string; text?: string; children?: Block[] };
const blocks: fc.Arbitrary<Block[]> = fc
  .letrec<{ block: Block; list: Block[] }>((tie) => ({
    block: fc.record(
      {
        type: fc.constantFrom('p', 'h1', 'list', 'item', 'code'),
        text: fc.string({ maxLength: 40 }),
        children: fc.array(tie('block'), { maxLength: 2 }),
      },
      { requiredKeys: ['type'] },
    ),
    list: fc.array(tie('block'), { maxLength: 3 }),
  }))
  .list.filter((list) => {
    const depth = (items: readonly Block[]): number =>
      items.reduce((most, item) => Math.max(most, 1 + depth(item.children ?? [])), 0);
    return depth(list) <= 8;
  });

const cases: readonly (readonly [string, AnyField, fc.Arbitrary<unknown>])[] = [
  ['text', text({ max: 50 }), fc.string({ maxLength: 50 })],
  ['richText', richText(), blocks],
  [
    'number',
    number({ min: -1000, max: 1000 }),
    fc
      .double({ min: -1000, max: 1000, noNaN: true })
      .map((value) => (Object.is(value, -0) ? 0 : value)),
  ],
  [
    'money',
    money({ currency: 'USD' }),
    fc
      .tuple(
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 999_999_999_999_999n }),
        fc.option(fc.integer({ min: 0, max: 9999 })),
      )
      .map(([negative, whole, cents]) => ({
        amount: `${negative && whole > 0n ? '-' : ''}${String(whole)}${cents === null ? '' : `.${String(cents)}`}`,
        currency: 'USD',
      })),
  ],
  ['bool', bool(), fc.boolean()],
  ['date', date(), day.map((value) => value.slice(0, 10))],
  ['dateTime', dateTime(), day],
  [
    'enumOf',
    enumOf(['new', 'in_progress', 'closed']),
    fc.constantFrom('new', 'in_progress', 'closed'),
  ],
  ['person', person(), fc.uuid({ version: 4 })],
  ['ref', ref('customer'), fc.uuid({ version: 4 })],
  ['files', files(), fc.array(fc.uuid({ version: 4 }), { maxLength: 100 })],
  ['tags', tags(), fc.array(fc.string({ minLength: 1, maxLength: 64 }), { maxLength: 100 })],
];

describe('every valid field value', () => {
  it('covers every field type', () => {
    expect(new Set(cases.map(([, field]) => field.type)).size).toBe(12);
  });

  it.each(cases)(
    '%s: parses, survives JSON unchanged and matches its column',
    (_, field, values) => {
      fc.assert(
        fc.property(values, (value) => {
          const parsed = field.zod.safeParse(value);
          expect(parsed.success).toBe(true);
          expect(parsed.data).toEqual(value);
          expect(JSON.parse(JSON.stringify(value))).toEqual(value);
          expect(matchesColumn(field.column.sql, value)).toBe(true);
        }),
      );
    },
  );
});
