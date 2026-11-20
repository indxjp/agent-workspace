/**
 * The sample records of the live Agent Store entries whose data is not a seed folder
 * (`demo.records`): every record parses against the resource or fixture it stands for, the Japanese
 * and English sets hold the same records, and the first suggested prompt of each entry points at
 * records that exist.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { PAGE_BLOCK_TYPES } from '@indx-workspace/app';
import { describe, expect, it } from 'vitest';

import type { LiveEntry } from '../../examples/store/catalog/define.ts';
import {
  type AppField,
  type AppResource,
  bySlugRows,
  entryOf,
  LANGS,
  type Lang,
  readApp,
  readJson,
  recordsFolder,
  sourceOf,
  live,
  withRecords,
} from './sample-data.test-support.ts';

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Whether `value` is a well-formed money amount in JSON form. */
function isMoney(value: unknown): boolean {
  const money = value as { amount?: unknown; currency?: unknown };
  return (
    typeof money.amount === 'string' &&
    /^\d+(?:\.\d+)?$/u.test(money.amount) &&
    typeof money.currency === 'string'
  );
}

/** Whether `value` is a list of rich-text blocks in JSON form. */
function isRichText(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (block: { type?: unknown; text?: unknown }) =>
        typeof block.type === 'string' && typeof block.text === 'string',
    )
  );
}

/** Whether `value` is one the field's type holds (the app's own field types, in JSON form). */
function validValue(field: AppField, value: unknown): boolean {
  switch (field.ctor) {
    case 'text':
      return typeof value === 'string' && value.trim() !== '';
    case 'ref':
    case 'person':
      return typeof value === 'string' && UUID.test(value);
    case 'enumOf':
      return [...field.args.matchAll(/'(\w+)'/gu)].some((match) => match[1] === value);
    case 'money':
      return isMoney(value);
    case 'richText':
      return isRichText(value);
    case 'tags':
      return Array.isArray(value) && value.every((tag) => typeof tag === 'string' && tag !== '');
    case 'bool':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    default:
      return false;
  }
}

/** The record ids of each table, by table name. */
type TableIds = ReadonlyMap<string, ReadonlySet<string>>;

/** What is wrong with one value of a field, or nothing. */
function valueProblems(
  where: string,
  key: string,
  field: AppField,
  value: unknown,
  ids: TableIds,
): string[] {
  const problems: string[] = [];
  if (!validValue(field, value)) problems.push(`${where}: ${key} is not a valid value`);
  const target = /^'(\w+)'/u.exec(field.args)?.[1];
  const pointsAtNothing =
    field.ctor === 'ref' &&
    ids.get(target ?? '')?.has(typeof value === 'string' ? value : '') !== true;
  if (pointsAtNothing) problems.push(`${where}: ${key} points at no ${String(target)}`);
  return problems;
}

/** What is wrong with one record of a table, against the resource it stands for. */
function rowProblems(name: string, resource: AppResource, row: Row, ids: TableIds): string[] {
  const { id, ...values } = row;
  const where = `${name} ${String(id)}`;
  const problems: string[] = [];
  if (!UUID.test(String(id))) problems.push(`${where}: the id is not a uuid`);
  for (const key of Object.keys(values)) {
    if (!resource.fields.has(key)) problems.push(`${where}.${key}: not a field`);
  }
  for (const [key, field] of resource.fields) {
    const value = values[key];
    if (value !== undefined) problems.push(...valueProblems(where, key, field, value, ids));
    else if (!field.optional) problems.push(`${where}: ${key} is missing`);
  }
  return problems;
}

/** The record tables of one language's folder, by table name. */
function readTables(folder: string): Map<string, Row[]> {
  return new Map(
    readdirSync(folder).map((file) => [
      path.basename(file, '.json'),
      readJson(path.join(folder, file)) as Row[],
    ]),
  );
}

/** The identifying value of a record list or a record map, so two languages compare by records. */
const recordKeys = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((row) => String((row as { id?: string }).id))
    : Object.keys(value as object);

describe('the sample records of an entry with no sample files', () => {
  it('are named by exactly the entries whose seed is empty', () => {
    const unseeded = live.filter((entry) => entry.demo.seed.length === 0).map((e) => e.slug);
    expect(withRecords.map((entry) => entry.slug).sort()).toEqual(unseeded.sort());
    for (const entry of live) {
      // An entry with files to seed keeps them; records are the other way to carry sample data.
      if (entry.demo.seed.length > 0) expect(entry.demo.records).toBeUndefined();
    }
  });

  it.each(bySlugRows(withRecords))(
    '%s: a folder inside its source holds a Japanese and an English set with the same records',
    (_slug, entry) => {
      const folder = path.join(sourceOf(entry), entry.demo.records ?? '');
      expect(statSync(folder).isDirectory()).toBe(true);
      const names = LANGS.map((lang) => readdirSync(recordsFolder(entry, lang)).sort());
      expect(names[0]?.length).toBeGreaterThan(0);
      expect(names[0]).toEqual(names[1]);
      for (const file of names[0] ?? []) {
        const [ja, en] = LANGS.map((lang) => readJson(path.join(recordsFolder(entry, lang), file)));
        // The same records in the same order: only the words differ.
        expect(recordKeys(ja), file).toEqual(recordKeys(en));
      }
    },
  );
});

describe.each(
  bySlugRows(
    (['crm-sales', 'team-chat', 'wiki', 'service-desk'] as const).map((slug) =>
      entryOf(withRecords, slug),
    ),
  ),
)('the sample records of %s', (_slug, entry) => {
  const resources = new Map(readApp(sourceOf(entry)).map((resource) => [resource.name, resource]));

  it.each(LANGS)('%s records parse against the app resources and point at each other', (lang) => {
    const tables = readTables(recordsFolder(entry, lang));
    const ids: TableIds = new Map(
      [...tables].map(([name, rows]) => [name, new Set(rows.map((row) => String(row['id'])))]),
    );
    expect([...tables.keys()].filter((name) => !resources.has(name))).toEqual([]);
    const problems: string[] = [];
    for (const [name, rows] of tables) {
      const resource = resources.get(name);
      if (resource === undefined) continue;
      for (const row of rows) problems.push(...rowProblems(name, resource, row, ids));
      expect(new Set(rows.map((row) => row['id'])).size, `${name} ids are distinct`).toBe(
        rows.length,
      );
    }
    expect(problems).toEqual([]);
  });
});

describe('the sample records of the quotation entry', () => {
  const entry = entryOf(withRecords, 'quotation');
  const fixtures = path.join(sourceOf(entry), 'data', 'erp');
  /** The type of every top-level value of `value`, so two records can be compared by shape. */
  const shape = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return ['array', ...new Set(value.map((item) => JSON.stringify(shape(item))))];
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]));
    }
    return typeof value;
  };

  it.each(LANGS)('%s parts, orders and rates have the shape of the ERP fixtures', (lang) => {
    for (const name of ['parts', 'orders', 'rates']) {
      const sample = readJson(path.join(recordsFolder(entry, lang), `${name}.json`));
      const fixture = readJson(path.join(fixtures, `${name}.json`));
      if (name === 'rates') {
        const [one] = Object.values(sample as Record<string, unknown>);
        const [other] = Object.values(fixture as Record<string, unknown>);
        expect(shape(one)).toEqual(shape(other));
      } else {
        for (const row of sample as unknown[]) {
          expect(shape(row), name).toEqual(shape((fixture as unknown[])[0]));
        }
      }
    }
  });

  it.each(LANGS)('%s orders and parts agree, and every order names a known part', (lang) => {
    const read = (name: string): unknown => readJson(path.join(recordsFolder(entry, lang), name));
    const parts = read('parts.json') as {
      partNo: string;
      orderNos: string[];
      customer: string;
    }[];
    const orders = read('orders.json') as {
      orderNo: string;
      partNo: string;
      customer: string;
      quantity: number;
      unitPrice: number;
      amount: number;
    }[];
    const partNos = new Set(parts.map((part) => part.partNo));
    for (const order of orders) {
      expect(partNos.has(order.partNo), order.orderNo).toBe(true);
      expect(order.amount, order.orderNo).toBe(order.quantity * order.unitPrice);
      const part = parts.find((candidate) => candidate.partNo === order.partNo);
      expect(part?.orderNos, order.partNo).toContain(order.orderNo);
      expect(part?.customer, order.orderNo).toBe(order.customer);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The prompts point at records that exist
// ---------------------------------------------------------------------------------------------

const records = (slug: string, lang: Lang, name: string): Row[] =>
  readJson(path.join(recordsFolder(entryOf(withRecords, slug), lang), `${name}.json`)) as Row[];

const prompt = (entry: LiveEntry, lang: Lang): string => entry.demo.prompts[0]?.[lang] ?? '';
const promptOf = (slug: string, lang: Lang): string => prompt(entryOf(withRecords, slug), lang);

describe('the first suggested prompt of an entry with sample records, for a CRM and a service desk', () => {
  it.each(LANGS)(
    'crm-sales (%s): the contact it names has no company, and its domain is one',
    (lang) => {
      const contact = records('crm-sales', lang, 'contact').find((row) =>
        promptOf('crm-sales', lang).includes(String(row['email'])),
      );
      expect(contact, 'the prompt names a contact by email').toBeDefined();
      expect(contact?.['company']).toBeUndefined();
      const domain = String(contact?.['email']).split('@')[1];
      expect(records('crm-sales', lang, 'company').some((row) => row['domain'] === domain)).toBe(
        true,
      );
    },
  );

  it.each(LANGS)('service-desk (%s): the ticket it names exists and is new', (lang) => {
    const text = promptOf('service-desk', lang);
    const ticket = records('service-desk', lang, 'ticket').find(
      (row) =>
        text.includes(`「${String(row['title'])}」`) || text.includes(`"${String(row['title'])}"`),
    );
    expect(ticket, 'the prompt names a ticket by title').toBeDefined();
    expect(ticket?.['status']).toBe('new');
  });
});

describe('the first suggested prompt of an entry with sample records, for chat, wiki and quotation', () => {
  it.each(LANGS)('team-chat (%s): the channel it names has messages to sum up', (lang) => {
    const channel = records('team-chat', lang, 'channel').find((row) =>
      promptOf('team-chat', lang).includes(`#${String(row['name'])}`),
    );
    expect(channel, 'the prompt names a channel').toBeDefined();
    const messages = records('team-chat', lang, 'message').filter(
      (row) => row['channel'] === channel?.['id'],
    );
    expect(messages.length).toBeGreaterThan(5);
  });

  it.each(LANGS)('wiki (%s): every block is a type a page holds', (lang) => {
    const types = records('wiki', lang, 'page').flatMap((row) =>
      (row['blocks'] as { type: string }[]).map((block) => block.type),
    );
    expect(types.length).toBeGreaterThan(0);
    const known: readonly string[] = PAGE_BLOCK_TYPES;
    expect(types.filter((type) => !known.includes(type))).toEqual([]);
  });

  it.each(LANGS)('wiki (%s): pages on expenses exist to be quoted', (lang) => {
    const word = lang === 'ja' ? '経費' : 'xpense';
    const pages = records('wiki', lang, 'page').filter((row) =>
      JSON.stringify([row['title'], row['blocks']]).includes(word),
    );
    expect(pages.length).toBeGreaterThanOrEqual(3);
  });

  it.each(LANGS)(
    'quotation (%s): the customer it names has an earlier order for a similar part',
    (lang) => {
      const text = promptOf('quotation', lang);
      const parts = records('quotation', lang, 'parts') as unknown as {
        customer: string;
        material: string;
      }[];
      expect(
        parts.some((part) => text.includes(part.customer) && text.includes(part.material)),
      ).toBe(true);
    },
  );
});
