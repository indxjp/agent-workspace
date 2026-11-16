/**
 * The resume cursor of a `channel()` stream (issue #1518): where `GET /api/channels/<name>/events`
 * starts. The platform's rule, restated (the app kit cannot import it): a browser resends the last
 * `id:` it saw as the `Last-Event-ID` header on an automatic reconnect, and a page that reconnects
 * by hand passes `?after=` instead. Both are accepted and the header wins.
 *
 * Unrelated to the list cursor of `../db/cursor.ts`, which is opaque: this one is an event's
 * sequence, at most 19 digits and within PostgreSQL's `bigint`.
 *
 * The three cases are kept apart (the platform's ADR-0015): **absent** (a first connection, which
 * starts at the oldest retained event by definition), **after** (a well-formed sequence) and
 * **invalid** (present but malformed). An invalid cursor never degrades to absent: restarting a
 * malformed resume from the beginning replays the whole log to a client that believes it resumes.
 */

/** Where a stream resumes. */
export type ResumeCursor =
  | { readonly kind: 'absent' }
  | { readonly kind: 'after'; readonly id: bigint; readonly source: 'header' | 'query' }
  | { readonly kind: 'invalid'; readonly source: 'header' | 'query' };

/** The largest `bigint`, and so the largest event id a table can hold. */
const MAX_EVENT_ID = 9_223_372_036_854_775_807n;
const SEQUENCE = /^\d{1,19}$/u;

function sequenceOf(raw: string): bigint | null {
  const value = raw.trim();
  if (!SEQUENCE.test(value)) return null;
  const id = BigInt(value);
  return id > MAX_EVENT_ID ? null : id;
}

function cursorFrom(raw: string, source: 'header' | 'query'): ResumeCursor {
  const id = sequenceOf(raw);
  return id === null ? { kind: 'invalid', source } : { kind: 'after', id, source };
}

/**
 * The resume cursor of a request: its `Last-Event-ID` header, else its `after` query parameter.
 * Never throws.
 *
 * @param header the `Last-Event-ID` header, or `null` when the request has none.
 * @param query the `after` query parameter, or `null` when the request has none.
 */
export function readResumeCursor(header: string | null, query: string | null): ResumeCursor {
  if (header !== null) return cursorFrom(header, 'header');
  if (query !== null) return cursorFrom(query, 'query');
  return { kind: 'absent' };
}
