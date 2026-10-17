/**
 * The consumer side of the platform's `text/event-stream` wire format, written out rather than
 * delegated to `EventSource`.
 *
 * `EventSource` does not fit the contract: every frame the platform writes carries an explicit
 * `event:` name, `EventSource.onmessage` fires only for a frame with *no* name (WHATWG HTML §9.2),
 * and there is no wildcard listener — a caller would have to `addEventListener` each name in
 * advance, and relayed runtime event names are open-ended. Reading the body as a stream and
 * parsing the small, already-specified format by hand is the only way to see a name this module
 * did not already know about. It also lets a request carry `Authorization`, which `EventSource`
 * cannot.
 */

/** One parsed SSE frame: the `event:` name, its `id:` when the server sent one, and its payload. */
export interface SseFrame {
  readonly event: string;
  /** `null` for every control frame — the platform never gives one an `id:`, because none of
   *  them may move a client's resume cursor. */
  readonly id: string | null;
  /** The `at:` field: when the control plane recorded a durable event, as the server wrote it.
   *  Absent on control frames and on servers that predate the field; {@link classifyRunEventFrame}
   *  validates it. */
  readonly at?: string;
  /** The `data:` field(s), joined and JSON-parsed. Kept as the raw joined string when it does not
   *  parse — the platform only promises JSON for the frames it writes itself, and a frame this
   *  parser cannot make sense of is still worth surfacing verbatim rather than dropping silently. */
  readonly data: unknown;
}

/**
 * Parse one frame's raw text (already split on the blank-line boundary) into `{ event, id, at?, data }`,
 * or `null` for a frame with no `event:` field.
 *
 * The platform never sends an unnamed frame, so `null` here means text this parser could not read
 * as this wire format at all, and the caller drops it rather than guessing a name for it.
 */
export function parseSseFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  let id: string | null = null;
  let at: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of raw.split('\n')) {
    if (rawLine === '' || rawLine.startsWith(':')) continue; // a blank remainder, or a comment
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /u, '');
    switch (field) {
      case 'event':
        event = value;
        break;
      case 'id':
        id = value;
        break;
      case 'at':
        at = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      default:
        // `retry:`, and anything else. Not an error: this consumer is not required to obey every
        // field the server is entitled to send to stay correct about the ones it does read.
        break;
    }
  }

  if (event === null) return null;
  const joined = dataLines.join('\n');
  const stamp = at === undefined ? {} : { at };
  if (joined === '') return { event, id, ...stamp, data: null };
  try {
    return { event, id, ...stamp, data: JSON.parse(joined) as unknown };
  } catch {
    return { event, id, ...stamp, data: joined };
  }
}

/** Normalise and split a buffer, optionally treating a trailing CR as a complete line ending. */
function splitBuffer(
  buffer: string,
  final: boolean,
): {
  readonly frames: readonly string[];
  readonly rest: string;
} {
  const trailingCr = !final && buffer.endsWith('\r');
  const stable = trailingCr ? buffer.slice(0, -1) : buffer;
  const normalised = stable.replace(/\r\n?|\n/gu, '\n');
  const parts = normalised.split('\n\n');
  const rest = (parts.pop() ?? '') + (trailingCr ? '\r' : '');
  return { frames: parts, rest };
}

/**
 * Split a growing buffer on the blank-line frame boundary HTML §9.2 defines. A trailing CR stays
 * in the remainder until the next chunk tells us whether it belongs to CRLF or stands alone.
 */
export function splitSseFrames(buffer: string): {
  readonly frames: readonly string[];
  readonly rest: string;
} {
  return splitBuffer(buffer, false);
}

/**
 * Read a response body as a sequence of parsed frames until the body ends or `signal` aborts.
 * Frames with no `event:` name are dropped, as {@link parseSseFrame} documents.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let exhausted = false;
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  // An already-aborted signal never fires `abort`, so it is honoured here instead.
  if (signal?.aborted === true) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const split = splitSseFrames(buffer);
      buffer = split.rest;
      for (const raw of split.frames) {
        const frame = parseSseFrame(raw);
        if (frame !== null) yield frame;
      }
    }
    // A final CR is a complete line ending once the body has ended. It may be the blank line
    // that completes the last frame; an otherwise incomplete frame remains un-dispatched.
    if (signal?.aborted !== true) {
      const finalSplit = splitBuffer(buffer + decoder.decode(), true);
      for (const raw of finalSplit.frames) {
        const frame = parseSseFrame(raw);
        if (frame !== null) yield frame;
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    // A consumer that stops iterating early must not leave the connection open behind it.
    if (!exhausted) {
      try {
        await reader.cancel();
      } catch {
        // The body is being abandoned either way.
      }
    }
    reader.releaseLock();
  }
}
