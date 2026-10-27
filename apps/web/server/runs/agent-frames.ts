/**
 * The event-read path's upgrade to the neutral `agent.*` vocabulary (ENG-03, #302).
 *
 * `GET /api/runs/:id/events` serves **one** vocabulary: the closed `agent.*` set of
 * `@indx-workspace/contracts`' `AGENT_FRAME_NAMES`. A run started after ENG-03 already produces it
 * — the runner's adapter normalises there, once, so that no client re-maps one engine's
 * classification (ADR-0065 D5). A run recorded *before* ENG-03 has `run_events` rows named with the
 * old relayed vocabulary (`system`, `sdk-event`, `result`, …), each holding one Claude Agent SDK
 * message inside the runner's classification envelope.
 *
 * Those rows are **upgraded on read**, here, and there is no data migration. Two reasons, and both
 * are about what a migration would have to promise:
 *
 *   1. the upgrade is a pure function of the stored message, so re-deriving it on every read cannot
 *      drift from what a fresh run produces, whereas a one-time rewrite freezes whatever the
 *      mapping looked like on the day it ran;
 *   2. the stored message is the engine's own words, and it is the thing `raw` is for. Rewriting
 *      the rows would replace the archive with an interpretation of it.
 *
 * The upgrade runs the **same** function the runner does — `@agent-workspace/core`'s
 * `toAgentFrames`, the Claude boundary's mapping, which ENG-04 moves into the Claude adapter
 * package — over a classification re-derived from the stored message with `classifySdkEvent`. That
 * is what makes `docs/formal/domains/d1-runs.md`'s replay refinement hold: a legacy run and a fresh
 * run of the same messages yield the same frames, because they are literally the same two
 * functions, in the same order, over the same input.
 *
 * **The one hypothesis this cannot discharge in code** is that the stored message is the JSON
 * round-trip of what the SDK produced: the runner wrote it with `JSON.stringify` and the relay read
 * it with `JSON.parse`. `classifySdkEvent` reads only `type` and `subtype`, and JSON preserves
 * strings and objects, so classification survives the round-trip; a value JSON drops (`undefined`,
 * a function, a symbol) can only make a discriminant *absent*, which classifies as `malformed` —
 * the same answer as before it was dropped. It is stated as a hypothesis in
 * `formal/AgentWorkspace/Theorems/Refinement/AgentFrames.lean` and exercised by
 * `apps/web/formal/legacy-frames.test.ts` rather than assumed away.
 *
 * ADR-0015 twice: the row's name is recognised **positively** (an `agent.*` name, a legacy name, or
 * the platform's own event — never "not one of those, so pass it through as a guess"), and a legacy
 * row whose envelope is not one is reported as `agent.malformed` by name rather than served as
 * though it had been understood, with the stored payload intact in `raw`.
 */
import {
  capAgentFrameRaw,
  classifySdkEvent,
  toAgentFrames,
  type AgentFrame,
} from '@agent-workspace/run-protocol';
import { isLegacyRelayedEventName } from '@indx-workspace/contracts/run-events';
import { ENGINE_IDS, type EngineId } from '@indx-workspace/contracts/engines';

import type { SseEvent, SseWireEvent } from './sse';

/**
 * The engine every upgraded legacy frame names.
 *
 * Read from the vocabulary, not from the run row: a legacy-named row can only have been written by
 * the Claude relay, because the relayed vocabulary predates every other engine and ENG-03 is the
 * unit that stopped it being written. A run recorded before migration 0024 has no `engine` column
 * value at all, so consulting the row would answer `null` for exactly the rows this path exists to
 * serve.
 */
const LEGACY_ENGINE: EngineId = ENGINE_IDS[0];

/**
 * The most frames one stored row may serve: sub-indices `0 … 999`.
 *
 * `sse.ts`'s `WIRE_EVENT_ID_PATTERN` and `cursor.ts` admit at most three sub-index digits. How many
 * frames one legacy row maps to is the tenant's agent's choice (one per `tool_use` block), so the
 * bound is enforced where the ids are minted: an over-long row serves its first 999 frames and one
 * `agent.malformed` that reports the rest — reported, not guessed, and never an id the grammar
 * refuses, which would fail the whole replay of that run.
 */
export const MAX_FRAMES_PER_ROW = 1000;

/**
 * The `id:` of one served frame.
 *
 * `subIndex === null` is the bare sequence: a row served one-to-one, which is every row a run
 * started after ENG-03 writes. An upgraded legacy row always carries a sub-index, even when it
 * produced a single frame, so that an id says which kind of row it came from rather than leaving a
 * consumer to infer it from whether a sibling happened to exist.
 */
export function wireEventId(sequence: bigint, subIndex: number | null): string {
  return subIndex === null ? String(sequence) : `${String(sequence)}.${String(subIndex)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The Claude Agent SDK message a legacy row's envelope carries, or a refusal naming what was
 * wrong.
 *
 * The envelope the runner wrote is `{ kind, subtype?, carriesUsage?, event }` — the
 * `ClassifiedSdkEvent` itself, serialised. `event` is read by presence, not by truthiness: an SDK
 * message that was not an object is a legitimate stored value and classifies as `malformed`, which
 * is a different answer from a row that carries no `event` key at all.
 */
function legacySdkMessage(
  data: unknown,
):
  | { readonly ok: true; readonly message: unknown }
  | { readonly ok: false; readonly reason: string } {
  const envelope = asRecord(data);
  if (envelope === null) {
    return {
      ok: false,
      reason:
        "a pre-ENG-03 run event must hold the runner's classification envelope as a JSON object; this row holds something else",
    };
  }
  if (typeof envelope['kind'] !== 'string') {
    return {
      ok: false,
      reason:
        "a pre-ENG-03 run event's envelope must carry a string 'kind'; this row's does not, so the engine message it wrapped cannot be identified",
    };
  }
  if (!('event' in envelope)) {
    return {
      ok: false,
      reason:
        "a pre-ENG-03 run event's envelope must carry the engine message under 'event'; this row's does not",
    };
  }
  return { ok: true, message: envelope['event'] };
}

/**
 * Upgrade one stored row into the frames the stream serves for it. **Never throws.**
 *
 * The pre-ENG-03 vocabulary is recognised **positively**, by membership of
 * `RELAYED_EVENT_NAMES`, and only those rows are mapped. Every other name the store can hold is
 * already what the stream serves — an `agent.*` frame, or the platform's own `run.status` — and is
 * forwarded under its bare sequence. Ingestion (`sse.ts`'s `classifyStoredEventName`) admits no
 * other kind, and this function does not widen it: the frames it forwards were written by the
 * control plane or by an adapter that already normalised.
 */
export function upgradeStoredEvent(event: SseEvent): readonly SseWireEvent[] {
  const stamp = event.at === undefined ? {} : { at: event.at };
  if (!isLegacyRelayedEventName(event.type)) {
    return [{ id: event.id, type: event.type, data: event.data, ...stamp }];
  }

  const message = legacySdkMessage(event.data);
  const frames: readonly AgentFrame[] = message.ok
    ? toAgentFrames(classifySdkEvent(message.message), LEGACY_ENGINE)
    : [
        {
          frame: 'agent.malformed',
          engine: LEGACY_ENGINE,
          // The whole stored row, capped: the frame says the envelope could not be read, so the
          // envelope itself is the only thing left that a reader can go on.
          raw: capAgentFrameRaw(event.data),
          reason: message.reason,
        },
      ];

  const served: readonly AgentFrame[] =
    frames.length <= MAX_FRAMES_PER_ROW
      ? frames
      : [
          ...frames.slice(0, MAX_FRAMES_PER_ROW - 1),
          {
            frame: 'agent.malformed',
            engine: LEGACY_ENGINE,
            raw: capAgentFrameRaw(event.data),
            reason: `a pre-ENG-03 run event mapped to ${String(frames.length)} frames, more than the ${String(MAX_FRAMES_PER_ROW)} one row may serve; the last ${String(frames.length - (MAX_FRAMES_PER_ROW - 1))} are reported here instead of served`,
          },
        ];

  return served.map((frame, index) => ({
    id: wireEventId(event.id, index),
    type: frame.frame,
    data: frame,
    ...stamp,
  }));
}

/**
 * Where a resumed connection restarts inside one row.
 *
 * A client that last saw `<sequence>.<sub-index>` is resumed by re-reading that whole row — the
 * store seeks by row, and a row is the smallest thing it can deliver — and dropping the frames the
 * client already has. Without this, `Last-Event-ID` on a sub-indexed id would either repeat the
 * row's earlier frames or skip the rest of it.
 */
export interface ResumedWithinRow {
  readonly sequence: bigint;
  readonly subIndex: number;
}

/**
 * Serve a store's rows as neutral frames, honouring a resume that landed inside a row.
 *
 * `resumedWithin` is consulted for the first row only, and by sequence rather than by position: a
 * cursor into a row the store can no longer retain has already produced a `stream-reset`, so a
 * first row with a different sequence is the oldest row that *is* retained and every frame of it is
 * new to the client.
 */
export async function* upgradeEventStream(
  source: AsyncIterable<SseEvent>,
  resumedWithin: ResumedWithinRow | null,
): AsyncGenerator<SseWireEvent> {
  let pending = resumedWithin;
  for await (const event of source) {
    const frames = upgradeStoredEvent(event);
    if (pending !== null) {
      // A sub-index only ever names a frame of an upgraded legacy row. A cursor carrying one for a
      // row served one-to-one is an id this server never wrote, so that row is delivered whole
      // rather than dropped on the strength of a position it does not have. Decided by the row's
      // kind, not by how many frames it served: a legacy row that served one frame (`7.0`) was
      // served in parts all the same, and resuming at `7.0` must not repeat it.
      const servedInParts = isLegacyRelayedEventName(event.type);
      const skip = pending.sequence === event.id && servedInParts ? pending.subIndex + 1 : 0;
      pending = null;
      yield* frames.slice(skip);
      continue;
    }
    yield* frames;
  }
}

/**
 * The platform's handoff tool as the Claude adapter names it (ADR-0145 D4). `apps/web` may not import
 * the adapter; the adapter refuses a connector named `agent-workspace`, so the name is the platform's.
 */
const HANDOFF_TOOL_CALL = 'mcp__agent-workspace__handoff_to_person';

/** What a visitor's stream has learned of the run's handoff so far. */
interface HandoffSeen {
  readonly calls: Set<string>;
  /** Each reason as it appears inside JSON text, so a match in `raw` is a match in its encoding. */
  readonly reasons: string[];
}

function rememberReason(seen: HandoffSeen, reason: unknown): void {
  if (typeof reason === 'string' && reason !== '')
    seen.reasons.push(JSON.stringify(reason).slice(1, -1));
}

function mentionsHandoff(value: unknown, seen: HandoffSeen): boolean {
  if (value === null || value === undefined) return false;
  // Encoded even for a string, so it is compared in the same JSON escaping as `seen.reasons`.
  const text = JSON.stringify(value) ?? '';
  return text.includes(HANDOFF_TOOL_CALL) || seen.reasons.some((reason) => text.includes(reason));
}

/** One frame as a visitor is served it; `seen` carries what earlier frames revealed. */
function visitorFrame(data: Record<string, unknown>, seen: HandoffSeen): Record<string, unknown> {
  const frame = { ...data };
  if (frame['frame'] === 'agent.tool.call' && frame['name'] === HANDOFF_TOOL_CALL) {
    rememberReason(seen, asRecord(frame['input'])?.['reason']);
    if (typeof frame['toolCallId'] === 'string') seen.calls.add(frame['toolCallId']);
    frame['input'] = {};
  } else if (frame['frame'] === 'agent.handoff') {
    rememberReason(seen, frame['reason']);
    delete frame['reason'];
  } else if (
    frame['frame'] === 'agent.tool.result' &&
    typeof frame['toolCallId'] === 'string' &&
    seen.calls.has(frame['toolCallId']) &&
    mentionsHandoff(frame['output'], seen)
  ) {
    frame['output'] = '';
  }
  // `raw` is the engine's own message: the assistant turn that called the tool carries its input.
  if (mentionsHandoff(frame['raw'], seen)) frame['raw'] = null;
  return frame;
}

/**
 * A visitor's view of the stream (a session-scoped browser token: the widget, or an app's own end
 * user). The handoff reason is the model's note to the operator (ADR-0145 D4), so it is removed here
 * rather than merely left unrendered — a visitor can read the wire: `agent.handoff`'s `reason`, the
 * `handoff_to_person` call's `input`, a result that echoes it, and any `raw` that names the tool or
 * carries the reason. Everything else passes through unchanged.
 */
export async function* forVisitor(
  source: AsyncIterable<SseWireEvent>,
): AsyncGenerator<SseWireEvent> {
  const seen: HandoffSeen = { calls: new Set(), reasons: [] };
  for await (const event of source) {
    const data = event.type.startsWith('agent.') ? asRecord(event.data) : null;
    yield data === null ? event : { ...event, data: visitorFrame(data, seen) };
  }
}
