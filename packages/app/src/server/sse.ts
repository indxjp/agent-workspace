/**
 * The app kit's one Server-Sent Events writer (issues #1509 and #1518): the agent panel's stream
 * and every `channel()` stream are written through it, so the platform's rules are restated once.
 * The app kit cannot import the platform's SSE module, so they are restated here, not shared:
 *
 *   1. **Exactly three response headers** ({@link SSE_HEADERS}): `Content-Type`,
 *      `Cache-Control` and `X-Accel-Buffering`. Nothing else is added.
 *   2. **A failure after the stream began never becomes a non-200.** It travels in-band, or the
 *      stream closes and the client resumes with `Last-Event-ID`.
 *   3. **No frame is named `error`**: it collides with `EventSource`'s own transport-error event.
 *      A name outside the platform's event-name grammar is not written at all.
 *   4. **`done` says the stream is over, never that the work succeeded.** Each stream decides
 *      when, if ever, to write it.
 *
 * Every stream starts with a `retry:` frame and sends a keep-alive comment every 15 s.
 */

/** The three response headers of a stream, and only these (rule 1). */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
});

/** The platform's event-name grammar: SSE has no escaping, so nothing else is written (rule 3). */
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
/** The platform's wire event ids: a sequence, or `<sequence>.<sub-index>`. */
export const WIRE_EVENT_ID = /^\d{1,19}(?:\.\d{1,3})?$/u;
/** Comfortably inside the 60 s idle timeout of nginx and of a load balancer. */
export const KEEPALIVE_MS = 15_000;
/** The reconnection time a stream asks a client for. */
export const RETRY_MS = 3_000;

/** Whether `name` may name a frame: the event-name grammar, and never `error` (rule 3). */
export function isWritableEventName(name: string): boolean {
  return EVENT_NAME.test(name) && name !== 'error';
}

/**
 * A `retry:` frame. HTML §9.2 reads ASCII digits only, so the value is floored, and anything that
 * is not a positive number becomes {@link RETRY_MS}.
 */
export function sseRetryFrame(retryMs: number = RETRY_MS): string {
  const ms = Number.isFinite(retryMs) && retryMs > 0 ? Math.floor(retryMs) : RETRY_MS;
  return `retry: ${String(ms)}\n\n`;
}

/** The keep-alive comment: ignored by a client, but body bytes that reset a proxy's idle timer. */
export const SSE_KEEPALIVE = ': keepalive\n\n';

/** A control frame: no `id:`, so it never moves a client's resume cursor. */
export function sseControlFrame(name: 'done' | 'run-failed' | 'stream-reset', data: unknown) {
  return `event: ${name}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

/**
 * A named frame with its `id:` (when it is a wire event id) and `at:` (when given), or `null` for
 * a name that may not be written (rule 3).
 */
export function sseEventFrame(
  name: string,
  id: string | null,
  at: string | undefined,
  data: unknown,
): string | null {
  if (!isWritableEventName(name)) return null;
  const idLine = id !== null && WIRE_EVENT_ID.test(id) ? `id: ${id}\n` : '';
  const atLine = at === undefined ? '' : `at: ${at}\n`;
  // `JSON.stringify` escapes every line break, so the payload stays on its one `data:` line.
  return `event: ${name}\n${idLine}${atLine}data: ${JSON.stringify(data ?? null)}\n\n`;
}

/** What a stream's producer writes through. */
export interface SseWriter {
  /** Writes `chunk`; nothing once the stream closed. */
  write(chunk: string): void;
  /** Whether the client went away or the stream finished. */
  readonly closed: boolean;
}

/** What {@link sseResponse} runs besides the producer. */
export interface SseResponseOptions {
  /** Writes what a producer's failure says in-band (rule 2), then the stream closes. */
  readonly onFailure?: (writer: SseWriter) => void;
  /** Called once when the client goes away. */
  readonly onCancel: () => void;
}

/**
 * The streaming answer `produce` writes: `retry:` first, a keep-alive comment every 15 s, and the
 * end of the body once `produce` settles. A failure of `produce` is written by `onFailure`, never
 * with the failure's own words, and never as a non-200 (rule 2).
 */
export function sseResponse(
  produce: (writer: SseWriter) => Promise<void>,
  options: SseResponseOptions,
): Response {
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stop = (): void => {
    closed = true;
    if (keepalive !== undefined) clearInterval(keepalive);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const writer: SseWriter = {
        write(chunk) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // Already closed by another exit path.
          }
        },
        get closed() {
          return closed;
        },
      };
      const finish = (): void => {
        if (closed) return;
        stop();
        // `closed` is set by every other exit path (`cancel`), so the stream is still open here.
        controller.close();
      };
      writer.write(sseRetryFrame());
      void produce(writer)
        .then(finish)
        .catch(() => {
          options.onFailure?.(writer);
          finish();
        });
      keepalive = setInterval(() => writer.write(SSE_KEEPALIVE), KEEPALIVE_MS);
      (keepalive as { unref?: () => void }).unref?.();
    },
    cancel() {
      stop();
      options.onCancel();
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
