/**
 * W3C Trace Context `traceparent` (https://www.w3.org/TR/trace-context/#traceparent-header).
 *
 * The header arrives from a caller we do not trust, so it is parsed strictly: lowercase hex only,
 * no all-zero ids, no version `ff`, and a version-00 header has exactly four fields. Anything else
 * is `null`, and a caller treats `null` as "no trace context" — it never echoes the raw input.
 */
export interface TraceContext {
  readonly traceId: string;
  readonly parentId: string;
  readonly flags: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/u;
// A future version may append fields; nothing legitimate is anywhere near this long.
const MAX_TRACEPARENT_LENGTH = 512;
const ALL_ZERO = /^0+$/u;

export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (typeof header !== 'string' || header.length > MAX_TRACEPARENT_LENGTH) return null;
  const [, version, traceId, parentId, flags, rest] = TRACEPARENT.exec(header.trim()) ?? [];
  if (version === undefined || traceId === undefined || parentId === undefined) return null;
  if (flags === undefined || version === 'ff') return null;
  if (version === '00' && rest !== undefined) return null;
  if (ALL_ZERO.test(traceId) || ALL_ZERO.test(parentId)) return null;
  return { traceId, parentId, flags };
}

// W3C caps `tracestate` at 32 members of 256 characters, but nothing this platform forwards needs
// more than 512. Printable ASCII only: no CR/LF that could split a header or a log line.
// ponytail: bounded-charset check, not the full list-member grammar; tighten if a vendor needs it.
const TRACESTATE = /^[\x20-\x7e]{1,512}$/u;

/**
 * The `traceparent` (and `tracestate`) to forward downstream, or `{}` when the incoming
 * `traceparent` is not valid. The `traceparent` is rebuilt from its parsed fields as version 00,
 * so no caller byte beyond the validated ids is forwarded; a `tracestate` is dropped with an
 * invalid `traceparent`, as the specification requires.
 */
export function traceHeaders(
  traceparent: string | null | undefined,
  tracestate?: string | null,
): Readonly<Record<string, string>> {
  const trace = parseTraceparent(traceparent);
  if (trace === null) return {};
  const forwarded = { traceparent: `00-${trace.traceId}-${trace.parentId}-${trace.flags}` };
  return typeof tracestate === 'string' && TRACESTATE.test(tracestate)
    ? { ...forwarded, tracestate }
    : forwarded;
}
