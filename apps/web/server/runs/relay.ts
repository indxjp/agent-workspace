/**
 * The relay — the inbound half of the run stream.
 *
 * Spec §14.3 gives every runtime container the same HTTP contract, and `POST /run` on it
 * "start[s] a run, respond[s] with an SSE stream of SDK events". The control plane consumes that
 * stream, writes each event into the run store, and the outbound half (`sse.ts`) fans it out to
 * every browser watching the run. Nothing is held only in the HTTP connection: R-13 finding 8 and
 * spec §14.6 both say durability must live one hop further in than the connection, and this is the
 * seam where that happens.
 *
 * The parser below is HTML §9.2's "interpreting an event stream", written out rather than taken
 * from a package (§40: this is ~90 lines of clear TypeScript, and it is not cryptography, JWT,
 * OAuth, a database client or a container protocol). It is deliberately the *same* wire format
 * this repository serves, so the frames the control plane writes and the frames it reads are
 * described in one place.
 *
 * ADR-0015 shows up twice here, in both cases as a refusal to continue:
 *
 *   * a runner response that is not a 200 `text/event-stream` is rejected by name — a relay that
 *     opens a stream over an HTML error page produces a run that looks empty rather than broken;
 *   * a frame whose payload is not JSON fails the run rather than being skipped. A skipped frame
 *     is a hole in a transcript that will be rendered as if it were complete, which is exactly the
 *     "unverified capability presented as verified" failure spec §12 and §41 exist to prevent.
 *
 * And once as a narrowing: the relay writes through {@link RelayTarget}, which exposes `append`
 * and not `appendPlatformEvent`, so a runtime's frame cannot become one of the platform's own
 * lifecycle events even if a future edit here forgets why that matters.
 *
 * And once more as three names read rather than relayed: `run-done`, `run-error` and
 * `run-interrupted` — `apps/runner/src/server.ts`'s own terminal frame, see
 * {@link RUNNER_TERMINAL_FRAMES} — are how a run's own outcome reaches this function, and
 * `relayRunnerStream` returns that outcome rather than appending the frame. W1-COMP-01 found this
 * had never worked: the runner's terminal frame used to be named `done` / `run-failed`, both of
 * which `sse.ts` reserves for the control plane's *own* outward control frames, so `store.append`
 * rejected it on every single run — success included — and every run reached the control plane as
 * `failed`, carrying that rejection message instead of the SDK's own outcome. See
 * `docs/adr/W1-COMP-01-the-runners-own-terminal-frame-collided-with-the-relays-reserved-names.md`.
 */
import { RunOutputSchema } from '@indx-workspace/contracts/runs';
import { z } from 'zod';

import type { AppendResult, ApprovalCall, RunOutput, RunStore } from './store';
import { publicRunFailure } from './failures';

/**
 * What the relay is allowed to do to the store: append relayed events, and nothing else.
 *
 * It is `Pick<RunStore, 'append'>` rather than `RunStore` on purpose. `append` refuses every
 * reserved name, `appendPlatformEvent` accepts one of the platform's own — and the relay is the
 * one caller that must never reach the second. Narrowing the parameter makes that a compile
 * error rather than a convention: the method is not on the type the relay can see.
 */
export type RelayTarget = Pick<RunStore, 'append'>;

/** One dispatched message, per HTML §9.2. `event` is null when the frame named no type. */
export interface SseMessage {
  readonly event: string | null;
  readonly data: string;
  readonly lastEventId: string;
}

/**
 * Split a byte stream into lines on CR, LF or CRLF, tolerating a terminator that straddles two
 * chunks. Kept separate from field parsing because "did the chunk boundary land inside a CRLF"
 * is the one part of §9.2 that is easy to get subtly wrong and worth testing on its own.
 */
export class SseLineSplitter {
  #buffer = '';
  /** The previous chunk ended on a CR: a leading LF now belongs to that CRLF, not to a new line. */
  #skipLeadingLf = false;

  push(text: string): string[] {
    let input = text;
    if (this.#skipLeadingLf && input.startsWith('\n')) input = input.slice(1);
    this.#skipLeadingLf = false;
    this.#buffer += input;

    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < this.#buffer.length; i += 1) {
      const c = this.#buffer[i];
      if (c === '\n') {
        lines.push(this.#buffer.slice(start, i));
        start = i + 1;
      } else if (c === '\r') {
        lines.push(this.#buffer.slice(start, i));
        if (this.#buffer[i + 1] === '\n') i += 1;
        else if (i + 1 === this.#buffer.length) this.#skipLeadingLf = true;
        start = i + 1;
      }
    }
    this.#buffer = this.#buffer.slice(start);
    return lines;
  }

  /** Whatever is left when the stream ends. §9.2 discards an unterminated final line. */
  rest(): string {
    return this.#buffer;
  }
}

/** U+0000. Built from a char code so this source file itself contains no NUL byte. */
const NUL = String.fromCharCode(0);

/**
 * Accumulate lines into messages, per HTML §9.2's field rules.
 *
 * Kept as a class rather than a generator so a caller can feed it from any source — the relay
 * feeds it from `fetch`, the acceptance client feeds it from a socket.
 */
export class SseMessageAssembler {
  #event: string | null = null;
  #data: string | null = null;
  #lastEventId = '';

  /** Feed one line. Returns a message when the line terminated a frame, otherwise null. */
  line(line: string): SseMessage | null {
    if (line === '') {
      // Blank line: dispatch. §9.2 dispatches nothing when the data buffer is empty, so a frame
      // that carried only an `id:` moves the cursor without firing an event.
      const data = this.#data;
      const event = this.#event === null || this.#event === '' ? null : this.#event;
      this.#event = null;
      this.#data = null;
      if (data === null) return null;
      return { event, data, lastEventId: this.#lastEventId };
    }
    if (line.startsWith(':')) return null; // comment (the keep-alive)

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.#event = value;
        return null;
      case 'data':
        this.#data = this.#data === null ? value : `${this.#data}\n${value}`;
        return null;
      case 'id':
        // §9.2: an `id` field whose value contains U+0000 is ignored outright.
        if (!value.includes(NUL)) this.#lastEventId = value;
        return null;
      case 'retry':
        // The client's reconnection delay. The relay is not an EventSource and does not reconnect
        // on its own, so this is read and discarded rather than silently treated as data.
        return null;
      default:
        // §9.2: an unknown field name is ignored. Named here so the switch is total.
        return null;
    }
  }
}

/** Parse an SSE response body into messages. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder('utf-8');
  const splitter = new SseLineSplitter();
  const assembler = new SseMessageAssembler();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of splitter.push(decoder.decode(value, { stream: true }))) {
        const message = assembler.line(line);
        if (message) yield message;
      }
    }
    // A final frame terminated by end-of-stream rather than a blank line: §9.2 discards the
    // unterminated line, and so do we. Flushing the decoder first keeps a split multi-byte
    // character from being reported as a decode error.
    decoder.decode();
  } finally {
    // Cancel, not merely release. A consumer that stops early — a malformed frame, a rejected
    // append — must close the runtime's connection rather than leave it streaming into a socket
    // nobody reads. `cancel()` releases the lock too, so this is the whole cleanup.
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed or errored; there is nothing left to cancel.
    }
  }
}

/**
 * Why a relay stopped. Total: exactly one of these is reported for every run.
 *
 * `cancelled` is its own kind, not a shade of `failed` (issue #235, S-14): a `run-interrupted`
 * frame means a user or the platform stopped the run on purpose, which
 * `packages/core/src/db/schema/runs.ts`'s own comment on the `cancelled` status says is not an
 * error. `launcher.ts` concludes the two kinds with different terminal statuses.
 */
export type RelayOutcome =
  | {
      readonly kind: 'completed';
      readonly events: number;
      /** The run's answer (ADR-0143), or `null` when the engine streamed none. */
      readonly output: RunOutput | null;
    }
  | { readonly kind: 'cancelled'; readonly reason: string; readonly events: number }
  /**
   * The engine stopped before a tool call the agent requires approval for (ADR-0145). `call` is
   * what the run stores as pending; `toolCallId` is the engine's id for the call it declined.
   */
  | {
      readonly kind: 'awaiting_approval';
      readonly call: ApprovalCall;
      readonly toolCallId: string;
      readonly events: number;
    }
  | { readonly kind: 'failed'; readonly reason: string; readonly events: number };

const SSE_MIME = 'text/event-stream';

/**
 * The runner's own §14.3 terminal frame names (`apps/runner/src/server.ts`) — connection
 * metadata about how the stream ended, not an SDK event, and never appended to the store as one.
 *
 * They are deliberately **not** `RESERVED_EVENT_NAMES` from `sse.ts` — `done` and `run-failed` —
 * even though they mean almost the same thing. Those names are reserved for the control plane's
 * *own* outward control frames to a browser; a runner that sent them would have every terminal
 * frame rejected by `store.append` before this function could read what it meant, and it did:
 * see `docs/adr/W1-COMP-01-the-runners-own-terminal-frame-collided-with-the-relays-reserved-names.md`
 * for the transcript. `launcher.ts` already writes the platform's own durable `run.status` event
 * from whatever this function returns, so relaying the runner's frame *as well* would put a
 * second, differently-shaped opinion about the same outcome into the log — it is read here and
 * consumed, not forwarded.
 */
const RUNNER_TERMINAL_FRAMES = new Set(['run-done', 'run-error', 'run-interrupted']);

/**
 * What the run answered, read from its frames as they pass (ADR-0143): the `output` of the last
 * `agent.result` that carries one, else the text of the last assistant message with text.
 */
class OutputTracker {
  #fromResult: RunOutput | null = null;
  #lastText: string | null = null;

  observe(type: string, data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const frame = data as Record<string, unknown>;
    if (type === 'agent.result') {
      const parsed = RunOutputSchema.safeParse(frame['output']);
      if (parsed.success) this.#fromResult = parsed.data;
    } else if (type === 'agent.message' && frame['role'] === 'assistant') {
      const blocks = Array.isArray(frame['blocks']) ? (frame['blocks'] as unknown[]) : [];
      const text = blocks
        .flatMap((block) => {
          const b = block as { type?: unknown; text?: unknown } | null;
          return b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [];
        })
        .join('');
      if (text.length > 0) this.#lastText = text;
    }
  }

  output(): RunOutput | null {
    if (this.#fromResult !== null) return this.#fromResult;
    return this.#lastText === null ? null : { text: this.#lastText, structured: null };
  }
}

const RunnerApprovalRequestSchema = z.object({
  toolName: z.string().min(1),
  canonicalCall: z.string().min(1),
  toolUseId: z.string().min(1),
});

/**
 * The call a runner `run-error` frame stopped on for want of approval, `'malformed'` when it
 * claims to have stopped for approval without a usable request, and `null` for any other failure.
 */
function approvalOf(
  data: unknown,
): { readonly call: ApprovalCall; readonly toolCallId: string } | 'malformed' | null {
  if (typeof data !== 'object' || data === null) return null;
  const frame = data as Record<string, unknown>;
  if (frame['code'] !== 'awaiting_approval') return null;
  const request = RunnerApprovalRequestSchema.safeParse(frame['approvalRequest']);
  if (!request.success) return 'malformed';
  const { toolName, canonicalCall, toolUseId } = request.data;
  return { call: { toolName, canonicalCall }, toolCallId: toolUseId };
}

/** The `message` field of a runner terminal frame's summary object, if it has a usable one. */
function terminalFailureMessage(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as { message?: unknown }).message;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Decide whether a runner response may be relayed at all.
 *
 * A positive assertion, per ADR-0015: the response is relayable because it *is* a 200 whose
 * Content-Type *is* `text/event-stream` and which *has* a body — never because nothing about it
 * looked wrong.
 */
export function classifyRunnerResponse(
  response: Response,
):
  | { readonly kind: 'ok'; readonly body: ReadableStream<Uint8Array> }
  | { readonly kind: 'rejected'; readonly reason: string } {
  if (response.status !== 200) {
    return {
      kind: 'rejected',
      reason: `the runtime returned HTTP ${String(response.status)}; §14.3 requires 200 with an SSE stream from POST /run`,
    };
  }
  const contentType = response.headers.get('content-type');
  if (contentType === null) {
    return { kind: 'rejected', reason: 'the runtime response carried no Content-Type' };
  }
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mime !== SSE_MIME) {
    return {
      kind: 'rejected',
      reason: `the runtime response did not use ${SSE_MIME}`,
    };
  }
  if (response.body === null) {
    return { kind: 'rejected', reason: 'the runtime response had no body to relay' };
  }
  return { kind: 'ok', body: response.body };
}

/**
 * Relay one runner SSE stream into the run store.
 *
 * Returns rather than throws: the caller writes the outcome onto the run record, and a relay that
 * threw past its caller would leave a run stuck at `running` forever.
 */
export async function relayRunnerStream(
  runId: string,
  response: Response,
  store: RelayTarget,
  onSessionIdentified?: (sessionId: string) => Promise<void>,
): Promise<RelayOutcome> {
  const classified = classifyRunnerResponse(response);
  if (classified.kind !== 'ok') {
    return { kind: 'failed', reason: classified.reason, events: 0 };
  }
  let events = 0;
  const answer = new OutputTracker();
  try {
    for await (const message of parseSseStream(classified.body)) {
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch (cause) {
        return {
          kind: 'failed',
          reason: publicRunFailure(cause, {
            operation: 'parse-runtime-event',
            failureKind: 'upstream',
            publicMessage:
              'The runtime sent an invalid event, so the run was stopped to protect the transcript.',
          }),
          events,
        };
      }
      // §14.3 says the runtime streams "SDK events". A frame that names no type is not one, and
      // guessing a name for it is how an unrecognised event becomes an invisible one.
      const type = message.event;
      if (type === null) {
        return {
          kind: 'failed',
          reason:
            'the runtime sent an SSE frame with no `event:` name; §14.3 streams named SDK events',
          events,
        };
      }
      if (RUNNER_TERMINAL_FRAMES.has(type)) {
        if (typeof data === 'object' && data !== null) {
          const sessionId = (data as Record<string, unknown>)['sessionId'];
          if (typeof sessionId === 'string' && sessionId.length > 0) {
            await onSessionIdentified?.(sessionId);
          }
        }
        if (type === 'run-done') return { kind: 'completed', events, output: answer.output() };
        if (type === 'run-interrupted') {
          return {
            kind: 'cancelled',
            reason: terminalFailureMessage(data) ?? 'the run was interrupted',
            events,
          };
        }
        const approval = approvalOf(data);
        if (approval === 'malformed') {
          return {
            kind: 'failed',
            reason: 'the runtime stopped for approval without a usable approval request',
            events,
          };
        }
        if (approval !== null) return { kind: 'awaiting_approval', ...approval, events };
        const reason =
          terminalFailureMessage(data) ?? 'the runtime reported a run failure with no message';
        return { kind: 'failed', reason, events };
      }

      answer.observe(type, data);
      const appended: AppendResult = await store.append(runId, { type, data });
      if (appended.kind !== 'appended') {
        return {
          kind: 'failed',
          reason: publicRunFailure(appended.reason, {
            operation: 'append-runtime-event',
            publicMessage: 'Run output could not be saved.',
          }),
          events,
        };
      }
      events += 1;
    }
  } catch (cause) {
    return {
      kind: 'failed',
      reason: publicRunFailure(cause, {
        operation: 'relay-runtime-stream',
        failureKind: 'upstream',
        publicMessage: 'The runtime stream ended unexpectedly.',
      }),
      events,
    };
  }
  return {
    kind: 'failed',
    reason:
      'the runtime SSE stream ended without a terminal run-done, run-error, or run-interrupted frame',
    events,
  };
}
