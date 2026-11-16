/**
 * What the resource list, board and detail show, derived from a `defineResource` result alone
 * (issue #1508). Pure, with no React and no I/O, so every decision is tested without a renderer:
 * the columns, how one value reads in a cell, the board's columns, the filters, the paging state
 * and which field a server problem belongs to.
 */
import type { AnyField, CellKind, FieldType } from '../fields/types.js';
import type { DefinedResource } from '../resource.js';
import type { AppLocale, AppStrings } from './locale.js';

/** A page's own names for fields, by field name; a field without one reads humanised. */
export type FieldLabels = Readonly<Record<string, string>>;

/** A page's own names for enum values, by field name and value. */
export type ValueLabels = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** A record as the parts read it: its id, and its fields read by name with {@link fieldValue}. */
export interface RecordValues {
  readonly id: string;
}

/** The value of field `name` of `record`; `undefined` when it has none. */
export function fieldValue(record: RecordValues, name: string): unknown {
  return Object.hasOwn(record, name) ? (Reflect.get(record, name) as unknown) : undefined;
}

/** `in_progress` → `In progress`: how a snake_case name reads when the page names it no other way. */
export function humanize(name: string): string {
  const words = name.split('_').filter((word) => word.length > 0);
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The label of field `name`: the page's own, else humanised. */
export function fieldLabel(name: string, labels?: FieldLabels): string {
  return labels?.[name] ?? humanize(name);
}

/** The label of `value` of the enum field `name`: the page's own, else humanised. */
export function valueLabel(name: string, value: string, labels?: ValueLabels): string {
  return labels?.[name]?.[value] ?? humanize(value);
}

/** The values of an `enumOf()` field, in the order it was defined with; none for another field. */
export function enumValues(field: AnyField): readonly string[] {
  const values = field.options['values'];
  return field.type === 'enumOf' && Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string')
    : [];
}

/** One column of the list: a field, in definition order, shown with the field's cell. */
export interface ColumnView {
  readonly name: string;
  readonly label: string;
  readonly type: FieldType;
  readonly cell: CellKind;
}

/** One column per field, in the order the resource defines them. */
export function columnsOf(resource: DefinedResource, labels?: FieldLabels): readonly ColumnView[] {
  return Object.entries(resource.fields).map(([name, field]) => ({
    name,
    label: fieldLabel(name, labels),
    type: field.type,
    cell: field.cell,
  }));
}

/** The field a record is named by on a card and in a link: its first `text()` field. */
export function titleField(resource: DefinedResource): string | undefined {
  return Object.entries(resource.fields).find(([, field]) => field.type === 'text')?.[0];
}

/** The name a record is shown by: its title field's value, else the start of its id. */
export function recordTitle(resource: DefinedResource, record: RecordValues): string {
  const name = titleField(resource);
  const value = name === undefined ? undefined : fieldValue(record, name);
  return typeof value === 'string' && value.length > 0 ? value : shortId(record.id);
}

/** Where a record's detail is when the page says nothing else: `/<plural>/<id>`. */
export function defaultDetailHref(resource: DefinedResource, id: string): string {
  return `/${resource.plural}/${encodeURIComponent(id)}`;
}

/** The first eight characters of an id: enough to tell records apart on a page. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** What the parts need, besides the resource, to say a value in a person's words. */
export interface DisplayContext {
  readonly strings: AppStrings;
  readonly locale: AppLocale;
  /** Display names of principals by id, for `person()` fields; an unknown id reads short. */
  readonly people?: Readonly<Record<string, string>> | undefined;
  readonly valueLabels?: ValueLabels | undefined;
  /** Where a `ref()` value links to; `/<resource>s/<id>` when not given. */
  readonly refHref?: ((resource: string, id: string) => string) | undefined;
  /** The time zone dates and times are shown in; `UTC` when not given, so server and browser agree. */
  readonly timeZone?: string | undefined;
}

/** How one value reads in a cell or a detail row. */
export type CellView =
  | { readonly kind: 'empty'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'time'; readonly text: string; readonly dateTime: string }
  | { readonly kind: 'badge'; readonly text: string; readonly value: string }
  | { readonly kind: 'person'; readonly text: string; readonly initial: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }
  | { readonly kind: 'chips'; readonly items: readonly string[] };

/** The text of a rich-text value's blocks, in order, as one line. */
function plainText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((block: unknown) => {
      if (typeof block !== 'object' || block === null) return [];
      const text: unknown = Reflect.get(block, 'text');
      const below = plainText(Reflect.get(block, 'children'));
      return [typeof text === 'string' ? text : '', below].filter((part) => part.length > 0);
    })
    .join(' ');
}

/** The most characters an excerpt shows. */
const EXCERPT_MAX = 120;

function excerpt(value: unknown): string {
  const text = plainText(value);
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text;
}

function moneyText(value: unknown, locale: AppLocale): string {
  if (typeof value !== 'object' || value === null) return '';
  const amount: unknown = Reflect.get(value, 'amount');
  const currency: unknown = Reflect.get(value, 'currency');
  if (typeof amount !== 'string' || typeof currency !== 'string') return '';
  // A decimal string is formatted exactly (Intl.NumberFormat v3): no rounding through a float.
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
    amount as Intl.StringNumericLiteral,
  );
}

function timeView(type: FieldType, value: string, context: DisplayContext): CellView {
  const timeZone = context.timeZone ?? 'UTC';
  const instant = new Date(type === 'date' ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(instant.getTime())) return { kind: 'text', text: value };
  const format = new Intl.DateTimeFormat(context.locale, {
    dateStyle: 'medium',
    ...(type === 'date' ? { timeZone: 'UTC' } : { timeStyle: 'short', timeZone }),
  });
  return { kind: 'time', text: format.format(instant), dateTime: value };
}

function personView(id: string, context: DisplayContext): CellView {
  const text = context.people?.[id] ?? shortId(id);
  return { kind: 'person', text, initial: text.charAt(0).toUpperCase() };
}

function refView(field: AnyField, id: string, context: DisplayContext): CellView {
  const target = String(field.options['resource']);
  const href = context.refHref?.(target, id) ?? `/${target}s/${encodeURIComponent(id)}`;
  return { kind: 'link', text: shortId(id), href };
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** How the value of field `name` reads in a cell, by the field's cell kind. */
export function cellView(
  name: string,
  field: AnyField,
  value: unknown,
  context: DisplayContext,
): CellView {
  const { strings, locale } = context;
  if (value === null || value === undefined) return emptyCell(strings);
  switch (field.cell) {
    case 'excerpt':
      return { kind: 'text', text: excerpt(value) };
    case 'number':
      return { kind: 'text', text: typeof value === 'number' ? value.toLocaleString(locale) : '' };
    case 'formatted':
      return { kind: 'text', text: moneyText(value, locale) };
    case 'check':
      return { kind: 'text', text: value === true ? strings.yes : strings.no };
    case 'relative':
      return typeof value === 'string' ? timeView(field.type, value, context) : emptyCell(strings);
    case 'badge':
      return typeof value === 'string'
        ? { kind: 'badge', text: valueLabel(name, value, context.valueLabels), value }
        : emptyCell(strings);
    case 'avatar':
      return typeof value === 'string' ? personView(value, context) : emptyCell(strings);
    case 'link':
      return typeof value === 'string' ? refView(field, value, context) : emptyCell(strings);
    case 'count':
      return { kind: 'text', text: strings.fileCount(stringList(value).length) };
    case 'chips':
      return { kind: 'chips', items: stringList(value) };
    case 'text':
      return typeof value === 'string' ? { kind: 'text', text: value } : emptyCell(strings);
  }
}

function emptyCell(strings: AppStrings): CellView {
  return { kind: 'empty', text: strings.noValue };
}

/** One column of the board: a value of its enum field and the records holding it. */
export interface BoardColumnView<R extends RecordValues> {
  readonly value: string;
  readonly label: string;
  readonly records: readonly R[];
}

/**
 * The `enumOf()` field a board groups by: `field` when given, else the resource's `board`.
 *
 * @throws {TypeError} when neither names an `enumOf()` field of the resource: a page bug.
 */
export function boardFieldOf(resource: DefinedResource, field?: string): string {
  const name = field ?? resource.board;
  if (name === undefined || resource.fields[name]?.type !== 'enumOf') {
    throw new TypeError(
      `ResourceBoard needs an enumOf() field to group "${resource.plural}" by: set the resource's board or pass field`,
    );
  }
  return name;
}

/**
 * The board's columns: one per value of the enum field, in the order the field defines them.
 * A record whose value is none of them (a value removed from the definition) is in no column.
 */
export function boardColumns<R extends RecordValues>(
  resource: DefinedResource,
  records: readonly R[],
  field: string,
  labels?: ValueLabels,
): readonly BoardColumnView<R>[] {
  const definition = resource.fields[field];
  const values = definition === undefined ? [] : enumValues(definition);
  return values.map((value) => ({
    value,
    label: valueLabel(field, value, labels),
    records: records.filter((record) => fieldValue(record, field) === value),
  }));
}

/** One filter of the list: a select of enum values, a person, or a calendar day. */
export type FilterView =
  | {
      readonly kind: 'enum';
      readonly name: string;
      readonly label: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | { readonly kind: 'person'; readonly name: string; readonly label: string }
  | { readonly kind: 'date'; readonly name: string; readonly label: string };

/** The filters a list offers: one per `enumOf()`, `person()` and `date()` field, in order. */
export function filtersOf(
  resource: DefinedResource,
  labels?: FieldLabels,
  valueLabels?: ValueLabels,
): readonly FilterView[] {
  return Object.entries(resource.fields).flatMap(([name, field]): FilterView[] => {
    const label = fieldLabel(name, labels);
    if (field.type === 'enumOf') {
      const options = enumValues(field).map((value) => ({
        value,
        label: valueLabel(name, value, valueLabels),
      }));
      return [{ kind: 'enum', name, label, options }];
    }
    if (field.type === 'person' || field.type === 'date')
      return [{ kind: field.type, name, label }];
    return [];
  });
}

/** The filters with a value, as the list route's query takes them (`<field>=<value>`). */
export function activeFilters(
  resource: DefinedResource,
  filters: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([name, value]) => value.length > 0 && Object.hasOwn(resource.fields, name),
    ),
  );
}

/** Server problem details split by where they show: on a field, or on the form. */
export interface ProblemPlacement {
  /** The detail lines of each field, by field name. */
  readonly fields: Readonly<Record<string, readonly string[]>>;
  /** The lines that name no field of the resource. */
  readonly form: readonly string[];
}

/** A detail line's leading dotted path (`title`, `amount.currency`, `fields:status`), and the rest. */
const DETAIL_PATH = /^(?:fields:)?([a-z][a-z0-9_]*)(?:\.[\w.]*)?(?::\s*(.*))?$/su;

/**
 * Places the `details` of an ADR-0075 problem: a line whose dotted path starts with a field of
 * the resource belongs to that field (the store's `invalid_body` names `title`, `price.amount` or
 * `title: Too long`; an agent's refused field is `fields:<name>`); every other line belongs to the
 * form.
 */
export function placeProblemDetails(
  resource: DefinedResource,
  details: readonly string[] | undefined,
): ProblemPlacement {
  const fields: Record<string, string[]> = {};
  const form: string[] = [];
  for (const line of details ?? []) {
    const match = DETAIL_PATH.exec(line.trim());
    const name = match?.[1];
    if (name === undefined || !Object.hasOwn(resource.fields, name)) {
      form.push(line);
      continue;
    }
    (fields[name] ??= []).push(match?.[2] ?? '');
  }
  return { fields, form };
}

/** The list's paging: what is loaded, the next cursor, the filters and the request in flight. */
export interface PagesState<R> {
  readonly items: readonly R[];
  readonly nextCursor: string | null;
  readonly filters: Readonly<Record<string, string>>;
  readonly status: 'idle' | 'loading' | 'failed';
  /** The request whose answer the state is waiting for; an older answer is dropped. */
  readonly pending: { readonly seq: number; readonly append: boolean } | null;
}

/** What changes the paging state. */
export type PagesAction<R> =
  | {
      readonly type: 'request';
      readonly seq: number;
      readonly append: boolean;
      readonly filters: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'loaded';
      readonly seq: number;
      readonly items: readonly R[];
      readonly nextCursor: string | null;
    }
  | { readonly type: 'failed'; readonly seq: number };

/** The paging state a list starts in, from a first page a server rendered (or none). */
export function initialPages<R>(
  page: { readonly items: readonly R[]; readonly nextCursor: string | null } | undefined,
  filters: Readonly<Record<string, string>> = {},
): PagesState<R> {
  return {
    items: page?.items ?? [],
    nextCursor: page?.nextCursor ?? null,
    filters,
    status: 'idle',
    pending: null,
  };
}

/**
 * The paging state machine. A new filter starts again from the first page; "Load more" appends.
 * Only the latest request's answer is applied, so a slow page cannot overwrite a newer filter.
 */
export function pagesReducer<R>(state: PagesState<R>, action: PagesAction<R>): PagesState<R> {
  if (action.type === 'request') {
    return {
      ...state,
      filters: action.filters,
      status: 'loading',
      pending: { seq: action.seq, append: action.append },
    };
  }
  if (state.pending?.seq !== action.seq) return state;
  if (action.type === 'failed') return { ...state, status: 'failed' };
  return {
    ...state,
    items: state.pending.append ? [...state.items, ...action.items] : action.items,
    nextCursor: action.nextCursor,
    status: 'idle',
    pending: null,
  };
}
