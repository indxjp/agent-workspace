/**
 * `AgentEvent` — the neutral event view (`docs/sdk/04-api-specification.md` §6.3).
 *
 * **This module knows nothing about any engine.** Since ENG-03 (#302) the stream itself carries one
 * engine-neutral vocabulary: the closed `agent.*` frame set of `@indx-workspace/contracts`, which
 * the engine's adapter produces once, in the runner (ADR-0065 D5). What used to live here — a
 * Claude-shaped mapping of the runner's classification, which every other client then re-derived —
 * has moved to the place that owns the Claude boundary. An `AgentEvent` **is** a parsed frame, not a
 * translation of one, so a second engine adds nothing to this file.
 *
 * So this module is a *parser*, and it parses rather than trusts. The payload crossed a network and
 * the platform wrote it, which is exactly the case where a mismatch is drift rather than user data:
 * a frame whose `data` does not satisfy its schema is a {@link ContractViolationError} naming the
 * issues, never a partially-read object and never a silently skipped frame. `raw` stays typed
 * `unknown` — it is another vendor's shape and this SDK makes no promise about it.
 */
import {
  AgentFrameSchema,
  type AgentFrame,
  type AgentMalformedFrame,
  type AgentMessageDeltaFrame,
  type AgentMessageFrame,
  type AgentNativeFrame,
  type AgentResultFrame,
  type AgentSessionFrame,
  type AgentToolCallFrame,
  type AgentToolResultFrame,
  type AgentUsageFrame,
} from '@indx-workspace/contracts/run-events';

import { ContractViolationError } from '../errors.js';
import type { RunEventFrame } from './run-events.js';

/**
 * One neutral event: a validated `agent.*` frame.
 *
 * Discriminate on `frame`. Every variant carries `engine` — which engine produced it — and `raw`,
 * the engine-native message it was derived from, so nothing is lost by reading the neutral view
 * first.
 */
export type AgentEvent = AgentFrame;

export type {
  AgentMalformedFrame,
  AgentMessageDeltaFrame,
  AgentMessageFrame,
  AgentNativeFrame,
  AgentResultFrame,
  AgentSessionFrame,
  AgentToolCallFrame,
  AgentToolResultFrame,
  AgentUsageFrame,
};

/** The user-facing text carried by one assistant turn. */
export interface AssistantResponse {
  /** The engine's message id, used to replace a repeated snapshot instead of duplicating it. */
  readonly id: string;
  /** Text blocks in the order the model returned them. */
  readonly text: readonly string[];
}

/**
 * Parse one relayed frame into an {@link AgentEvent}.
 *
 * Throws {@link ContractViolationError} when `data` does not satisfy the frame schema, or when the
 * `event:` name and the payload's own `frame` field disagree. The second check is not redundancy:
 * the two are written by one function on the server, so a disagreement means the stream and its
 * payloads came from different places, and a client that trusted one over the other would render a
 * frame under a name nothing produced.
 */
function parseAgentFrame(name: string, data: unknown): AgentEvent {
  const parsed = AgentFrameSchema.safeParse(data);
  if (!parsed.success) {
    throw new ContractViolationError({
      operation: `runs.events(${name})`,
      status: 200,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  if (parsed.data.frame !== name) {
    throw new ContractViolationError({
      operation: `runs.events(${name})`,
      status: 200,
      issues: [`the frame is named ${name} but its payload says ${parsed.data.frame}`],
    });
  }
  return parsed.data;
}

/**
 * The neutral event one frame carries, or `null` for the platform's own frames.
 *
 * `run-status`, `run-failed`, `stream-reset` and `done` are already typed on {@link RunEventFrame}
 * and are not agent events: they are the *platform* speaking about the run and the stream, not the
 * engine speaking about the turn. Conflating the two is how a failed run gets rendered as a
 * finished one, so they stay apart.
 */
export function toAgentEvent(frame: RunEventFrame): AgentEvent | null {
  return frame.kind === 'runtime' ? parseAgentFrame(frame.name, frame.data) : null;
}

/**
 * Read the assistant's visible answer from one neutral event, or `null` when it carries none.
 *
 * The boundary is deliberately strict, and it is the same rule the browser's run view has always
 * applied: only an assistant message with an engine message id and at least one non-blank text
 * block becomes a chat turn. Reasoning blocks, tool calls, usage and results cannot leak into the
 * conversation — the answer is product content, while the rest is telemetry and belongs in
 * Technical details.
 */
export function assistantResponseFromAgentEvent(event: AgentEvent): AssistantResponse | null {
  if (event.frame !== 'agent.message' || event.role !== 'assistant' || event.messageId === null) {
    return null;
  }
  const text = event.blocks.flatMap((block) =>
    block.type === 'text' && block.text.trim() !== '' ? [block.text] : [],
  );
  return text.length === 0 ? null : { id: event.messageId, text };
}
