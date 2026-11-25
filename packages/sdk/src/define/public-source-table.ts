import { itemsOf, parsedJson, type ItemDraft } from './public-source-feed.js';
import {
  PUBLIC_SOURCE_LIMITS,
  PublicSourceError,
  type PublicSourceFeed,
  type PublicSourceItem,
  type PublicSourceMapping,
} from './public-source.js';

/**
 * Turns a `json-records` or `csv` source into items through its mapping (ADR-0170 D6): a list of
 * restricted parties, a table of filings, a statistics release. The mapping names the property or
 * column of each part of an item; `fields` keeps the named extra ones under their own names. A
 * value that is an object or an array is never kept: an item holds scalars only.
 *
 * Rows are made one at a time and hold only the mapped columns, so a wide or long source costs
 * memory for what is kept, not for what is read; a CSV source has at most 512 columns.
 */

type Scalar = string | number | boolean | null;
type Row = Readonly<Record<string, unknown>>;

function scalar(value: unknown): Scalar | undefined {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? value
    : undefined;
}

function text(value: unknown): string | undefined {
  const kept = scalar(value);
  return kept === undefined || kept === null ? undefined : String(kept);
}

/** Every column name the mapping reads. */
function mappedNames(mapping: PublicSourceMapping): readonly string[] {
  const named = [mapping.id, mapping.title, mapping.url, mapping.date, mapping.summary];
  return [...named.filter((name): name is string => name !== undefined), ...(mapping.fields ?? [])];
}

function draftOf(row: Row, mapping: PublicSourceMapping, feed: PublicSourceFeed): ItemDraft {
  const fields: Record<string, Scalar> = {};
  for (const name of mapping.fields ?? []) {
    const value = scalar(row[name]);
    if (value !== undefined) fields[name] = value;
  }
  return {
    id: mapping.id === undefined ? undefined : text(row[mapping.id]),
    url: mapping.url === undefined ? feed.url : text(row[mapping.url]),
    title: text(row[mapping.title]),
    summary: mapping.summary === undefined ? undefined : text(row[mapping.summary]),
    published: mapping.date === undefined ? undefined : text(row[mapping.date]),
    ...(mapping.fields === undefined ? {} : { fields }),
  };
}

/** The rows of a JSON document: the document itself or its `mapping.records` property. */
function jsonRows(body: string, mapping: PublicSourceMapping, source: string): readonly Row[] {
  const data = parsedJson(body, source);
  const rows =
    mapping.records === undefined
      ? data
      : data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Row)[mapping.records]
        : undefined;
  if (!Array.isArray(rows)) throw new PublicSourceError('source_invalid', source);
  return rows.filter(
    (row): row is Row => row !== null && typeof row === 'object' && !Array.isArray(row),
  );
}

/** Where each mapped name is: by the header row's names, or by the mapping's own `columns`. */
function positionsOf(
  names: readonly string[],
  mapping: PublicSourceMapping,
  source: string,
): ReadonlyMap<number, string> {
  const positions = new Map<number, string>();
  for (const name of mappedNames(mapping)) {
    const at = names.indexOf(name);
    if (at === -1) throw new PublicSourceError('source_invalid', source);
    positions.set(at, name);
  }
  return positions;
}

/**
 * The rows of a CSV text (RFC 4180: `,` between cells, `"` around a cell that holds one, `""` for
 * a quote inside it, CRLF, CR or LF between rows), each with only the mapped columns, one pass over
 * the text and one row at a time. The first row is the header unless the mapping names the
 * `columns`. An unclosed quote, a header past the column limit, or a missing mapped column is
 * refused.
 */
function* csvRows(
  body: string,
  mapping: PublicSourceMapping,
  source: string,
): Generator<Row, void, undefined> {
  // `null` while the header row is being read: then every cell is kept, to learn the names.
  let positions =
    mapping.columns === undefined ? null : positionsOf(mapping.columns, mapping, source);
  let cells = new Map<number, string>();
  let column = 0;
  let cell = '';
  let quoted = false;
  let read = false;
  const keeps = (at: number): boolean => positions === null || positions.has(at);
  // A line end is added past the text, so the last row ends like every other.
  for (let at = 0; at <= body.length; at += 1) {
    const character = at < body.length ? body.charAt(at) : '\n';
    if (quoted) {
      if (character === '"' && body.charAt(at + 1) === '"') {
        if (keeps(column)) cell += '"';
        at += 1;
      } else if (character === '"') quoted = false;
      else if (at < body.length && keeps(column)) cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',' || character === '\n' || character === '\r') {
      if (keeps(column)) cells.set(column, cell);
      cell = '';
      column += 1;
      if (positions === null && column > PUBLIC_SOURCE_LIMITS.csvColumns) {
        throw new PublicSourceError('source_too_wide', source);
      }
      if (character === ',') continue;
      if (character === '\r' && body.charAt(at + 1) === '\n') at += 1;
      const row = cells;
      cells = new Map();
      column = 0;
      if (![...row.values()].some((value) => value !== '')) continue;
      if (positions === null) {
        const names = [...row.values()].map((name) => name.trim());
        positions = positionsOf(names, mapping, source);
        read = true;
        continue;
      }
      read = true;
      const kept: Record<string, string> = {};
      for (const [position, name] of positions) kept[name] = row.get(position) ?? '';
      yield kept;
    } else if (keeps(column)) cell += character;
  }
  if (quoted || !read) throw new PublicSourceError('source_invalid', source);
}

/**
 * The items of a `json-records` or `csv` source's `body`, through its mapping, one at a time.
 *
 * @throws {PublicSourceError} when read: `source_invalid` if the body is not of its format or
 * lacks a mapped column, `source_too_wide` past the CSV column limit.
 */
export function* parsePublicTable(
  body: string,
  feed: PublicSourceFeed & { readonly mapping: PublicSourceMapping },
  retrievedAt: string,
): Generator<PublicSourceItem, void, undefined> {
  const rows =
    feed.format === 'csv'
      ? csvRows(body, feed.mapping, feed.name)
      : jsonRows(body, feed.mapping, feed.name);
  yield* itemsOf(drafts(rows, feed), feed, retrievedAt);
}

function* drafts(
  rows: Iterable<Row>,
  feed: PublicSourceFeed & { readonly mapping: PublicSourceMapping },
): Generator<ItemDraft, void, undefined> {
  for (const row of rows) yield draftOf(row, feed.mapping, feed);
}
