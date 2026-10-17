/**
 * pi's session events into the neutral `agent.*` vocabulary (ENG-03, ENG-08).
 *
 * Pure and SDK-free. `./boundary.ts` hands each `AgentSessionEvent` over as a {@link PiEvent} — the
 * event itself, pi's own `type` kept — and this module maps it onto frames with the port's
 * `engineFrameBuilder`, so every frame carries `engine: 'pi'` and a capped `raw` without this file
 * spelling either out (ADR-0070 D4).
 *
 * ## The mapping (issue #307, "Events")
 *
 * | Event                                         | Frame                               |
 * | --------------------------------------------- | ----------------------------------- |
 * | `message_update` `text_delta`                 | `agent.message.delta` (text)        |
 * | `message_update` `thinking_delta`             | `agent.message.delta` (reasoning)   |
 * | `message_end` of an assistant message         | `agent.message`                     |
 * | `tool_execution_start`                        | `agent.tool.call`                   |
 * | `tool_execution_end`                          | `agent.tool.result`                 |
 * | `run_completed` (the adapter's terminal event)| `agent.usage`, then `agent.result`  |
 * | everything else, `agent_end` included         | `agent.native`                      |
 *
 * `agent_end` is forwarded as `agent.native` rather than mapped to `agent.result`, because pi says
 * of it that "automatic recovery or queued work can still follow": the result is emitted once, when
 * `session.prompt()` has resolved and pi will not continue (ADR-0081 D5).
 *
 * ## Two invariants, and where they are held
 *
 * * **Nothing is dropped.** Every event produces at least one frame. An event this module cannot
 *   read is `agent.malformed`, never skipped; one it can read and has no neutral meaning for is
 *   `agent.native`. `formal/AgentWorkspace/Theorems/Invariants/Pi.lean` states it.
 * * **Tool pairing.** A `tool_execution_end` whose call id was never announced by a
 *   `tool_execution_start` is `agent.malformed` rather than an `agent.tool.result` with a hole in
 *   front of it.
 */
import type { AgentMessageBlock, AgentStopReason } from '@indx-workspace/contracts/run-events';
import { engineFrameBuilder, type EngineFrame } from '@agent-workspace/engine';

import { PI_ENGINE_ID } from './compile.js';
import { piToolKind } from './tools.js';

/** Token counters one run reported, summed over its assistant messages. Informational (ADR-0065 D6). */
export type PiUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  /** pi's own estimate, priced with the model's `cost` — the provisional table under a cap. */
  readonly costUsd: number;
};

/**
 * One pi event, as plain data. `pi` carries a session event as pi emitted it; `run_completed` is
 * the adapter's terminal event, synthesised by the boundary once `prompt()` has resolved.
 */
export type PiEvent =
  | { readonly kind: 'pi'; readonly event: unknown }
  | {
      readonly kind: 'run_completed';
      readonly stopReason: AgentStopReason;
      readonly turns: number;
      readonly usage: PiUsage | null;
    };

export type PiFrameMapper = {
  /** Map one event. Never returns an empty list. */
  map(event: PiEvent): readonly EngineFrame[];
};

const builder = engineFrameBuilder(PI_ENGINE_ID);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The text parts of a pi content list, joined; `null` when the list is not one. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content as unknown[]) {
    if (!isRecord(part)) return null;
    if (part['type'] === 'text' && typeof part['text'] === 'string') texts.push(part['text']);
    else if (part['type'] === 'image') texts.push('[image]');
  }
  return texts.join('');
}

/** An assistant message's prose and reasoning. Tool calls are their own frames. */
function assistantBlocks(content: unknown): AgentMessageBlock[] | null {
  if (!Array.isArray(content)) return null;
  const blocks: AgentMessageBlock[] = [];
  for (const part of content as unknown[]) {
    if (!isRecord(part) || typeof part['type'] !== 'string') return null;
    if (part['type'] === 'text' && typeof part['text'] === 'string') {
      blocks.push({ type: 'text', text: part['text'] });
    } else if (part['type'] === 'thinking' && typeof part['thinking'] === 'string') {
      blocks.push({ type: 'reasoning', text: part['thinking'] });
    }
  }
  return blocks;
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Add one assistant message's `usage` to a running total. A message without a readable `usage`
 * leaves the total as it was; pi reports usage on every assistant message it finalises.
 */
export function addPiUsage(total: PiUsage | null, usage: unknown): PiUsage | null {
  if (!isRecord(usage)) return total;
  const input = nonNegative(usage['input']);
  const output = nonNegative(usage['output']);
  if (input === null || output === null) return total;
  const cost = isRecord(usage['cost']) ? (nonNegative(usage['cost']['total']) ?? 0) : 0;
  return {
    inputTokens: (total?.inputTokens ?? 0) + Math.round(input),
    outputTokens: (total?.outputTokens ?? 0) + Math.round(output),
    cacheReadInputTokens:
      (total?.cacheReadInputTokens ?? 0) + Math.round(nonNegative(usage['cacheRead']) ?? 0),
    cacheWriteInputTokens:
      (total?.cacheWriteInputTokens ?? 0) + Math.round(nonNegative(usage['cacheWrite']) ?? 0),
    costUsd: (total?.costUsd ?? 0) + cost,
  };
}

/** Build a mapper for one run. Stateful only in the call ids it has announced. */
export function createPiFrameMapper(): PiFrameMapper {
  const announced = new Set<string>();

  function mapUpdate(event: Readonly<Record<string, unknown>>, raw: PiEvent): EngineFrame[] {
    const update = event['assistantMessageEvent'];
    if (!isRecord(update) || typeof update['type'] !== 'string') {
      return [builder.malformed('a message_update without an assistant message event', raw)];
    }
    const delta = update['delta'];
    if (update['type'] === 'text_delta' && typeof delta === 'string') {
      return [
        builder.messageDelta(
          { frame: 'agent.message.delta', messageId: null, block: 'text', text: delta },
          raw,
        ),
      ];
    }
    if (update['type'] === 'thinking_delta' && typeof delta === 'string') {
      return [
        builder.messageDelta(
          { frame: 'agent.message.delta', messageId: null, block: 'reasoning', text: delta },
          raw,
        ),
      ];
    }
    return [builder.native(`message_update.${update['type']}`, raw)];
  }

  function mapMessageEnd(event: Readonly<Record<string, unknown>>, raw: PiEvent): EngineFrame[] {
    const message = event['message'];
    if (!isRecord(message) || typeof message['role'] !== 'string') {
      return [builder.malformed('a message_end without a message role', raw)];
    }
    if (message['role'] !== 'assistant') {
      return [builder.native(`message_end.${message['role']}`, raw)];
    }
    const blocks = assistantBlocks(message['content']);
    if (blocks === null) {
      return [builder.malformed('an assistant message whose content is not a list of parts', raw)];
    }
    return [
      builder.message(
        {
          frame: 'agent.message',
          messageId: stringOrNull(message['responseId']),
          role: 'assistant',
          blocks,
        },
        raw,
      ),
    ];
  }

  function mapToolStart(event: Readonly<Record<string, unknown>>, raw: PiEvent): EngineFrame[] {
    const callId = stringOrNull(event['toolCallId']);
    const name = stringOrNull(event['toolName']);
    if (callId === null || name === null) {
      return [builder.malformed('a tool execution without a call id or a tool name', raw)];
    }
    announced.add(callId);
    return [
      builder.toolCall(
        {
          frame: 'agent.tool.call',
          toolCallId: callId,
          name,
          kind: piToolKind(name),
          input: event['args'] ?? null,
        },
        raw,
      ),
    ];
  }

  function mapToolEnd(event: Readonly<Record<string, unknown>>, raw: PiEvent): EngineFrame[] {
    const callId = stringOrNull(event['toolCallId']);
    if (callId === null) return [builder.malformed('a tool result without a call id', raw)];
    if (!announced.has(callId)) {
      return [
        builder.malformed(
          `a tool result for call ${JSON.stringify(callId)}, which no tool execution announced`,
          raw,
        ),
      ];
    }
    const result = event['result'];
    const output = isRecord(result) ? contentText(result['content']) : null;
    if (output === null) {
      return [builder.malformed('a tool result whose content is not a list of parts', raw)];
    }
    announced.delete(callId);
    const isError = event['isError'] === true;
    return [
      builder.toolResult(
        {
          frame: 'agent.tool.result',
          toolCallId: callId,
          status: isError ? 'failed' : 'completed',
          output,
          isError,
        },
        raw,
      ),
    ];
  }

  function mapCompleted(event: Extract<PiEvent, { kind: 'run_completed' }>): EngineFrame[] {
    const frames: EngineFrame[] = [];
    if (event.usage !== null) {
      frames.push(
        builder.usage(
          {
            frame: 'agent.usage',
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadInputTokens: event.usage.cacheReadInputTokens,
            cacheCreationInputTokens: event.usage.cacheWriteInputTokens,
            reasoningTokens: null,
          },
          event,
        ),
      );
    }
    frames.push(
      builder.result(
        {
          frame: 'agent.result',
          stopReason: event.stopReason,
          turns: event.turns,
          // pi's `usage.cost` is priced from a table this adapter chose (the provisional one under
          // a cap), so it is not the engine's own figure; billing is the gateway's (ADR-0065 D6).
          engineCostUsd: null,
        },
        event,
      ),
    );
    return frames;
  }

  return {
    map(event) {
      if (event.kind === 'run_completed') return mapCompleted(event);
      const inner = event.event;
      if (!isRecord(inner) || typeof inner['type'] !== 'string') {
        return [builder.malformed('a pi event without a type', event)];
      }
      switch (inner['type']) {
        case 'message_update':
          return mapUpdate(inner, event);
        case 'message_end':
          return mapMessageEnd(inner, event);
        case 'tool_execution_start':
          return mapToolStart(inner, event);
        case 'tool_execution_end':
          return mapToolEnd(inner, event);
        default:
          return [builder.native(inner['type'], event)];
      }
    },
  };
}
