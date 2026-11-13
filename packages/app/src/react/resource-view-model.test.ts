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
} from '../fields/index.js';
import { defineResource } from '../resource.js';
import { appStrings } from './locale.js';
import {
  activeFilters,
  boardColumns,
  boardFieldOf,
  cellView,
  columnsOf,
  filtersOf,
  humanize,
  initialPages,
  pagesReducer,
  placeProblemDetails,
  recordTitle,
  type DisplayContext,
} from './resource-view-model.js';

/** One field of every type of #1501, in definition order. */
const everything = defineResource({
  name: 'thing',
  fields: {
    title: text({ max: 80 }),
    body: richText({ optional: true }),
    count: number({ min: 0 }),
    price: money({ currency: 'JPY' }),
    done: bool(),
    due_on: date({ optional: true }),
    seen_at: dateTime({ optional: true }),
    status: enumOf(['new', 'in_progress', 'closed'], { default: 'new' }),
    owner: person({ optional: true }),
    parent: ref('project', { optional: true }),
    attachments: files(),
    labels: tags(),
  },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  board: 'status',
});

const ID = '0f5c2a8e-1b2c-4d3e-8f90-123456789abc';
const OWNER = 'a1b2c3d4-0000-4000-8000-000000000001';
const FILE = 'f0000000-0000-4000-8000-000000000001';

const en: DisplayContext = { strings: appStrings('en'), locale: 'en' };
const ja: DisplayContext = { strings: appStrings('ja'), locale: 'ja' };

function cell(name: keyof typeof everything.fields, value: unknown, context = en) {
  return cellView(name, everything.fields[name], value, context);
}

describe('columnsOf (#1508)', () => {
  it('derives one column per field, in order, with the field cell of every #1501 type', () => {
    expect(columnsOf(everything).map((column) => [column.name, column.type, column.cell])).toEqual([
      ['title', 'text', 'text'],
      ['body', 'richText', 'excerpt'],
      ['count', 'number', 'number'],
      ['price', 'money', 'formatted'],
      ['done', 'bool', 'check'],
      ['due_on', 'date', 'relative'],
      ['seen_at', 'dateTime', 'relative'],
      ['status', 'enumOf', 'badge'],
      ['owner', 'person', 'avatar'],
      ['parent', 'ref', 'link'],
      ['attachments', 'files', 'count'],
      ['labels', 'tags', 'chips'],
    ]);
  });

  it('labels a column by the humanised field name, or the page label', () => {
    expect(humanize('due_on')).toBe('Due on');
    expect(humanize('in_progress')).toBe('In progress');
    const labels = columnsOf(everything, { due_on: '期日' }).map((column) => column.label);
    expect(labels).toContain('期日');
    expect(labels).toContain('Seen at');
  });
});

describe('cellView (#1508)', () => {
  it('reads every cell kind', () => {
    expect(cell('title', 'Printer jam')).toEqual({ kind: 'text', text: 'Printer jam' });
    expect(
      cell('body', [
        { type: 'paragraph', text: 'First' },
        { type: 'list', children: [{ type: 'item', text: 'two' }] },
      ]),
    ).toEqual({ kind: 'text', text: 'First two' });
    expect(cell('count', 12345)).toEqual({ kind: 'text', text: '12,345' });
    expect(cell('price', { amount: '1500', currency: 'JPY' })).toEqual({
      kind: 'text',
      text: '¥1,500',
    });
    expect(cell('done', true)).toEqual({ kind: 'text', text: 'Yes' });
    expect(cell('done', false, ja)).toEqual({ kind: 'text', text: 'いいえ' });
    expect(cell('due_on', '2026-10-31')).toEqual({
      kind: 'time',
      text: 'Oct 31, 2026',
      dateTime: '2026-10-31',
    });
    expect(cell('seen_at', '2026-10-31T09:30:00Z')).toMatchObject({
      kind: 'time',
      dateTime: '2026-10-31T09:30:00Z',
    });
    expect(cell('status', 'in_progress')).toEqual({
      kind: 'badge',
      text: 'In progress',
      value: 'in_progress',
    });
    expect(cell('owner', OWNER)).toEqual({ kind: 'person', text: 'a1b2c3d4', initial: 'A' });
    expect(cell('owner', OWNER, { ...en, people: { [OWNER]: 'Aiko Sato' } })).toEqual({
      kind: 'person',
      text: 'Aiko Sato',
      initial: 'A',
    });
    expect(cell('parent', ID)).toEqual({ kind: 'link', text: '0f5c2a8e', href: `/projects/${ID}` });
    expect(
      cell('parent', ID, { ...en, refHref: (target, id) => `/p/${target}/${id}` }),
    ).toMatchObject({
      href: `/p/project/${ID}`,
    });
    expect(cell('attachments', [FILE, FILE])).toEqual({ kind: 'text', text: '2 files' });
    expect(cell('labels', ['urgent', 'vip'])).toEqual({ kind: 'chips', items: ['urgent', 'vip'] });
  });

  it('reads an unset value as no value, and a malformed one never as [object Object]', () => {
    expect(cell('owner', null)).toEqual({ kind: 'empty', text: '—' });
    expect(cell('title', { not: 'a string' })).toEqual({ kind: 'empty', text: '—' });
    expect(cell('status', 3)).toEqual({ kind: 'empty', text: '—' });
  });

  it('names a record by its first text field, else its short id', () => {
    const titled = (title: string) => ({ id: ID, title });
    expect(recordTitle(everything, titled('Printer jam'))).toBe('Printer jam');
    expect(recordTitle(everything, titled(''))).toBe('0f5c2a8e');
  });
});

describe('boardColumns (#1508)', () => {
  const records = [
    { id: '1', status: 'closed' },
    { id: '2', status: 'new' },
    { id: '3', status: 'retired' },
    { id: '4', status: 'new' },
  ];

  it('keeps the enum order and puts a value the field no longer defines in no column', () => {
    const columns = boardColumns(everything, records, 'status');
    expect(
      columns.map((column) => [column.value, column.label, column.records.map((r) => r.id)]),
    ).toEqual([
      ['new', 'New', ['2', '4']],
      ['in_progress', 'In progress', []],
      ['closed', 'Closed', ['1']],
    ]);
    expect(columns.flatMap((column) => column.records).map((r) => r.id)).not.toContain('3');
  });

  it("groups by the resource's board, or a named enum field, and refuses anything else", () => {
    expect(boardFieldOf(everything)).toBe('status');
    expect(() => boardFieldOf(everything, 'title')).toThrow(TypeError);
    const noBoard = defineResource({
      name: 'note',
      fields: { title: text() },
      access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
    });
    expect(() => boardFieldOf(noBoard)).toThrow(/enumOf\(\) field/u);
  });

  it('uses the page labels of values', () => {
    const [first] = boardColumns(everything, [], 'status', { status: { new: '新規' } });
    expect(first?.label).toBe('新規');
  });
});

describe('filtersOf (#1508)', () => {
  it('offers one filter per enumOf, person and date field, in order', () => {
    expect(filtersOf(everything)).toEqual([
      { kind: 'date', name: 'due_on', label: 'Due on' },
      {
        kind: 'enum',
        name: 'status',
        label: 'Status',
        options: [
          { value: 'new', label: 'New' },
          { value: 'in_progress', label: 'In progress' },
          { value: 'closed', label: 'Closed' },
        ],
      },
      { kind: 'person', name: 'owner', label: 'Owner' },
    ]);
  });

  it('sends only filters with a value that name a field', () => {
    expect(activeFilters(everything, { status: 'new', owner: '', cursor: 'x' })).toEqual({
      status: 'new',
    });
  });
});

describe('placeProblemDetails (#1508): problem → field from error.details', () => {
  it('puts a dotted path naming a field on that field, and everything else on the form', () => {
    expect(
      placeProblemDetails(everything, [
        'title',
        'price.amount: amount must be a decimal string',
        'fields:status',
        'cursor: not a cursor',
        'the body is not an object',
      ]),
    ).toEqual({
      fields: { title: [''], price: ['amount must be a decimal string'], status: [''] },
      form: ['cursor: not a cursor', 'the body is not an object'],
    });
    expect(placeProblemDetails(everything, undefined)).toEqual({ fields: {}, form: [] });
  });
});

describe('pagesReducer (#1508)', () => {
  const page = { items: [{ id: 'a' }], nextCursor: 'c1' };

  it('appends a next page and replaces on a new filter', () => {
    let state = initialPages(page);
    state = pagesReducer(state, { type: 'request', seq: 1, append: true, filters: {} });
    expect(state.status).toBe('loading');
    state = pagesReducer(state, { type: 'loaded', seq: 1, items: [{ id: 'b' }], nextCursor: null });
    expect(state.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(state.nextCursor).toBeNull();
    state = pagesReducer(state, {
      type: 'request',
      seq: 2,
      append: false,
      filters: { status: 'new' },
    });
    state = pagesReducer(state, { type: 'loaded', seq: 2, items: [{ id: 'c' }], nextCursor: null });
    expect(state.items.map((item) => item.id)).toEqual(['c']);
    expect(state.filters).toEqual({ status: 'new' });
  });

  it('drops a stale answer and records a failure', () => {
    let state = initialPages(page);
    state = pagesReducer(state, { type: 'request', seq: 1, append: true, filters: {} });
    state = pagesReducer(state, {
      type: 'request',
      seq: 2,
      append: false,
      filters: { status: 'new' },
    });
    const stale = pagesReducer(state, {
      type: 'loaded',
      seq: 1,
      items: [{ id: 'old' }],
      nextCursor: null,
    });
    expect(stale).toBe(state);
    state = pagesReducer(state, { type: 'failed', seq: 2 });
    expect(state.status).toBe('failed');
    expect(state.items).toEqual(page.items);
  });
});
