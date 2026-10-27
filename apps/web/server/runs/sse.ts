/**
 * The Server-Sent Events wire layer — spec §19 ("Use streaming rather than waiting for the
 * full run. SSE is sufficient unless WebSockets provide a clear benefit"), §34
 * (`GET /api/runs/:id/events`), contract from the R-13 research note.
 *
 * **This module is the pattern.** Spec §19.5 rule 5 requires the home chat to *become* the run
 * view with no second chat implementation, so there is no second SSE implementation either:
 * every later streaming surface imports {@link sseStreamResponse} rather than hand-rolling a
 * `ReadableStream`. Nothing here imports `next/*`; a route handler is a thin adapter over it
 * and the whole layer is unit-testable without a server.
 *
 * Three rules from R-13 that are load-bearing and easy to lose in a later edit:
 *
 *   1. **Exactly three response headers** ({@link SSE_HEADERS}). R-13's fact-check round 1
 *      removed `Content-Encoding: none`, `Connection: keep-alive` and
 *      `X-Content-Type-Options: nosniff` from an earlier draft. Do not add them back.
 *   2. **A mid-run failure must never become a non-200.** The client is already established and
 *      any non-200 kills `EventSource` permanently (R-13 finding 7). Failures travel in-band as
 *      a `run-failed` frame.
 *   3. **Never name a frame `error`.** HTML §9.2 dispatches an event whose type is the `event:`
 *      field, so `event: error` collides with `EventSource`'s own transport-error event and is
 *      swallowed by the client's watchdog (R-13 probed this).
 *
 * And one rule this module learned the hard way, recorded in
 * `docs/adr/W1-CP-04-a-finished-stream-is-not-a-finished-run.md`:
 *
 *   4. **`done` says the stream is over. It says nothing about whether the run succeeded.** The
 *      two are different events and they coincide only on the happy path. {@link SseStreamOptions}
 *      therefore *requires* an {@link SseStreamOptions.outcome} callback: a caller has to state
 *      how the run ended, because the alternative — inheriting "it went fine" by omission — is
 *      what an earlier revision of this file shipped while its own comment claimed otherwise.
 *
 * ADR-0015 runs through the parsers below: every classifier takes `unknown`, parses before it
 * compares, and ends in a total branch that rejects and names what it rejected. A frame that
 * cannot be rendered safely is not rendered "best effort" — it is refused.
 */

import { RUN_WARNING_EVENT } from '@indx-workspace/contracts/run-events';

import { publicRunFailure } from './failures';

/**
 * The response headers, and only these three.
 *
 * Provenance differs per header and R-13 states the difference rather than glossing it; the
 * comments below claim no more than R-13's own provenance table does.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  // Required by HTML §9.2: a Content-Type whose MIME type is not text/event-stream makes the
  // client fail permanently. The `; charset=utf-8` parameter is in NO source R-13 cites — it is
  // redundant (§9.2 decodes event streams as UTF-8 unconditionally) and harmless (§9.2's
  // failure rule compares the MIME type, not its parameters). Kept because it is the exact
  // string R-13's probes sent and observed.
  'Content-Type': 'text/event-stream; charset=utf-8',
  // `no-cache` is MDN's server-side example value. `no-transform` is NOT in any Next.js, nginx
  // or MDN source R-13 cites; it is RFC 9111 §5.2.2.6, and it is a request to intermediaries,
  // not a probed control.
  'Cache-Control': 'no-cache, no-transform',
  // ngx_http_proxy_module: buffering can be disabled by passing "no" in the X-Accel-Buffering
  // response header field. R-13 verified its EFFECT through nginx 1.29.8 (its cases D/E) but
  // could not verify its presence downstream, because nginx does not forward `X-Accel-*` to the
  // client. It is a defence, not the mechanism: the load-bearing control against buffering is
  // keeping `text/event-stream` out of nginx's `gzip_types`, which is configuration.
  'X-Accel-Buffering': 'no',
};

/**
 * Send a keep-alive comment more often than the smallest idle timeout on any hop.
 *
 * nginx `proxy_read_timeout` defaults to 60 s and AWS ALB `idle_timeout` defaults to 60 s (both
 * documented). 15 s is R-13's **inference** for a 4x margin — R-13 probed 1 s (survived 620 s
 * through nginx) and 70 s of silence (killed at ~60 s); 15 s itself was never run there. This
 * repository's own acceptance run (see `acceptance/README.md`) is the first execution of this
 * value, and it is stated as such rather than as a proven optimum.
 */
export const DEFAULT_KEEPALIVE_MS = 15_000;

/** Pin the client's reconnection delay rather than inheriting a user-agent default. */
const DEFAULT_RETRY_MS = 3_000;

/**
 * The largest event id the platform can carry.
 *
 * PostgreSQL `bigint`'s maximum, not a digit count: a 19-digit id passes a digit-count regex and
 * still overflows the column that has to store it. R-13 makes this the explicit upper bound for
 * a client-supplied resume cursor.
 */
export const MAX_EVENT_ID = 9_223_372_036_854_775_807n;

/**
 * The frames {@link sseStreamResponse} writes itself. None of them is ever a durable event and
 * none carries an `id:`, so none of them moves the client's resume cursor.
 *
 *   * `done`         — nothing further will be delivered for this run on this connection or any
 *                      later one; stop, and do not reconnect. It says the stream is over. By
 *                      itself it says NOTHING about whether the run succeeded.
 *   * `run-failed`   — this connection could not deliver a successful run. Its payload is
 *                      `{ status, message }`, where `status` is the run's own terminal status or
 *                      the literal `"unknown"`. Three paths produce it:
 *                        1. the source was exhausted and the run's record reported something
 *                           other than `completed`. The frame is written immediately BEFORE
 *                           `done`, so a client that closes on `done` has already seen it.
 *                        2. the source ended while the final run outcome was indeterminate. The
 *                           frame has `status: "unknown"` and is followed by `done`.
 *                        3. producing the stream threw. The run's outcome is then unknown to this
 *                           connection, `done` is NOT written, and reconnecting with
 *                           `Last-Event-ID` is the right thing for a client to do.
 *                      It is never written for a run whose record read `completed`.
 *   * `stream-reset` — the resume cursor could not be served; what follows is not contiguous
 *                      with what the client already has.
 *   * `error`        — reserved but never emitted. HTML §9.2 would dispatch it into `EventSource`'s
 *                      transport-error listener, where the client's watchdog swallows it.
 */
export const CONTROL_FRAME_NAMES = ['done', 'run-failed', 'stream-reset', 'error'] as const;
type ControlFrameName = (typeof CONTROL_FRAME_NAMES)[number];

/**
 * The platform's own lifecycle event: a durable, replayable event this server appends to a run's
 * log, carrying `{ status, error }`.
 *
 * It is reserved for the same reason a control name is. The argument in
 * `docs/adr/W1-CP-04-event-names-are-validated-at-ingestion.md` is that a name chosen inside a
 * tenant's sandbox must not be able to mean something to another user's browser — and this is
 * the one name the platform itself writes, so a runtime that could relay it would be able to
 * state a run's outcome. It is written through `RunStore.appendPlatformEvent` (`store.ts`), a
 * method the relay is structurally denied (`relay.ts` takes `Pick<RunStore, 'append'>`), and it is
 * rejected by {@link classifyEventName} on every other path.
 */
export const RUN_STATUS_EVENT = 'run.status';

/**
 * The durable event the platform appends when a run start has something to tell the caller
 * (ADR-0146 Decision 3), defined by the contract. Reserved and platform-only exactly like
 * {@link RUN_STATUS_EVENT}.
 */
export { RUN_WARNING_EVENT };

/** Durable event names only this server may write. Total, and checked positively. */
export const PLATFORM_EVENT_NAMES = [RUN_STATUS_EVENT, RUN_WARNING_EVENT] as const;
export type PlatformEventName = (typeof PLATFORM_EVENT_NAMES)[number];

/**
 * Every name a relayed event may not use — the control frames plus the platform's own events.
 *
 * Adding a name here retroactively rejects a runtime that was already emitting it, which is why
 * the ADR calls this list a compatibility surface.
 */
export const RESERVED_EVENT_NAMES = [...CONTROL_FRAME_NAMES, ...PLATFORM_EVENT_NAMES] as const;

const RESERVED: ReadonlySet<string> = new Set(RESERVED_EVENT_NAMES);
const PLATFORM: ReadonlySet<string> = new Set(PLATFORM_EVENT_NAMES);

/**
 * The grammar an `event:` field must satisfy before it is written into a frame.
 *
 * SSE has no escaping: a name containing CR or LF ends the field and everything after it is
 * parsed as a new field or a new frame. An unvalidated name relayed from a sandbox is therefore
 * frame injection, and the client cannot tell the injected frame from a real one. The set below
 * is deliberately narrower than "no newlines" — it is what SDK and platform event types
 * actually look like — because a narrow allowlist rejects the next injection vector too.
 */
const EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** The result of checking one candidate `event:` name. Total: three arms, no fall-through. */
export type EventNameVerdict =
  | { readonly kind: 'ok'; readonly name: string }
  | { readonly kind: 'reserved'; readonly name: string; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/** Name a value in an error message without stringifying something huge or throwing on a cycle. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `the number ${String(value)}`;
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  if (typeof value === 'bigint') return `the bigint ${String(value)}`;
  return `a value of type ${typeof value}`;
}

/**
 * Classify one candidate `event:` name. **Never throws**, and never returns `ok` for a value it
 * did not positively recognise.
 */
export function classifyEventName(input: unknown): EventNameVerdict {
  if (typeof input !== 'string') {
    return { kind: 'rejected', reason: `an event name must be a string; got ${describe(input)}` };
  }
  if (input.length === 0) return { kind: 'rejected', reason: 'an event name must not be empty' };
  if (!EVENT_NAME_PATTERN.test(input)) {
    return {
      kind: 'rejected',
      reason: `the event name ${JSON.stringify(input)} is not /^[A-Za-z][A-Za-z0-9._-]{0,63}$/; SSE has no escaping, so a name outside this grammar can terminate the field and inject a frame`,
    };
  }
  if (RESERVED.has(input)) {
    return {
      kind: 'reserved',
      name: input,
      reason: `the event name ${JSON.stringify(input)} is reserved by the stream protocol (${RESERVED_EVENT_NAMES.join(', ')}) and may not be used by a relayed event`,
    };
  }
  return { kind: 'ok', name: input };
}

/** The result of checking one candidate platform event name. Total: two arms, no fall-through. */
export type PlatformEventNameVerdict =
  | { readonly kind: 'ok'; readonly name: PlatformEventName }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Classify a name the *platform* is trying to write. **Never throws.**
 *
 * This is the positive half of the reservation: {@link classifyEventName} refuses every reserved
 * name on the relay path, and this one admits a name only because it *is* a member of
 * {@link PLATFORM_EVENT_NAMES}. Anything else — a control-frame name, an ordinary SDK type, a
 * non-string — is rejected and named. There is no arm that accepts an unrecognised value.
 */
export function classifyPlatformEventName(input: unknown): PlatformEventNameVerdict {
  if (typeof input !== 'string') {
    return {
      kind: 'rejected',
      reason: `a platform event name must be a string; got ${describe(input)}`,
    };
  }
  if (!PLATFORM.has(input)) {
    return {
      kind: 'rejected',
      reason: `the event name ${JSON.stringify(input)} is not one of the platform's own events (${PLATFORM_EVENT_NAMES.join(', ')}); only those may be written on the platform path`,
    };
  }
  return { kind: 'ok', name: input as PlatformEventName };
}

/** The verdict {@link classifyStoredEventName} returns. Total: two arms, no fall-through. */
export type StoredEventNameVerdict =
  | { readonly kind: 'ok'; readonly name: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Classify a name that is about to be written to the wire as a **durable event**.
 *
 * Two kinds of name may legitimately reach a frame: a relayed SDK type, and one of the
 * platform's own lifecycle events. Both arms are positive — a name is admitted because
 * {@link classifyPlatformEventName} or {@link classifyEventName} recognised it — and every other
 * value, control-frame names included, falls to the rejecting else.
 */
export function classifyStoredEventName(input: unknown): StoredEventNameVerdict {
  const platform = classifyPlatformEventName(input);
  if (platform.kind === 'ok') return { kind: 'ok', name: platform.name };
  const relayed = classifyEventName(input);
  switch (relayed.kind) {
    case 'ok':
      return { kind: 'ok', name: relayed.name };
    case 'reserved':
      return { kind: 'rejected', reason: relayed.reason };
    case 'rejected':
      return { kind: 'rejected', reason: relayed.reason };
    default: {
      const unhandled: never = relayed;
      return { kind: 'rejected', reason: `unclassifiable event name verdict ${String(unhandled)}` };
    }
  }
}

/** The result of checking that a payload can become a `data:` field. Total: two arms. */
export type EventDataVerdict =
  | { readonly kind: 'ok'; readonly json: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Render one payload to the single-line JSON that goes after `data:`.
 *
 * `JSON.stringify` is what guarantees the no-raw-newline rule HTML §9.2 imposes on `data:`. Two
 * ways it does not simply work, both handled rather than hoped away:
 *
 *   * it **throws** on a BigInt and on a cyclic object;
 *   * it **returns `undefined`** — the value, not the string — for `undefined`, a function and a
 *     symbol, which would otherwise be interpolated as the literal text `undefined`.
 */
export function renderEventData(data: unknown): EventDataVerdict {
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch (cause) {
    return {
      kind: 'rejected',
      reason: publicRunFailure(cause, {
        operation: 'serialize-event',
        publicMessage: 'Event data is not JSON-serialisable.',
      }),
    };
  }
  if (typeof json !== 'string') {
    return {
      kind: 'rejected',
      reason: `event data serialised to nothing (${describe(data)} has no JSON representation); send null explicitly if that is what you mean`,
    };
  }
  return { kind: 'ok', json };
}

/** One durable run event as the store holds it: `id` is the row's own monotonic sequence. */
export interface SseEvent {
  /** Monotonic per run, and the cursor the server can seek to. */
  readonly id: bigint;
  /** The `event:` field. Already validated by {@link classifyEventName} before storage. */
  readonly type: string;
  readonly data: unknown;
  /** When the control plane recorded the event. Served as the `at:` field. */
  readonly at?: Date;
}

/**
 * The `id:` grammar: a stored row's sequence, optionally followed by `.` and a sub-index.
 *
 * A sub-index exists because one stored row can serve **several** frames. ENG-03 (#302) made the
 * stream's vocabulary the neutral `agent.*` set, and a `run_events` row recorded before that change
 * holds one Claude Agent SDK message, which the read path upgrades into one *or more* neutral
 * frames (`agent-frames.ts`). The row's sequence cannot be spread across them — it is the
 * primary-key ordering the store replays by — so the frames share it and are told apart by position
 * within the row.
 *
 * Ordering is `(sequence, sub-index)`, lexicographic, and strictly increasing across the whole
 * stream: sequences increase between rows, and within a row the sub-index counts from `0`. A row
 * serves either one bare `<sequence>` frame or a contiguous `<sequence>.0 … <sequence>.n` run,
 * never a mixture, so `Last-Event-ID` resume can name any frame and lose or repeat none.
 *
 * At most three sub-index digits: one engine message cannot become a thousand frames, and a bounded
 * grammar is what keeps `cursor.ts` parsing a client-supplied id without an unbounded integer.
 */
const WIRE_EVENT_ID_PATTERN = /^\d{1,19}(?:\.\d{1,3})?$/;

/**
 * One durable event as it goes on the wire.
 *
 * Separate from {@link SseEvent} because the two ids answer different questions: a store row has a
 * `bigint` sequence, and a frame has a position in the stream, which is that sequence plus a
 * sub-index when its row served more than one frame. Every {@link SseEvent} is a valid
 * {@link SseWireEvent} — the bare-sequence case — so a caller that serves rows one-to-one needs no
 * conversion.
 */
export interface SseWireEvent {
  /** A sequence, or `<sequence>.<sub-index>`. See {@link WIRE_EVENT_ID_PATTERN}. */
  readonly id: bigint | string;
  readonly type: string;
  readonly data: unknown;
  /** The stored row's `at`; every frame a row serves shares it. Absent: the frame has no `at:`. */
  readonly at?: Date;
}

/** A control frame: named, no `id:`, so it never moves the client's resume cursor. */
export interface SseControlFrame {
  readonly name: ControlFrameName;
  readonly data: unknown;
}

/**
 * Render one durable event to a frame.
 *
 * Throws on an invalid name or unserialisable payload rather than emitting a malformed frame.
 * That is deliberate and it is the last line of the defence, not the first: both are rejected at
 * ingestion (see `store.ts`), so a throw here means an invariant was broken upstream, and
 * {@link sseStreamResponse} converts it into a `run-failed` frame rather than a corrupt stream.
 */
export function sseFrame(event: SseWireEvent): string {
  const name = classifyStoredEventName(event.type);
  if (name.kind !== 'ok') {
    throw new Error(`refusing to write an SSE frame: ${name.reason}`);
  }
  const data = renderEventData(event.data);
  if (data.kind !== 'ok') {
    throw new Error(`refusing to write an SSE frame: ${data.reason}`);
  }
  // A bigint is ASCII digits (possibly with a leading '-') by construction. A string id is not, so
  // it is checked against the grammar rather than trusted: HTML §9.2 silently ignores an `id:`
  // containing U+0000, and any other character outside the grammar could terminate the field.
  const id = typeof event.id === 'bigint' ? String(event.id) : event.id;
  if (typeof event.id === 'string' && !WIRE_EVENT_ID_PATTERN.test(id)) {
    throw new Error(
      `refusing to write an SSE frame: the event id ${JSON.stringify(id)} is not ${String(WIRE_EVENT_ID_PATTERN)}`,
    );
  }
  // ISO-8601 UTC has a fixed grammar, so it needs no escaping. `toISOString` throws on an invalid
  // Date, which is the same refusal as for a bad name or payload.
  const at = event.at === undefined ? '' : `at: ${event.at.toISOString()}\n`;
  return `event: ${name.name}\nid: ${id}\n${at}data: ${data.json}\n\n`;
}

/** Render one control frame. Control names are a closed set, so only the payload can fail. */
export function sseControlFrame(frame: SseControlFrame): string {
  const data = renderEventData(frame.data);
  const json = data.kind === 'ok' ? data.json : JSON.stringify({ message: data.reason });
  return `event: ${frame.name}\ndata: ${json}\n\n`;
}

/** A `retry:` frame. HTML §9.2 requires ASCII digits only, so the value is floored and clamped. */
export function sseRetryFrame(retryMs: number): string {
  const ms = Number.isFinite(retryMs) && retryMs > 0 ? Math.floor(retryMs) : DEFAULT_RETRY_MS;
  return `retry: ${String(ms)}\n\n`;
}

/**
 * A comment line. Ignored by the client (HTML §9.2) but real body bytes, which is the whole
 * point: body bytes are what reset a proxy's idle timer.
 */
export function sseComment(text: string): string {
  // A comment ends at the first newline; strip them rather than let one split the frame.
  return `: ${text.replace(/[\r\n]+/g, ' ')}\n\n`;
}

/**
 * How a run ended, as the stream is about to close. Total: three arms, and the silent one is the
 * only one that requires a positive `completed`.
 *
 * This type exists because the end of a *stream* and the end of a *run* are different events, and
 * conflating them is how a failed run gets rendered as a finished one. `done` says the stream is
 * over; this says what happened to the run.
 */
export type StreamOutcome =
  /** The run's record read `completed`. `done` is written and nothing else. */
  | { readonly kind: 'succeeded' }
  /** The run stopped at `awaiting_approval` (ADR-0145): nothing failed, and a decision continues it elsewhere. */
  | { readonly kind: 'paused' }
  /** The run reached a terminal status other than `completed`. `status` is that status. */
  | { readonly kind: 'failed'; readonly status: string; readonly message: string }
  /** The source ended without the run's outcome being knowable. Reported, never assumed good. */
  | { readonly kind: 'indeterminate'; readonly reason: string };

export interface SseStreamOptions {
  /** The durable events to deliver, oldest first, replay and live in one sequence. */
  readonly source: AsyncIterable<SseWireEvent>;
  /**
   * Consulted exactly once, after {@link source} is exhausted and before `done` is written.
   *
   * **Required, deliberately.** A caller that does not state how the run ended cannot silently
   * inherit "it went fine": every streaming surface that copies this module has to answer the
   * question, because the alternative is the default this repository already shipped once — a
   * `done` frame that a client reads as success no matter what happened to the run.
   */
  readonly outcome: () => Promise<StreamOutcome>;
  /** Frames to send once, before the source, after `retry:`. Used for `stream-reset`. */
  readonly prelude?: readonly SseControlFrame[];
  /** The request's abort signal — fires on a real client disconnect. */
  readonly signal: AbortSignal;
  readonly retryMs?: number;
  readonly keepAliveMs?: number;
  /** Called exactly once, from every exit path. Release the source's subscription here. */
  readonly onTeardown?: () => void;
}

/**
 * Build the streaming `Response`. This is the shape R-13's contract summary prescribes, with its
 * reasoning kept next to the code that depends on it.
 */
export function sseStreamResponse(options: SseStreamOptions): Response {
  const encoder = new TextEncoder();
  const keepAliveMs =
    typeof options.keepAliveMs === 'number' && options.keepAliveMs > 0
      ? options.keepAliveMs
      : DEFAULT_KEEPALIVE_MS;

  let keepalive: ReturnType<typeof setInterval> | undefined;
  let torndown = false;
  // Resolved by `pull()` when the client has read enough for the queue to take more, and by
  // teardown, so a producer waiting on a slow client never outlives the stream.
  let drained: (() => void) | null = null;
  const release = (): void => {
    drained?.();
    drained = null;
  };
  // Exactly one teardown path, called from every exit: normal completion, mid-run failure,
  // consumer cancel and client disconnect. R-13 probed that after the producer calls
  // `controller.close()` itself, neither `cancel()` nor the request signal's abort fires — so a
  // close that does not clear the interval leaks one live timer per completed run, forever.
  const teardown = (): void => {
    if (torndown) return;
    torndown = true;
    if (keepalive !== undefined) clearInterval(keepalive);
    release();
    options.onTeardown?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    // `start()` returns promptly. Not because the Response would otherwise fail to be
    // constructed — R-13 retracted that claim — but because `pull()` is never called while
    // `[[started]]` is false, and the interval handle needs to live where `cancel()` can reach
    // it.
    start(controller) {
      const write = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The stream is already closed by another exit path; dropping the write is correct.
        }
      };
      const finish = (): void => {
        teardown();
        try {
          controller.close();
        } catch {
          // Already closed by another exit path.
        }
      };

      write(sseRetryFrame(options.retryMs ?? DEFAULT_RETRY_MS));
      for (const frame of options.prelude ?? []) write(sseControlFrame(frame));

      // Backpressure: read the source only as fast as the client reads the stream, so a replay of
      // a long run is never queued in memory all at once.
      const room = (): Promise<void> =>
        torndown || (controller.desiredSize ?? 1) > 0
          ? Promise.resolve()
          : new Promise((resolve) => {
              drained = resolve;
            });

      void (async () => {
        for await (const event of options.source) {
          await room();
          if (torndown) return;
          write(sseFrame(event));
        }
        // The source is exhausted. Say what happened to the RUN before saying the stream is over,
        // so a client that closes on `done` has already been told.
        const outcome = await options.outcome();
        // A `switch` with a rejecting `default`, not an `if/else if` — an arm added to
        // `StreamOutcome` and not handled here would otherwise fall silently into the one branch
        // that writes nothing, which is the shape of the defect this whole option exists to fix.
        switch (outcome.kind) {
          case 'succeeded':
          case 'paused':
            // The only arms that write no `run-failed`, each reached by positively reporting a
            // completed or a paused run (ADR-0015).
            break;
          case 'failed':
            write(
              sseControlFrame({
                name: 'run-failed',
                data: { status: outcome.status, message: outcome.message },
              }),
            );
            break;
          case 'indeterminate':
            write(
              sseControlFrame({
                name: 'run-failed',
                data: { status: 'unknown', message: outcome.reason },
              }),
            );
            break;
          default: {
            const unhandled: never = outcome;
            void unhandled;
            write(
              sseControlFrame({
                name: 'run-failed',
                data: {
                  status: 'unknown',
                  message: 'The event stream ended in an unknown state.',
                },
              }),
            );
          }
        }
        write(sseControlFrame({ name: 'done', data: {} }));
        finish();
      })().catch((cause: unknown) => {
        // NEVER turn a mid-run failure into a non-200: the client is established and a non-200
        // kills EventSource permanently. NEVER name this frame `error` either — see the module
        // comment. Report the failure explicitly, but never turn an unknown exception into
        // public text.
        //
        // No `done` here: this connection could not determine the run's outcome, so telling the
        // client to stop reconnecting would be a claim this server cannot make. `status` is
        // `unknown` rather than `failed` for the same reason — the run may well still be running.
        const message = publicRunFailure(cause, {
          operation: 'stream-events',
          publicMessage: 'The event stream ended unexpectedly.',
        });
        write(sseControlFrame({ name: 'run-failed', data: { status: 'unknown', message } }));
        finish();
      });

      // Keep-alive comments. Started after the producer so a synchronous failure above does not
      // leave an interval behind for the `catch` to clear.
      keepalive = setInterval(() => write(sseComment('keepalive')), keepAliveMs);
      // Node keeps the process alive for a pending interval; a stream timer must not.
      (keepalive as { unref?: () => void }).unref?.();

      if (options.signal.aborted) finish();
      else options.signal.addEventListener('abort', finish, { once: true });
    },
    pull() {
      release();
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } });
}
