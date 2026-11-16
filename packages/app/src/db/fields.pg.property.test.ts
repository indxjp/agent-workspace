/**
 * "Zod accepts what the column stores", on PostgreSQL: every value the field-type arbitraries of
 * `fields.property.test.ts` produce is written through `storeOf` and read back equal. The
 * arbitraries are repeated here, not imported, because importing a test file registers its tests.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
} from '../index.js';
import { defineResource, type DefinedResource } from '../resource.js';
import { fakePerson } from '../testing/fake-person.js';
import { createTestAppSchema, type TestAppSchema } from '../testing/pg-test-schema.js';
import { storeOf } from './store.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const url = rawUrl === undefined || rawUrl.trim() === '' ? undefined : rawUrl;

if (url === undefined) {
  console.warn(
    '[db/fields.pg.property.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so no field value ' +
      'was round-tripped through PostgreSQL.',
  );
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
  ['rich_text', richText(), blocks],
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
  ['date_time', dateTime(), day],
  [
    'enum_of',
    enumOf(['new', 'in_progress', 'closed']),
    fc.constantFrom('new', 'in_progress', 'closed'),
  ],
  ['person', person(), fc.uuid({ version: 4 })],
  ['ref', ref('customer'), fc.uuid({ version: 4 })],
  ['files', files(), fc.array(fc.uuid({ version: 4 }), { maxLength: 100 })],
  ['tags', tags(), fc.array(fc.string({ minLength: 1, maxLength: 64 }), { maxLength: 100 })],
];

/** One resource per field type, the field as its only, required value. */
const resources: readonly (readonly [string, DefinedResource, fc.Arbitrary<unknown>])[] = cases.map(
  ([name, field, values]) => [
    name,
    defineResource({
      name: `value_${name}`,
      fields: { value: field },
      access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
      audit: false,
    }),
    values,
  ],
);

describe.skipIf(url === undefined)('every valid field value, through PostgreSQL', () => {
  let schema: TestAppSchema | undefined;

  beforeAll(async () => {
    schema = await createTestAppSchema(
      url ?? '',
      resources.map(([, resource]) => resource),
    );
  });

  afterAll(async () => {
    await schema?.drop();
  });

  it('covers every field type', () => {
    expect(new Set(cases.map(([, field]) => field.type)).size).toBe(12);
  });

  it.each(resources)('%s: is stored and read back equal', async (_, resource, values) => {
    if (schema === undefined) throw new Error('the test schema was not created');
    const store = storeOf(resource, { db: schema.db, appName: schema.appName });
    const someone = fakePerson({ workspaceId: crypto.randomUUID() });
    await fc.assert(
      fc.asyncProperty(values, async (value) => {
        const created = await store.create(someone, { value });
        expect(created['value']).toEqual(value);
        expect((await store.get(someone, created.id))['value']).toEqual(value);
      }),
      { numRuns: 50 },
    );
  });
});
