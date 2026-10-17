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

export function createAnthropicUsageAccumulator(): UsageAccumulator {
  let responseId: string | null = null;
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let toolCalls = 0;
  let metered = false;
  let completed = false;

  return {
    observe(event: Record<string, unknown>): void {
      // Anthropic's two ways of saying "this is the whole response": the streamed terminal event,
      // and the non-streaming body, whose discriminator is `type: 'message'`.
      if (event['type'] === 'message_stop' || event['type'] === 'message') completed = true;
      const message = isRecord(event['message']) ? event['message'] : null;
      const usage = isRecord(event['usage'])
        ? event['usage']
        : message !== null && isRecord(message['usage'])
          ? message['usage']
          : null;
      const id = nonEmptyString(message?.['id'] ?? event['id']);
      if (responseId === null && id !== null) responseId = id;
      const reportedModel = nonEmptyString(message?.['model'] ?? event['model']);
      if (reportedModel !== null) model = reportedModel;

      if (usage !== null) {
        metered = true;
        const count = (snake: string, camel: string): number =>
          counter(usage[snake] ?? usage[camel]);
        // Streaming providers report cumulative snapshots split across message_start and
        // message_delta. Max merges those snapshots without charging an earlier frame twice.
        inputTokens = Math.max(inputTokens, count('input_tokens', 'inputTokens'));
        outputTokens = Math.max(outputTokens, count('output_tokens', 'outputTokens'));
        cacheReadInputTokens = Math.max(
          cacheReadInputTokens,
          count('cache_read_input_tokens', 'cacheReadInputTokens'),
        );
        cacheCreationInputTokens = Math.max(
          cacheCreationInputTokens,
          count('cache_creation_input_tokens', 'cacheCreationInputTokens'),
        );
      }

      const content = Array.isArray(event['content'])
        ? event['content']
        : message !== null && Array.isArray(message['content'])
          ? message['content']
          : [];
      toolCalls += content.filter(
        (block) => isRecord(block) && TOOL_BLOCK_TYPES.has(block['type']),
      ).length;
      if (
        event['type'] === 'content_block_start' &&
        isRecord(event['content_block']) &&
        TOOL_BLOCK_TYPES.has(event['content_block']['type'])
      ) {
        toolCalls += 1;
      }
    },
    snapshot(): ExtractedUsage {
      return {
        responseId,
        model,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        toolCalls,
        metered,
        completed,
      };
    },
  };
}
