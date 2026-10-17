import { z } from 'zod';

import { EngineIdSchema } from './engines.js';
import { RUN_STATUSES } from './runs.js';

/**
 * The vocabulary of `GET /api/runs/:id/events` — a `text/event-stream` in which every frame
 * carries an `event:` name. Three kinds of frame arrive, and a client tells them apart by name:
 *
 *   1. **Control frames** ({@link CONTROL_FRAME_NAMES}) written by the stream itself. They carry
 *      no `id:` and never move the resume cursor.
 *   2. **The platform's lifecycle event** ({@link RUN_STATUS_EVENT}), a durable, replayable event
 *      the control plane appends when a run changes status.
 *   3. **Neutral agent frames** ({@link AGENT_FRAME_NAMES}) — one engine-neutral vocabulary,
 *      produced once by the engine's adapter in the runner (ADR-0065 D5) and read unchanged by
 *      the UI, the SDK, `aw` and webhooks. Every frame names its `engine` and carries the
 *      engine-native message in `raw`.
 *
 * Durable events (kinds 2 and 3) carry a monotonic `id:`. A client resumes by sending it back as
 * the `Last-Event-ID` request header (or the `after` query parameter); the server answers a
 * cursor it can no longer serve with a `stream-reset` frame rather than a silent restart.
 *
 * {@link RELAYED_EVENT_NAMES} is the vocabulary this stream used before ENG-03 (#302). Rows
 * recorded under those names are still in `run_events` and are **upgraded on read**, so a client
 * only ever sees kind 3. Nothing writes them any more.
 */

/**
 * Frames the stream writes about itself. `done` means nothing further will be delivered on this
 * or any later connection — and says nothing about whether the run succeeded; `run-failed` is the
 * frame that does. `error` is reserved and never emitted: HTML §9.2 would dispatch it into
 * `EventSource`'s transport-error listener.
 */
export const CONTROL_FRAME_NAMES = ['done', 'run-failed', 'stream-reset'] as const;
export type ControlFrameName = (typeof CONTROL_FRAME_NAMES)[number];

/** The durable event the platform appends on every run status change. */
export const RUN_STATUS_EVENT = 'run.status';

/**
 * The `event:` names the runner relayed **before ENG-03 (#302)**: its *classification* of one
 * Claude Agent SDK message, with the SDK's own `type` and `subtype` inside `data`.
 *
 * They are kept, and kept in this order, for one reason: `run_events` rows written before the
 * change still carry them, and the event-read path recognises a row by its name in order to
 * upgrade it to an {@link AGENT_FRAME_NAMES} frame. No writer produces them any more — a runtime
 * that sent one today would be relaying a vocabulary no consumer reads.
 */
export const RELAYED_EVENT_NAMES = [
  'system',
  'system-unknown',
  'result',
  'result-unknown',
  'sdk-event',
  'unknown',
  'malformed',
] as const;
export type RelayedEventName = (typeof RELAYED_EVENT_NAMES)[number];

/** The grammar every `event:` name must satisfy; SSE has no escaping, so the set is narrow. */
export const EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** `data` of a {@link RUN_STATUS_EVENT} frame. */
export const RunStatusEventDataSchema = z
  .object({
    status: z.enum(RUN_STATUSES),
    /** The safe public failure text, or `null`. */
    error: z.string().nullable(),
  })
  .strict()
  .readonly();

export type RunStatusEventData = z.infer<typeof RunStatusEventDataSchema>;

/**
 * `data` of a `run-failed` frame. `status` is the run's own terminal status, or `"unknown"` when
 * producing the stream threw and the run's outcome is unknown to this connection — reconnecting
 * with `Last-Event-ID` is then the right thing to do.
 */
export const RunFailedFrameDataSchema = z
  .object({
    status: z.union([z.enum(RUN_STATUSES), z.literal('unknown')]),
    message: z.string(),
  })
  .strict()
  .readonly();

export type RunFailedFrameData = z.infer<typeof RunFailedFrameDataSchema>;

/** `data` of a `stream-reset` frame: what follows is not contiguous with what the client has. */
export const StreamResetFrameDataSchema = z
  .object({
    reason: z.string(),
    /** The oldest id the stream can actually start after, or `null` when nothing is retained. */
    resumedAfter: z.string().nullable(),
  })
  .strict()
  .readonly();

export type StreamResetFrameData = z.infer<typeof StreamResetFrameDataSchema>;

/**
 * `data` of a relayed runtime event: the runner's classification envelope. `kind` is always
 * present; the rest is the SDK's own message and is passed through unvalidated because the SDK's
 * type union grows in patch releases — a consumer narrows the parts it reads.
 *
 * Only the legacy read path (see {@link RELAYED_EVENT_NAMES}) still meets this shape.
 */
export const RelayedEventDataSchema = z.looseObject({ kind: z.string().min(1) }).readonly();

export type RelayedEventData = z.infer<typeof RelayedEventDataSchema>;

// ── The neutral agent frames (ENG-03, #302) ─────────────────────────────────────────────

/**
 * The closed set of neutral `event:` names a run stream carries.
 *
 * **Closed, and closed on purpose.** ADR-0065 D5 puts normalisation in the engine's adapter so
 * that every consumer reads one vocabulary instead of re-deriving one engine's classification;
 * an adapter that meets something this set cannot express emits {@link AgentNativeFrameSchema}
 * rather than inventing a name, so the set grows by an amendment to this file and never by a
 * runtime deciding to send something new.
 *
 * The order is the wire order and is not re-sorted:
 * `formal/AgentWorkspace/Events/AgentFrames.lean` transcribes it position by position.
 */
export const AGENT_FRAME_NAMES = [
  'agent.session',
  'agent.message',
  'agent.message.delta',
  'agent.tool.call',
  'agent.tool.result',
  'agent.usage',
  'agent.result',
  'agent.native',
  'agent.malformed',
] as const;
export type AgentFrameName = (typeof AGENT_FRAME_NAMES)[number];

/**
 * What a tool call *does*, as a closed set.
 *
 * Borrowed verbatim from the Agent Client Protocol's tool-call kinds
 * (https://agentclientprotocol.com/protocol/tool-calls) so that ENG-11's generic ACP adapter maps
 * one-to-one instead of translating twice. `other` is the honest answer for a tool whose effect an
 * adapter cannot name — never a default that hides an unmapped `execute`.
 */
export const AGENT_TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
  'mcp',
  'other',
] as const;
export type AgentToolKind = (typeof AGENT_TOOL_KINDS)[number];
export const AgentToolKindSchema = z.enum(AGENT_TOOL_KINDS);

/**
 * Why a turn ended, as a closed set, aligned with ACP's prompt-turn stop reasons
 * (https://agentclientprotocol.com/protocol/prompt-turn).
 *
 * `max_budget` and `cancelled` are the platform's own words for two of them: a run stopped by a
 * spend cap is not the same event as a run the model chose to end, and a run a user interrupted is
 * not a failure (`packages/core/src/db/schema/runs.ts` says so of the `cancelled` status).
 */
export const AGENT_STOP_REASONS = [
  'end_turn',
  'max_turns',
  'max_budget',
  'refusal',
  'cancelled',
  'error',
] as const;
export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];
export const AgentStopReasonSchema = z.enum(AGENT_STOP_REASONS);

/**
 * The largest engine-native payload one frame's `raw` may carry, in UTF-8 bytes.
 *
 * `raw` exists so that nothing an engine said is lost, which makes it the one field whose size a
 * tenant's agent controls: a tool result holding a 40 MB file would otherwise be written into
 * `run_events`, replayed to every follower, and held in a browser's transcript. The cap is
 * therefore enforced where the frame is produced, and a payload over it is **truncated with a
 * marker, never rejected** — dropping the frame would lose the neutral fields too, which are the
 * part a consumer renders.
 *
 * 64 KiB is chosen against the frames this stream actually carries: the largest Claude Agent SDK
 * `result` message observed in R-01's probes is a few kilobytes, so the cap bites only on tool
 * output, which is exactly the payload a client should be fetching from the file it names rather
 * than reading out of an event log.
 *
 * The cap is per frame, and every frame derived from one engine message carries that message: a
 * message that fans out into _n_ frames stores up to _n_ capped copies. That is deliberate — each
 * frame is readable on its own — and `docs/sdk/04-api-specification.md` §6.3 states the cost.
 */
export const AGENT_FRAME_RAW_MAX_BYTES = 65_536;

/**
 * What `raw` becomes when the engine-native payload did not fit under
 * {@link AGENT_FRAME_RAW_MAX_BYTES}, or could not be serialised at all.
 *
 * A marker object rather than a truncated string: a consumer must be able to tell "this is the
 * engine's payload" from "this is what is left of it" by a positive check, and a clipped JSON
 * fragment answers neither question. `encodedBytes` is the size that did not fit, or `null` when
 * the payload had no JSON representation to measure.
 *
 * The producer side — the function that applies the cap — is the control plane's
 * `capAgentFrameRaw` (in `packages/core`), next to the mapping that builds the frame. This contract
 * is what a *consumer* needs: the limit, and the shape to recognise when it was reached.
 */
export const AgentFrameRawTruncationSchema = z
  .object({
    truncated: z.literal(true),
    encodedBytes: z.number().int().nonnegative().nullable(),
    limitBytes: z.number().int().positive(),
  })
  .strict()
  .readonly();
export type AgentFrameRawTruncation = z.infer<typeof AgentFrameRawTruncationSchema>;

/**
 * Whether a frame's `raw` is the truncation marker rather than the engine's payload.
 *
 * A positive check on the marker's own shape, not a guess from a missing field: a payload that
 * happens to carry a `truncated` key of its own is not this marker unless it matches the whole
 * schema, and a consumer branching on it is deciding from what is there.
 */
export function isAgentFrameRawTruncated(raw: unknown): raw is AgentFrameRawTruncation {
  return AgentFrameRawTruncationSchema.safeParse(raw).success;
}

/**
 * The fields every neutral frame carries.
 *
 * `frame` repeats the SSE `event:` name inside `data` so that the payload is self-describing once
 * it has left the stream — a webhook body, a stored row and a log line all keep their discriminant
 * — and so {@link AgentFrameSchema} can be a discriminated union rather than a guess. A parser
 * checks the two agree; they are written by one function and never separately.
 *
 * `engine` is the engine that produced the frame, not the engine the run was *configured* with:
 * they are the same today and a resumed session pinned to another engine is refused before a run
 * exists (ADR-0065 D8), but a consumer reads what produced the event.
 */
const agentFrameBase = {
  engine: EngineIdSchema,
  /**
   * The engine-native message, verbatim, capped by {@link capAgentFrameRaw}. Typed `unknown`
   * deliberately: it is another vendor's shape and this contract makes no promise about it.
   */
  raw: z.unknown(),
};

/**
 * `agent.session` — the engine opened or resumed its own session for this run.
 *
 * `engineSessionId` is the id the engine will accept back to continue the conversation; it is what
 * `sessions.engine_session_id` stores. `model` is the model the engine reports it is about to use,
 * or `null` when it names none — never the model the platform asked for, which the run row already
 * records.
 */
export const AgentSessionFrameSchema = z
  .object({
    frame: z.literal('agent.session'),
    ...agentFrameBase,
    engineSessionId: z.string().min(1),
    model: z.string().min(1).nullable(),
  })
  .strict()
  .readonly();
export type AgentSessionFrame = z.infer<typeof AgentSessionFrameSchema>;

/** One block of a message: what the model said, or what it thought before saying it. */
export const AgentMessageBlockSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
  ])
  .readonly();
export type AgentMessageBlock = z.infer<typeof AgentMessageBlockSchema>;

/**
 * `agent.message` — one whole turn's prose.
 *
 * Tool use is **not** a block here: it is its own frame, so a consumer renders a tool call without
 * having to walk a message's content. `messageId` is the engine's own id for the turn and is
 * `null` when the engine gave it none; when it is non-null a later frame repeating it is the same
 * turn grown, which is what lets a transcript replace instead of appending.
 */
export const AgentMessageFrameSchema = z
  .object({
    frame: z.literal('agent.message'),
    ...agentFrameBase,
    messageId: z.string().min(1).nullable(),
    role: z.enum(['assistant', 'user']),
    blocks: z.array(AgentMessageBlockSchema).readonly(),
  })
  .strict()
  .readonly();
export type AgentMessageFrame = z.infer<typeof AgentMessageFrameSchema>;

/**
 * `agent.message.delta` — one increment of a message being streamed.
 *
 * Emitted only by an engine whose `capabilities.streamingText` is `true` (`./engines.ts`). A consumer
 * that ignores deltas still renders a complete transcript from `agent.message` alone: a delta is
 * an early view of a turn, never the only view of it.
 */
export const AgentMessageDeltaFrameSchema = z
  .object({
    frame: z.literal('agent.message.delta'),
    ...agentFrameBase,
    messageId: z.string().min(1).nullable(),
    block: z.enum(['text', 'reasoning']),
    text: z.string(),
  })
  .strict()
  .readonly();
export type AgentMessageDeltaFrame = z.infer<typeof AgentMessageDeltaFrameSchema>;

/**
 * `agent.tool.call` — the engine invoked a tool.
 *
 * `toolCallId` is what the matching {@link AgentToolResultFrameSchema} names, and the pairing is an
 * invariant of the stream rather than a convention: a result whose call was never announced is a
 * transcript with a hole in it.
 */
export const AgentToolCallFrameSchema = z
  .object({
    frame: z.literal('agent.tool.call'),
    ...agentFrameBase,
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    kind: AgentToolKindSchema,
    input: z.unknown(),
  })
  .strict()
  .readonly();
export type AgentToolCallFrame = z.infer<typeof AgentToolCallFrameSchema>;

/**
 * `agent.tool.result` — the tool answered.
 *
 * `status` and `isError` are not the same fact and neither is derived from the other: `status` says
 * whether the call ran to completion, `isError` is the engine's own verdict on the answer. A tool
 * that completed and returned an error has `status: 'completed'` and `isError: true`.
 */
export const AgentToolResultFrameSchema = z
  .object({
    frame: z.literal('agent.tool.result'),
    ...agentFrameBase,
    toolCallId: z.string().min(1),
    status: z.enum(['completed', 'failed']),
    output: z.string(),
    isError: z.boolean(),
  })
  .strict()
  .readonly();
export type AgentToolResultFrame = z.infer<typeof AgentToolResultFrameSchema>;

/**
 * `agent.usage` — the engine's own token counters, **informational**.
 *
 * Billing is metered at the gateway and lives in `run_usage_records` (ADR-0065 D6). This frame is
 * what the engine says it spent, which is a different measurement and is presented as such; a
 * consumer that adds it up is reporting the engine's opinion, not an invoice. Counters an engine
 * does not report are `null`, never `0`.
 */
export const AgentUsageFrameSchema = z
  .object({
    frame: z.literal('agent.usage'),
    ...agentFrameBase,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative().nullable(),
    cacheCreationInputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .readonly();
export type AgentUsageFrame = z.infer<typeof AgentUsageFrameSchema>;

/**
 * `agent.result` — the engine's terminal accounting for the turn.
 *
 * It says how the *engine's* turn ended. The run's own outcome is `run.status`, written by the
 * control plane, and the two are deliberately separate: a turn that ended `end_turn` inside a run
 * the platform then failed to record is not a completed run.
 *
 * `engineCostUsd` is the engine's self-reported estimate, or `null`. It is never shown as money on
 * its own — `packages/core`'s `classifyRunCost` is the gate that decides whether a figure may be.
 */
export const AgentResultFrameSchema = z
  .object({
    frame: z.literal('agent.result'),
    ...agentFrameBase,
    stopReason: AgentStopReasonSchema,
    turns: z.number().int().nonnegative().nullable(),
    engineCostUsd: z.number().nonnegative().nullable(),
  })
  .strict()
  .readonly();
export type AgentResultFrame = z.infer<typeof AgentResultFrameSchema>;

/**
 * `agent.native` — everything the engine emitted that has no neutral meaning.
 *
 * **Never dropped, never interpreted.** This frame is what makes the closed vocabulary safe: an
 * adapter meeting a message it cannot map forwards it here, so the "every engine message reaches a
 * frame" invariant holds without the neutral set having to grow to cover one engine's telemetry.
 * `type` is the engine's own name for the message.
 */
export const AgentNativeFrameSchema = z
  .object({
    frame: z.literal('agent.native'),
    ...agentFrameBase,
    type: z.string().min(1),
    payload: z.unknown(),
  })
  .strict()
  .readonly();
export type AgentNativeFrame = z.infer<typeof AgentNativeFrameSchema>;

/**
 * `agent.malformed` — the engine produced something its adapter could not parse.
 *
 * Distinct from `agent.native`, and the distinction is ADR-0015's: `agent.native` is well-formed
 * and unmapped, so it is forwarded; this is not well-formed, and it is reported by name rather
 * than forwarded as though it had been understood. It is the successor of the `malformed` relayed
 * name and keeps the same guarantee.
 */
export const AgentMalformedFrameSchema = z
  .object({
    frame: z.literal('agent.malformed'),
    ...agentFrameBase,
    reason: z.string().min(1),
  })
  .strict()
  .readonly();
export type AgentMalformedFrame = z.infer<typeof AgentMalformedFrameSchema>;

/** Every neutral frame, discriminated by the `frame` field that repeats its `event:` name. */
export const AgentFrameSchema = z.discriminatedUnion('frame', [
  AgentSessionFrameSchema,
  AgentMessageFrameSchema,
  AgentMessageDeltaFrameSchema,
  AgentToolCallFrameSchema,
  AgentToolResultFrameSchema,
  AgentUsageFrameSchema,
  AgentResultFrameSchema,
  AgentNativeFrameSchema,
  AgentMalformedFrameSchema,
]);
export type AgentFrame = z.infer<typeof AgentFrameSchema>;

const AGENT_FRAMES: ReadonlySet<string> = new Set(AGENT_FRAME_NAMES);

/** Whether an `event:` name is one of the neutral frames. */
export function isAgentFrameName(name: string): name is AgentFrameName {
  return AGENT_FRAMES.has(name);
}

const LEGACY_FRAMES: ReadonlySet<string> = new Set(RELAYED_EVENT_NAMES);

/**
 * Whether an `event:` name is one of the pre-ENG-03 relayed names, and therefore a stored row the
 * event-read path must upgrade before serving it.
 */
export function isLegacyRelayedEventName(name: string): name is RelayedEventName {
  return LEGACY_FRAMES.has(name);
}
