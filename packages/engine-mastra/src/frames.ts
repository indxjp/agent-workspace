/**
 * Mastra's `fullStream` chunks into the neutral `agent.*` vocabulary (ENG-03, ENG-10).
 *
 * Pure and SDK-free. `./boundary.ts` hands each chunk over as a {@link MastraEvent} — the chunk
 * itself, `{ type, from, payload }` as Mastra emitted it — and this module maps it onto frames with
 * the port's `engineFrameBuilder`, so every frame carries `engine: 'mastra'` and a capped `raw`
 * without this file spelling either out (ADR-0070 D4).
 *
 * ## The mapping (issue #309, "Events")
 *
 * | Chunk                                   | Frame                                        |
 * | --------------------------------------- | -------------------------------------------- |
 * | `text-delta`                            | `agent.message.delta` (text)                 |
 * | `reasoning-delta`                       | `agent.message.delta` (reasoning)            |
 * | `text-end` / `reasoning-end`            | `agent.message`, the part's deltas joined     |
 * | `tool-call`                             | `agent.tool.call` (MCP tools as `mcp`)        |
 * | `tool-result` / `tool-error`            | `agent.tool.result`                          |
 * | `finish` (as the adapter's `run_completed`) | `agent.usage`, then `agent.result`       |
 * | `error`                                 | `agent.result { stopReason: 'error' }`       |
 * | everything else, step boundaries included | `agent.native`                             |
 *
 * `finish` reaches this module inside the boundary's `run_completed`, because only the boundary
 * knows whether the run ended by itself, at `maxSteps`, at the budget or by an interrupt — the
 * frame still carries the `finish` chunk as its `raw`.
 *
 * ## Two invariants, and where they are held
 *
 * * **Nothing is dropped.** Every event produces at least one frame. A chunk this module cannot
 *   read is `agent.malformed`, never skipped; one it can read and has no neutral meaning for is
 *   `agent.native`. `formal/AgentWorkspace/Theorems/Invariants/Mastra.lean` states it.
 * * **Tool pairing.** A `tool-result` whose call id no `tool-call` announced is `agent.malformed`
 *   rather than an `agent.tool.result` with a hole in front of it.
 */
import type { AgentStopReason } from '@indx-workspace/contracts/run-events';
import {
  engineFrameBuilder,
  type EngineFrame,
  type ProvisionalModelPrice,
} from '@agent-workspace/engine';

import { MASTRA_ENGINE_ID } from './compile.js';
import { mastraToolKind } from './tools.js';

/** Token counters one run reported, summed over its steps. Informational (ADR-0065 D6). */
export type MastraUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly reasoningTokens: number | null;
  /** The provisional estimate under a cap; `0` when the run carries none. Never billing. */
  readonly costUsd: number;
};

/**
 * One Mastra event, as plain data. `mastra` carries a `fullStream` chunk as Mastra emitted it;
 * `run_completed` is the adapter's terminal event, built by the boundary from Mastra's `finish`.
 */
export type MastraEvent =
  | { readonly kind: 'mastra'; readonly chunk: unknown }
  | {
      readonly kind: 'run_completed';
      readonly stopReason: AgentStopReason;
      readonly steps: number;
      readonly usage: MastraUsage | null;
      /** Mastra's `finish` chunk, or `null` when the run ended without one (an interrupt). */
      readonly finish: unknown;
      /** The answer and its parsed form, when the stop was `end_turn` (ADR-0143). */
      readonly output?: { readonly text: string; readonly structured: unknown };
    };

export type MastraFrameMapper = {
  /** Map one event. Never returns an empty list. */
  map(event: MastraEvent): readonly EngineFrame[];
};

/** What a prompt-cache write costs, as a multiple of the input rate (Anthropic's five-minute TTL). */
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

const builder = engineFrameBuilder(MASTRA_ENGINE_ID);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/**
 * Add one step's `usage` (the AI SDK's `LanguageModelUsage`, as Mastra reports it on
 * `step-finish`) to a running total, priced with `price` when the run carries a cap. A step without
 * readable input and output counts leaves the total as it was.
 */
export function addMastraUsage(
  total: MastraUsage | null,
  usage: unknown,
  price: ProvisionalModelPrice | null,
): MastraUsage | null {
  if (!isRecord(usage)) return total;
  const input = count(usage['inputTokens']);
  const output = count(usage['outputTokens']);
  if (input === null || output === null) return total;
  const cacheRead = count(usage['cachedInputTokens']) ?? 0;
  const cacheWrite = count(usage['cacheCreationInputTokens']) ?? 0;
  const reasoning = count(usage['reasoningTokens']);
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  const perToken = (rate: string): number => Number(rate) / 1_000_000;
  const cost =
    price === null
      ? 0
      : uncached * perToken(price.inputUsdPerMillion) +
        cacheWrite * perToken(price.inputUsdPerMillion) * CACHE_WRITE_INPUT_MULTIPLIER +
        cacheRead * perToken(price.cachedInputUsdPerMillion) +
        output * perToken(price.outputUsdPerMillion);
  return {
    inputTokens: (total?.inputTokens ?? 0) + input,
    outputTokens: (total?.outputTokens ?? 0) + output,
    cacheReadInputTokens: (total?.cacheReadInputTokens ?? 0) + cacheRead,
    cacheWriteInputTokens: (total?.cacheWriteInputTokens ?? 0) + cacheWrite,
    reasoningTokens:
      reasoning === null && (total === null || total.reasoningTokens === null)
        ? null
        : (total?.reasoningTokens ?? 0) + (reasoning ?? 0),
    costUsd: (total?.costUsd ?? 0) + cost,
  };
}

/** A tool's answer as the text a consumer renders. */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return '[a result that cannot be serialised]';
  }
}

/**
 * Build a mapper for one run. Stateful in the text parts it is assembling, the call ids it has
 * announced and the steps it has seen. `connectors` names the run's MCP servers, whose tools are
 * reported as `mcp`.
 */
export function createMastraFrameMapper(connectors: readonly string[] = []): MastraFrameMapper {
  const parts = new Map<string, string>();
  const announced = new Set<string>();
  let steps = 0;

  function mapDelta(
    payload: Readonly<Record<string, unknown>>,
    block: 'text' | 'reasoning',
    raw: MastraEvent,
  ): EngineFrame[] {
    const id = stringOrNull(payload['id']);
    const text = payload['text'];
    if (id === null || typeof text !== 'string') {
      return [builder.malformed(`a ${block} delta without a part id or text`, raw)];
    }
    parts.set(`${block}:${id}`, (parts.get(`${block}:${id}`) ?? '') + text);
    return [
      builder.messageDelta({ frame: 'agent.message.delta', messageId: id, block, text }, raw),
    ];
  }

  function mapEnd(
    payload: Readonly<Record<string, unknown>>,
    block: 'text' | 'reasoning',
    raw: MastraEvent,
  ): EngineFrame[] {
    const id = stringOrNull(payload['id']);
    if (id === null) return [builder.malformed(`a ${block} end without a part id`, raw)];
    const text = parts.get(`${block}:${id}`) ?? '';
    parts.delete(`${block}:${id}`);
    return [
      builder.message(
        {
          frame: 'agent.message',
          messageId: id,
          role: 'assistant',
          blocks: [{ type: block, text }],
        },
        raw,
      ),
    ];
  }

  function mapToolCall(
    payload: Readonly<Record<string, unknown>>,
    raw: MastraEvent,
  ): EngineFrame[] {
    const callId = stringOrNull(payload['toolCallId']);
    const name = stringOrNull(payload['toolName']);
    if (callId === null || name === null) {
      return [builder.malformed('a tool call without a call id or a tool name', raw)];
    }
    announced.add(callId);
    return [
      builder.toolCall(
        {
          frame: 'agent.tool.call',
          toolCallId: callId,
          name,
          kind: mastraToolKind(name, connectors),
          input: payload['args'] ?? null,
        },
        raw,
      ),
    ];
  }

  function mapToolAnswer(
    payload: Readonly<Record<string, unknown>>,
    failed: boolean,
    raw: MastraEvent,
  ): EngineFrame[] {
    const callId = stringOrNull(payload['toolCallId']);
    if (callId === null) return [builder.malformed('a tool result without a call id', raw)];
    if (!announced.has(callId)) {
      // A fixed sentence, so the Lean mapper states it exactly; the call id is in `raw`.
      return [builder.malformed('a tool result for a call no tool call announced', raw)];
    }
    announced.delete(callId);
    const error = payload['error'];
    const isError = failed || payload['isError'] === true;
    const output = failed
      ? isRecord(error) && typeof error['message'] === 'string'
        ? error['message']
        : resultText(error)
      : resultText(payload['result']);
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

  function mapCompleted(event: Extract<MastraEvent, { kind: 'run_completed' }>): EngineFrame[] {
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
          turns: event.steps,
          // Any cost here would be the provisional table's, not the engine's own figure; billing is
          // the gateway's `run_usage_records` (ADR-0065 D6).
          engineCostUsd: null,
          ...(event.output === undefined ? {} : { output: event.output }),
        },
        event,
      ),
    );
    return frames;
  }

  function mapChunk(chunk: Readonly<Record<string, unknown>>, raw: MastraEvent): EngineFrame[] {
    const type = chunk['type'];
    if (typeof type !== 'string') return [builder.malformed('a Mastra chunk without a type', raw)];
    const payload = isRecord(chunk['payload']) ? chunk['payload'] : {};
    switch (type) {
      case 'text-delta':
        return mapDelta(payload, 'text', raw);
      case 'reasoning-delta':
        return mapDelta(payload, 'reasoning', raw);
      case 'text-end':
        return mapEnd(payload, 'text', raw);
      case 'reasoning-end':
        return mapEnd(payload, 'reasoning', raw);
      case 'tool-call':
        return mapToolCall(payload, raw);
      case 'tool-result':
        return mapToolAnswer(payload, false, raw);
      case 'tool-error':
        return mapToolAnswer(payload, true, raw);
      case 'error':
        return [
          builder.result(
            { frame: 'agent.result', stopReason: 'error', turns: steps, engineCostUsd: null },
            raw,
          ),
        ];
      case 'step-finish':
        steps += 1;
        return [builder.native(type, raw)];
      default:
        return [builder.native(type, raw)];
    }
  }

  return {
    map(event) {
      if (event.kind === 'run_completed') return mapCompleted(event);
      if (!isRecord(event.chunk))
        return [builder.malformed('a Mastra chunk that is not an object', event)];
      return mapChunk(event.chunk, event);
    },
  };
}
