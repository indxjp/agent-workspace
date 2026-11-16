/**
 * Anthropic Messages usage extraction, moved here from `auth.ts` behaviour-for-behaviour when the
 * gateway grew two more dialects (ADR-0068 D5). Nothing about the arithmetic changed; only the
 * events now arrive one at a time rather than out of a buffered string.
 */
import {
  counter,
  isRecord,
  nonEmptyString,
  type ExtractedUsage,
  type UsageAccumulator,
} from './accumulator.js';

const TOOL_BLOCK_TYPES: ReadonlySet<unknown> = new Set(['tool_use', 'tool_call']);

type JsonObject = Record<string, unknown>;

type TokenCounts = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
};

const NO_TOKENS: TokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

const isToolBlock = (block: unknown): boolean =>
  isRecord(block) && TOOL_BLOCK_TYPES.has(block['type']);

/** The `usage` object of an event, whether it sits on the event or inside its `message`. */
function usageOf(event: JsonObject, message: JsonObject | null): JsonObject | null {
  if (isRecord(event['usage'])) return event['usage'];
  return message !== null && isRecord(message['usage']) ? message['usage'] : null;
}

/** The content blocks of an event, whether they sit on the event or inside its `message`. */
function contentOf(event: JsonObject, message: JsonObject | null): readonly unknown[] {
  if (Array.isArray(event['content'])) return event['content'];
  return message !== null && Array.isArray(message['content']) ? message['content'] : [];
}

/** Tool-use blocks announced by this event: finished ones in its content, or a block starting. */
function toolCallsIn(event: JsonObject, message: JsonObject | null): number {
  const finished = contentOf(event, message).filter(isToolBlock).length;
  const starting = event['type'] === 'content_block_start' && isToolBlock(event['content_block']);
  return finished + (starting ? 1 : 0);
}

/** Token counts of one `usage` object, accepting both snake_case and camelCase spellings. */
function tokenCounts(usage: JsonObject): TokenCounts {
  const count = (snake: string, camel: string): number => counter(usage[snake] ?? usage[camel]);
  return {
    inputTokens: count('input_tokens', 'inputTokens'),
    outputTokens: count('output_tokens', 'outputTokens'),
    cacheReadInputTokens: count('cache_read_input_tokens', 'cacheReadInputTokens'),
    cacheCreationInputTokens: count('cache_creation_input_tokens', 'cacheCreationInputTokens'),
  };
}

const isAllZero = (counts: TokenCounts): boolean =>
  counts.inputTokens === 0 &&
  counts.outputTokens === 0 &&
  counts.cacheReadInputTokens === 0 &&
  counts.cacheCreationInputTokens === 0;

/**
 * Streaming providers report cumulative snapshots split across message_start and message_delta.
 * Max merges those snapshots without charging an earlier frame twice.
 */
function mergeCounts(total: TokenCounts, reported: TokenCounts): TokenCounts {
  return {
    inputTokens: Math.max(total.inputTokens, reported.inputTokens),
    outputTokens: Math.max(total.outputTokens, reported.outputTokens),
    cacheReadInputTokens: Math.max(total.cacheReadInputTokens, reported.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(
      total.cacheCreationInputTokens,
      reported.cacheCreationInputTokens,
    ),
  };
}

export function createAnthropicUsageAccumulator(): UsageAccumulator {
  let responseId: string | null = null;
  let model: string | null = null;
  let totals = NO_TOKENS;
  let toolCalls = 0;
  let metered = false;
  let completed = false;

  return {
    observe(event: JsonObject): void {
      // Anthropic's two ways of saying "this is the whole response": the streamed terminal event,
      // and the non-streaming body, whose discriminator is `type: 'message'`.
      if (event['type'] === 'message_stop' || event['type'] === 'message') completed = true;
      const message = isRecord(event['message']) ? event['message'] : null;
      const id = nonEmptyString(message?.['id'] ?? event['id']);
      if (responseId === null && id !== null) responseId = id;
      model = nonEmptyString(message?.['model'] ?? event['model']) ?? model;

      const usage = usageOf(event, message);
      if (usage !== null) {
        const reported = tokenCounts(usage);
        // A translated stream opens with a placeholder all-zero `message_start` (the upstream has
        // not counted yet). That is not a measurement: only a later frame may mark it metered.
        const placeholder = event['type'] === 'message_start' && isAllZero(reported);
        if (!placeholder) metered = true;
        totals = mergeCounts(totals, reported);
      }
      toolCalls += toolCallsIn(event, message);
    },
    snapshot(): ExtractedUsage {
      return { responseId, model, ...totals, toolCalls, metered, completed };
    },
  };
}
