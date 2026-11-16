import { DefinitionError } from '@indx-workspace/sdk/define';
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
} from './index.js';

/** The plain-data part of a descriptor, as `./db`, `./server` and `./react` read it. */
function descriptorOf(field: AnyField): Record<string, unknown> {
  const { type, optional, defaulted, options, column, control, cell, toolSchema } = field;
  return { type, optional, defaulted, options, column, control, cell, toolSchema };
}

describe('the field descriptors (one row per field type)', () => {
  const table: readonly (readonly [string, AnyField, Record<string, unknown>])[] = [
    [
      'text',
      text({ max: 200 }),
      {
        type: 'text',
        column: { sql: 'text', check: 'char_length({column}) <= 200' },
        control: 'input',
        cell: 'text',
        toolSchema: { type: 'string', maxLength: 200 },
      },
    ],
    [
      'richText',
      richText(),
      {
        type: 'richText',
        column: { sql: 'jsonb', check: "jsonb_typeof({column}) = 'array'" },
        control: 'editor',
        cell: 'excerpt',
        toolSchema: { type: 'string', contentMediaType: 'text/markdown' },
      },
    ],
    [
      'number',
      number({ min: 0, max: 10 }),
      {
        type: 'number',
        column: { sql: 'numeric', check: '{column} >= 0 AND {column} <= 10' },
        control: 'number',
        cell: 'number',
        toolSchema: { type: 'number', minimum: 0, maximum: 10 },
      },
    ],
    [
      'money',
      money({ currency: 'JPY' }),
      {
        type: 'money',
        column: {
          sql: 'numeric',
          companion: { suffix: 'currency', sql: 'text', check: "{column} = 'JPY'" },
        },
        control: 'money',
        cell: 'formatted',
      },
    ],
    [
      'bool',
      bool(),
      {
        type: 'bool',
        column: { sql: 'boolean' },
        control: 'switch',
        cell: 'check',
        toolSchema: { type: 'boolean' },
      },
    ],
    [
      'date',
      date(),
      {
        type: 'date',
        column: { sql: 'date' },
        control: 'picker',
        cell: 'relative',
        toolSchema: { type: 'string', format: 'date' },
      },
    ],
    [
      'dateTime',
      dateTime(),
      {
        type: 'dateTime',
        column: { sql: 'timestamptz' },
        control: 'picker',
        cell: 'relative',
        toolSchema: { type: 'string', format: 'date-time' },
      },
    ],
    [
      'enumOf',
      enumOf(['new', 'closed'], { default: 'new' }),
      {
        type: 'enumOf',
        defaulted: true,
        options: { default: 'new', values: ['new', 'closed'] },
        column: { sql: 'text', check: "{column} IN ('new', 'closed')" },
        control: 'select',
        cell: 'badge',
        toolSchema: { type: 'string', enum: ['new', 'closed'] },
      },
    ],
    [
      'person',
      person({ optional: true }),
      {
        type: 'person',
        optional: true,
        column: { sql: 'uuid' },
        control: 'people',
        cell: 'avatar',
      },
    ],
    [
      'ref',
      ref('customer'),
      {
        type: 'ref',
        options: { resource: 'customer' },
        column: { sql: 'uuid' },
        control: 'search',
        cell: 'link',
      },
    ],
    [
      'files',
      files(),
      {
        type: 'files',
        column: { sql: 'uuid[]', check: 'cardinality({column}) <= 100' },
        control: 'uploader',
        cell: 'count',
      },
    ],
    [
      'tags',
      tags(),
      {
        type: 'tags',
        column: { sql: 'text[]', check: 'cardinality({column}) <= 100' },
        control: 'tags',
        cell: 'chips',
      },
    ],
  ];

  it.each(table)('%s carries its column, control, cell and tool schema', (_, field, expected) => {
    expect(descriptorOf(field)).toMatchObject(expected);
  });

  it('covers every field type, and every descriptor is frozen plain data without the brand', () => {
    expect(new Set(table.map(([, field]) => field.type)).size).toBe(12);
    for (const [, field] of table) {
      expect(Object.isFrozen(field)).toBe(true);
      expect(Object.isFrozen(field.column)).toBe(true);
      expect(Object.isFrozen(field.toolSchema)).toBe(true);
      expect(JSON.stringify(descriptorOf(field))).not.toContain('agentworkspace');
      expect(Object.keys(field)).not.toContain('brand');
    }
  });

  it('defaults text() to 10 000 characters and fields to required', () => {
    const field = text();
    expect(field.options).toEqual({ max: 10_000 });
    expect(field.optional).toBe(false);
    expect(field.defaulted).toBe(false);
  });
});

describe('the field builders refuse bad options', () => {
  const refusals: readonly (readonly [string, () => unknown, string])[] = [
    ['text max 0', () => text({ max: 0 }), 'max'],
    ['text default too long', () => text({ max: 2, default: 'abc' }), 'default'],
    ['text unknown option', () => text({ maxLength: 3 } as never), '(root)'],
    ['number min above max', () => number({ min: 5, max: 1 }), 'min'],
    ['money lowercase currency', () => money({ currency: 'jpy' }), 'currency'],
    ['enumOf empty', () => enumOf([] as unknown as [string]), 'values'],
    ['enumOf duplicate', () => enumOf(['a', 'a']), 'values'],
    ['enumOf not snake_case', () => enumOf(['In Progress']), 'values.0'],
    ['enumOf default not a value', () => enumOf(['a', 'b'], { default: 'c' as 'a' }), 'default'],
    ['ref not snake_case', () => ref('Customer'), 'resource'],
    ['bool default not a boolean', () => bool({ default: 'yes' as unknown as boolean }), 'default'],
  ];

  it.each(refusals)('%s', (_, build, path) => {
    let caught: unknown;
    try {
      build();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DefinitionError);
    expect((caught as DefinitionError).issues.map((issue) => issue.path)).toContain(path);
  });

  it('refuses more than 100 enum values', () => {
    const values = Array.from({ length: 101 }, (_, index) => `v${String(index)}`);
    expect(() => enumOf(values as unknown as [string])).toThrow(DefinitionError);
  });
});

describe('the value schemas', () => {
  it('bounds rich text by depth and keeps blocks strict', () => {
    const nest = (depth: number): { type: string; children?: unknown[] } =>
      depth === 1 ? { type: 'p' } : { type: 'p', children: [nest(depth - 1)] };
    expect(richText().zod.safeParse([nest(8)]).success).toBe(true);
    expect(richText().zod.safeParse([nest(9)]).success).toBe(false);
    expect(richText().zod.safeParse([{ type: 'p', style: 'x' }]).success).toBe(false);
  });

  it('bounds rich text at 256 KiB', () => {
    const big = [{ type: 'p', text: 'x'.repeat(256 * 1024) }];
    expect(richText().zod.safeParse(big).success).toBe(false);
  });

  it('keeps money exact and in the field currency', () => {
    const field = money({ currency: 'USD' });
    expect(field.zod.safeParse({ amount: '12.34', currency: 'USD' }).success).toBe(true);
    expect(field.zod.safeParse({ amount: 12.34, currency: 'USD' }).success).toBe(false);
    expect(field.zod.safeParse({ amount: '1', currency: 'JPY' }).success).toBe(false);
  });

  it('refuses a non-uuid person, more than 100 files and an empty tag', () => {
    expect(person().zod.safeParse('someone@example.com').success).toBe(false);
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
    expect(files().zod.safeParse(ids).success).toBe(false);
    expect(tags().zod.safeParse(['']).success).toBe(false);
  });
});
