/**
 * The timestamp half of every keyset cursor this control plane mints (`GET /api/runs`,
 * `GET /api/sessions`, `GET /api/audit-events`): the exact text a boundary's `created_at` may be,
 * checked before it reaches a `::timestamptz` cast so a crafted value is a `400`, never a thrown
 * query.
 */

/**
 * The exact text a keyset cursor's `createdAt` may take: `YYYY-MM-DDTHH:MM:SS.fZ`, one to six
 * fractional digits, always UTC, never signed. Both stores mint inside this shape — the repository
 * at six digits (`to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, see
 * `packages/core/src/db/repositories/runs.ts`'s `LIST_RUN_COLUMNS`) and `InMemoryRunStore` at three
 * (`Date.prototype.toISOString`) — and PostgreSQL reads every value of it as `timestamptz` without
 * loss. Anything outside it was not minted by this code.
 */
const KEYSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{1,6}Z$/;

/** The calendar fields a cursor or bound timestamp is made of, as the digits name them. */
interface UtcCalendarFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * The UTC instant `fields` name, or `null` when they name none. PostgreSQL's calendar has no
 * year 0, and `Date` silently rolls an impossible day or hour over into the next one, so the
 * instant is rebuilt from the fields and read back: fields that do not survive the round trip
 * never named a real instant. `setUTCFullYear`, not `Date.UTC`: the latter reads a two-digit year
 * as 19xx, which would wrongly refuse years 0001–0099 that PostgreSQL accepts.
 */
export function instantOfUtcFields(fields: UtcCalendarFields): Date | null {
  if (fields.year === 0) return null;
  const rebuilt = new Date(0);
  rebuilt.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  rebuilt.setUTCHours(fields.hour, fields.minute, fields.second, fields.millisecond);
  const survives =
    rebuilt.getUTCFullYear() === fields.year &&
    rebuilt.getUTCMonth() === fields.month - 1 &&
    rebuilt.getUTCDate() === fields.day &&
    rebuilt.getUTCHours() === fields.hour &&
    rebuilt.getUTCMinutes() === fields.minute &&
    rebuilt.getUTCSeconds() === fields.second;
  return survives ? rebuilt : null;
}

/** One mandatory digit group of a matched timestamp, or a defect report if the pattern lost it. */
export function digitGroup(match: RegExpExecArray, index: number): number {
  const digits = match[index];
  // Every group asked for here is mandatory in its pattern, so an absent one is a defect in the
  // pattern, not malformed input — reported rather than read as zero (ADR-0015).
  if (digits === undefined) throw new Error(`timestamp group ${String(index)} is absent`);
  return Number(digits);
}

/**
 * Whether `text` may be forwarded, as is, to the repository's `::timestamptz` cast.
 *
 * `new Date(text)` is the wrong gate here (round 3 finding 4): it accepts `"1"`, `"2026"`,
 * `"0000-01-01T00:00:00Z"`, `"+275760-09-13T00:00:00.000Z"` and `"2026-02-30T00:00:00Z"`, and
 * PostgreSQL rejects the first four outright and reads the fifth as a different day — so a crafted
 * cursor passed that check, reached the query, and threw out of it as a `500` with the failing SQL
 * in the error log, instead of the `400 invalid_cursor` this route documents. The shape is pinned
 * to {@link KEYSET_TIMESTAMP}, and the calendar fields inside it are checked by
 * {@link instantOfUtcFields}.
 */
export function isKeysetTimestamp(text: string): boolean {
  const match = KEYSET_TIMESTAMP.exec(text);
  if (match === null) return false;
  return (
    instantOfUtcFields({
      year: digitGroup(match, 1),
      month: digitGroup(match, 2),
      day: digitGroup(match, 3),
      hour: digitGroup(match, 4),
      minute: digitGroup(match, 5),
      second: digitGroup(match, 6),
      millisecond: 0,
    }) !== null
  );
}
