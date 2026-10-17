/**
 * The resume cursor — how `GET /api/runs/:id/events` decides where to start.
 *
 * R-13 finding 7 and its contract summary: the browser resends the last `id:` it saw as the
 * `Last-Event-ID` **request header** on every automatic reconnect, but a *manually*
 * reconstructed `EventSource` starts with no id and must pass `?after=` instead. The handler
 * accepts both and the header wins. Both are client-controlled input and neither may reach a
 * query unparsed.
 *
 * ADR-0015 is the whole design of this module. "The header is missing, so the guard is falsy, so
 * we fall through to replaying everything" is precisely the shape that ADR forbids, so the three
 * cases are named and separated instead:
 *
 *   * **absent**  — no header and no query parameter. This is a first connection, and delivering
 *                   from the beginning is its defined meaning, not a fallback.
 *   * **after**   — a well-formed id inside the storable range.
 *   * **invalid** — present but not parseable, or out of range. This never degrades to `absent`.
 *                   A server that silently restarts a malformed resume from zero re-delivers the
 *                   whole log to a client that believes it is resuming, which is a correctness
 *                   bug dressed as robustness.
 *
 * Since ENG-03 (#302) an id may also name a *frame within* a row — `<sequence>.<sub-index>`, the
 * grammar `sse.ts`'s `WIRE_EVENT_ID_PATTERN` documents — because a `run_events` row recorded before
 * that change is upgraded on read into one or more neutral frames. Both parts are parsed here, with
 * bounded ranges, so that `api.ts` can re-read the row and drop what the client already has rather
 * than resuming a row it can only deliver whole.
 */
import { MAX_EVENT_ID } from './sse';

export type ResumeCursor =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'after';
      readonly id: bigint;
      /**
       * The position within row {@link id} the client last saw, or `null` when the id named a whole
       * row. See `sse.ts`'s `WIRE_EVENT_ID_PATTERN`: a pre-ENG-03 row is upgraded on read into one
       * or more neutral frames, which share the row's sequence and are told apart by this index.
       */
      readonly subIndex: number | null;
      readonly source: 'header' | 'query';
    }
  | { readonly kind: 'invalid'; readonly source: 'header' | 'query'; readonly reason: string };

/**
 * A sequence of at most 19 digits — because `MAX_EVENT_ID` has 19, and the range check below does
 * the rest — optionally followed by a sub-index of at most 3.
 *
 * The sub-index is bounded rather than open for the same reason the sequence is: this is a
 * client-supplied string and every part of it must be parseable into a value with a known range
 * before anything compares it.
 */
const EVENT_ID_DIGITS = /^(\d{1,19})(?:\.(\d{1,3}))?$/;

type Parsed =
  | { readonly ok: true; readonly id: bigint; readonly subIndex: number | null }
  | { readonly ok: false; readonly reason: string };

function parseEventId(raw: string): Parsed {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: 'it is empty' };
  const match = EVENT_ID_DIGITS.exec(value);
  if (match === null) {
    return {
      ok: false,
      reason: `${JSON.stringify(raw)} is not 1-19 ASCII digits, optionally followed by "." and 1-3 more; run event ids are an unsigned decimal sequence with an optional frame sub-index`,
    };
  }
  // Parse before comparing. `BigInt` cannot throw here — the regex already proved the string is
  // digits — but the range check below is the one that matters: a 19-digit id passes the regex
  // and can still be larger than the bigint column that has to store it.
  const id = BigInt(match[1] ?? '');
  if (id > MAX_EVENT_ID) {
    return {
      ok: false,
      reason: `${value} exceeds the maximum run event id ${String(MAX_EVENT_ID)}`,
    };
  }
  const sub = match[2];
  return { ok: true, id, subIndex: sub === undefined ? null : Number(sub) };
}

/**
 * Read the resume cursor from the two places a client can put it. **Never throws.**
 *
 * @param header the `Last-Event-ID` request header, or `null` when it is not present
 * @param query  the `after` query parameter, or `null` when it is not present
 */
export function readResumeCursor(header: string | null, query: string | null): ResumeCursor {
  // The header wins when both are present: it is the browser's own bookkeeping, whereas the
  // query parameter is whatever the page last remembered.
  if (header !== null) {
    const parsed = parseEventId(header);
    return parsed.ok
      ? { kind: 'after', id: parsed.id, subIndex: parsed.subIndex, source: 'header' }
      : { kind: 'invalid', source: 'header', reason: `Last-Event-ID is invalid: ${parsed.reason}` };
  }
  if (query !== null) {
    const parsed = parseEventId(query);
    return parsed.ok
      ? { kind: 'after', id: parsed.id, subIndex: parsed.subIndex, source: 'query' }
      : {
          kind: 'invalid',
          source: 'query',
          reason: `the "after" parameter is invalid: ${parsed.reason}`,
        };
  }
  return { kind: 'absent' };
}
