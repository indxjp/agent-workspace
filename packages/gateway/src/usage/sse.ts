/**
 * An incremental `text/event-stream` reader that keeps only the line it is currently assembling.
 *
 * This replaces the `await response.text()` the gateway's capture branch used to do. It matters
 * most for the Responses API, whose terminal `response.completed` frame repeats the model's entire
 * output: buffering it would make the gateway's memory scale with the completion it just streamed
 * (ADR-0068's constraint 3).
 */

const DATA_PREFIX = 'data:';
/** OpenAI closes both dialects with a sentinel that is not JSON. */
const STREAM_DONE = '[DONE]';

/** Strip the SSE framing from one line and hand back its payload, or `null` if it carries none. */
function payloadOf(line: string): string | null {
  const withoutCarriageReturn = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!withoutCarriageReturn.startsWith(DATA_PREFIX)) return null;
  const payload = withoutCarriageReturn.slice(DATA_PREFIX.length).trim();
  if (payload.length === 0 || payload === STREAM_DONE) return null;
  return payload;
}

/**
 * Feed every `data:` payload in `body` to `onPayload`, in order, as it arrives.
 *
 * A stream that stops mid-flight still delivers every complete payload before the cut, and its
 * trailing partial line is delivered only when it parses — an interrupted stream must never make
 * the extractor invent a frame.
 */
export async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  onPayload: (payload: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  const flushLines = (final: boolean): void => {
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline === -1) break;
      const payload = payloadOf(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (payload !== null) onPayload(payload);
    }
    // A provider that ends its last frame without a newline — or a stream cut mid-frame — leaves
    // one line here. It is offered once, at the end, and discarded if it does not parse.
    if (final && pending.length > 0) {
      const payload = payloadOf(pending);
      pending = '';
      if (payload !== null) onPayload(payload);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) pending += decoder.decode(value, { stream: true });
      flushLines(false);
    }
    pending += decoder.decode();
    flushLines(true);
  } finally {
    reader.releaseLock();
  }
}
