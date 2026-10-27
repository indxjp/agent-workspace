/**
 * The OpenAI Agents SDK's stream events into the neutral `agent.*` vocabulary (ENG-03, ENG-09).
 *
 * Pure and SDK-free. `./boundary.ts` turns each `RunStreamEvent` into an {@link OpenAiAgentsEvent}
 * — plain JSON, the SDK's own names kept — and this module maps that onto frames with the port's
 * `engineFrameBuilder`, so every frame carries `engine: 'openai-agents'` and a capped `raw` without
 * this file spelling either out (ADR-0070 D4).
 *
 * ## The mapping (issue #308, "Events")
 *
 * | Event                                                   | Frame                              |
 * | ------------------------------------------------------- | ---------------------------------- |
 * | `raw_model_stream_event` `output_text_delta`            | `agent.message.delta` (text)       |
 * | `raw_model_stream_event` reasoning delta                | `agent.message.delta` (reasoning)  |
 * | `run_item_stream_event` `message_output_created`        | `agent.message`                    |
 * | `run_item_stream_event` `reasoning_item_created`        | `agent.message` (reasoning block)  |
 * | `run_item_stream_event` `tool_called`                   | `agent.tool.call`                  |
 * | `run_item_stream_event` `tool_output`                   | `agent.tool.result`                |
 * | `run_completed` (the adapter's own terminal event)      | `agent.usage`, then `agent.result` |
 * | everything else, `agent_updated_stream_event` included  | `agent.native`                     |
 *
 * ## Two invariants, and where they are held
 *
 * * **Nothing is dropped.** Every event produces at least one frame. An event this module cannot
 *   read is `agent.malformed`, never skipped; one it can read and has no neutral meaning for is
 *   `agent.native`. `formal/AgentWorkspace/Theorems/Invariants/OpenAiAgents.lean` states it.
 * * **Tool pairing.** A `tool_output` whose call id was never announced by a `tool_called` is
 *   `agent.malformed` rather than an `agent.tool.result` with a hole in front of it.
 */
import type { AgentStopReason } from '@indx-workspace/contracts/run-events';
import { engineFrameBuilder, type EngineFrame } from '@agent-workspace/engine';

import { OPENAI_AGENTS_ENGINE_ID } from './compile.js';
import { openAiAgentsToolKind } from './tools.js';

/** Token counters one run reported, summed over its model responses. Informational (ADR-0065 D6). */
export type OpenAiAgentsUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
};

/**
 * One SDK event, as plain data. The three SDK kinds keep their own names; `run_completed` is the
 * adapter's terminal event, synthesised by the boundary when the stream ends, because the SDK
 * reports completion by the stream ending (or throwing) rather than by an event.
 */
export type OpenAiAgentsEvent =
  | { readonly kind: 'raw_model_stream_event'; readonly data: unknown }
  | {
      readonly kind: 'run_item_stream_event';
      readonly name: string;
      readonly item: {
        readonly type: string;
        readonly rawItem: unknown;
        readonly output?: unknown;
      };
    }
  | { readonly kind: 'agent_updated_stream_event'; readonly agentName: string }
  | {
      readonly kind: 'run_completed';
      readonly stopReason: AgentStopReason;
      readonly turns: number | null;
      readonly usage: OpenAiAgentsUsage | null;
      /** The answer and its parsed form, when the stop was `end_turn` (ADR-0143). */
      readonly output?: { readonly text: string; readonly structured: unknown };
    };

/** What the mapper needs to know about the compiled run. */
export type OpenAiAgentsFrameContext = {
  /** The adapter's own function tools. A function call named anything else is an MCP tool. */
  readonly localTools: readonly string[];
  readonly hasMcp: boolean;
};

export type OpenAiAgentsFrameMapper = {
  /** Map one event. Never returns an empty list. */
  map(event: OpenAiAgentsEvent): readonly EngineFrame[];
};

const builder = engineFrameBuilder(OPENAI_AGENTS_ENGINE_ID);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The text of an SDK tool output, however the SDK shaped it. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (isRecord(output) && typeof output['text'] === 'string') return output['text'];
  if (output === undefined) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return '[a tool output that cannot be serialised]';
  }
}

/** The prefix `./executors.ts` gives an answer that is an error. */
export const OPENAI_AGENTS_TOOL_ERROR_PREFIX = 'ERROR: ';

function reasoningDelta(data: Record<string, unknown>): { text: string; id: string | null } | null {
  if (data['type'] !== 'model' || !isRecord(data['event'])) return null;
  const event = data['event'];
  const type = event['type'];
  if (
    (type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta') &&
    typeof event['delta'] === 'string'
  ) {
    return { text: event['delta'], id: stringOrNull(event['item_id']) };
  }
  return null;
}

function messageBlocks(content: unknown): { type: 'text'; text: string }[] | null {
  if (!Array.isArray(content)) return null;
  const blocks: { type: 'text'; text: string }[] = [];
  for (const part of content as unknown[]) {
    if (!isRecord(part)) return null;
    if (part['type'] === 'output_text' && typeof part['text'] === 'string') {
      blocks.push({ type: 'text', text: part['text'] });
    } else if (part['type'] === 'refusal' && typeof part['refusal'] === 'string') {
      blocks.push({ type: 'text', text: part['refusal'] });
    }
  }
  return blocks;
}

function reasoningText(raw: Record<string, unknown>): string | null {
  const parts = [raw['rawContent'], raw['content']].find(
    (candidate) => Array.isArray(candidate) && candidate.length > 0,
  );
  if (!Array.isArray(parts)) return '';
  const texts: string[] = [];
  for (const part of parts as unknown[]) {
    if (!isRecord(part) || typeof part['text'] !== 'string') return null;
    texts.push(part['text']);
  }
  return texts.join('');
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Build a mapper for one run. Stateful only in the call ids it has announced. */
export function createOpenAiAgentsFrameMapper(
  context: OpenAiAgentsFrameContext,
): OpenAiAgentsFrameMapper {
  const announced = new Set<string>();

  function mapItem(
    event: Extract<OpenAiAgentsEvent, { kind: 'run_item_stream_event' }>,
  ): readonly EngineFrame[] {
    const raw = event.item.rawItem;
    const nativeType = `run_item_stream_event.${event.name}`;
    switch (event.name) {
      case 'message_output_created': {
        if (!isRecord(raw)) return [builder.malformed('a message item without a raw item', event)];
        const blocks = messageBlocks(raw['content']);
        if (blocks === null) {
          return [builder.malformed('a message item whose content is not a list of parts', event)];
        }
        return [
          builder.message(
            {
              frame: 'agent.message',
              messageId: stringOrNull(raw['id']),
              role: 'assistant',
              blocks,
            },
            event,
          ),
        ];
      }
      case 'reasoning_item_created': {
        if (!isRecord(raw))
          return [builder.malformed('a reasoning item without a raw item', event)];
        const text = reasoningText(raw);
        if (text === null)
          return [builder.malformed('a reasoning item with unreadable text', event)];
        return [
          builder.message(
            {
              frame: 'agent.message',
              messageId: stringOrNull(raw['id']),
              role: 'assistant',
              blocks: [{ type: 'reasoning', text }],
            },
            event,
          ),
        ];
      }
      case 'tool_called': {
        if (!isRecord(raw) || raw['type'] !== 'function_call') {
          // Every tool this adapter compiles is a function tool; anything else is the SDK's own
          // item kind and is forwarded rather than guessed at.
          return [builder.native(nativeType, event)];
        }
        const callId = stringOrNull(raw['callId']);
        const name = stringOrNull(raw['name']);
        if (callId === null || name === null) {
          return [builder.malformed('a function call without a call id or a name', event)];
        }
        announced.add(callId);
        const isMcp = context.hasMcp && !context.localTools.includes(name);
        return [
          builder.toolCall(
            {
              frame: 'agent.tool.call',
              toolCallId: callId,
              name,
              kind: openAiAgentsToolKind(name, isMcp),
              input: parseArguments(raw['arguments']),
            },
            event,
          ),
        ];
      }
      case 'tool_output': {
        if (!isRecord(raw) || raw['type'] !== 'function_call_result') {
          return [builder.native(nativeType, event)];
        }
        const callId = stringOrNull(raw['callId']);
        if (callId === null) return [builder.malformed('a tool output without a call id', event)];
        if (!announced.has(callId)) {
          return [
            builder.malformed(
              `a tool output for call ${JSON.stringify(callId)}, which no tool call announced`,
              event,
            ),
          ];
        }
        announced.delete(callId);
        const output = outputText(event.item.output ?? raw['output']);
        const failed = raw['status'] === 'incomplete';
        return [
          builder.toolResult(
            {
              frame: 'agent.tool.result',
              toolCallId: callId,
              status: failed ? 'failed' : 'completed',
              output,
              isError: failed || output.startsWith(OPENAI_AGENTS_TOOL_ERROR_PREFIX),
            },
            event,
          ),
        ];
      }
      default:
        return [builder.native(nativeType, event)];
    }
  }

  return {
    map(event) {
      switch (event.kind) {
        case 'raw_model_stream_event': {
          const data = event.data;
          if (!isRecord(data) || typeof data['type'] !== 'string') {
            return [builder.malformed('a raw model event without a type', event)];
          }
          if (data['type'] === 'output_text_delta' && typeof data['delta'] === 'string') {
            return [
              builder.messageDelta(
                {
                  frame: 'agent.message.delta',
                  messageId: stringOrNull(data['itemId']),
                  block: 'text',
                  text: data['delta'],
                },
                event,
              ),
            ];
          }
          const reasoning = reasoningDelta(data);
          if (reasoning !== null) {
            return [
              builder.messageDelta(
                {
                  frame: 'agent.message.delta',
                  messageId: reasoning.id,
                  block: 'reasoning',
                  text: reasoning.text,
                },
                event,
              ),
            ];
          }
          return [builder.native(`raw_model_stream_event.${data['type']}`, event)];
        }
        case 'run_item_stream_event':
          return mapItem(event);
        case 'agent_updated_stream_event':
          return [builder.native('agent_updated_stream_event', event)];
        case 'run_completed': {
          const frames: EngineFrame[] = [];
          if (event.usage !== null) {
            frames.push(
              builder.usage(
                {
                  frame: 'agent.usage',
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                  cacheReadInputTokens: event.usage.cachedInputTokens,
                  cacheCreationInputTokens: null,
                  reasoningTokens: event.usage.reasoningTokens,
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
                engineCostUsd: null,
                ...(event.output === undefined ? {} : { output: event.output }),
              },
              event,
            ),
          );
          return frames;
        }
      }
    },
  };
}

/** Sum one response's usage into a running total, as the SDK's camel-cased `UsageData`. */
export function addResponseUsage(
  total: OpenAiAgentsUsage | null,
  usage: unknown,
): OpenAiAgentsUsage | null {
  if (!isRecord(usage)) return total;
  const input = usage['inputTokens'];
  const output = usage['outputTokens'];
  if (typeof input !== 'number' || typeof output !== 'number') return total;
  const detail = (value: unknown, key: string): number | null => {
    const record = Array.isArray(value) ? (value as unknown[])[0] : value;
    if (!isRecord(record)) return null;
    const found = record[key];
    return typeof found === 'number' ? found : null;
  };
  const cached = detail(usage['inputTokensDetails'], 'cached_tokens');
  const reasoning = detail(usage['outputTokensDetails'], 'reasoning_tokens');
  const plus = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: (total?.inputTokens ?? 0) + input,
    outputTokens: (total?.outputTokens ?? 0) + output,
    cachedInputTokens: plus(total?.cachedInputTokens ?? null, cached),
    reasoningTokens: plus(total?.reasoningTokens ?? null, reasoning),
  };
}
