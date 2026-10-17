/**
 * OpenAI Chat Completions usage extraction (ADR-0068 D5).
 *
 * A streamed Chat Completions response reports `usage` only on its final chunk, and only when the
 * request carried `stream_options.include_usage` — which the gateway injects for exactly this
 * reason (see `providers/passthrough.ts`). A non-streaming body reports it directly.
 */
import {
  isRecord,
  measuredUsage,
  nonEmptyString,
  type ExtractedUsage,
  type UsageAccumulator,
} from './accumulator.js';

/**
 * One tool call's identity within the response. A streamed call's arguments arrive as many deltas
 * that all repeat the same `(choice index, tool_calls[].index)` pair, so counting deltas would
 * count one call many times over.
 */
function toolCallIdentity(choiceIndex: number, callIndex: number): string {
  return `${String(choiceIndex)}:${String(callIndex)}`;
}

/** The reported index when the upstream sent a usable one, else the entry's array position. */
function reportedIndex(value: unknown, position: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : position;
}

export function createChatCompletionsUsageAccumulator(): UsageAccumulator {
  let responseId: string | null = null;
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let metered = false;
  let completed = false;
  const toolCalls = new Set<string>();

  const observeChoice = (choice: unknown, position: number): void => {
    if (!isRecord(choice)) return;
    // The upstream's own end-of-turn marker, present on both the streamed and the whole shape.
    if (nonEmptyString(choice['finish_reason']) !== null) completed = true;
    const choiceIndex = reportedIndex(choice['index'], position);
    // `delta` on a streamed chunk, `message` on a non-streaming body.
    const carrier = isRecord(choice['delta'])
      ? choice['delta']
      : isRecord(choice['message'])
        ? choice['message']
        : null;
    const calls = carrier === null ? undefined : carrier['tool_calls'];
    if (!Array.isArray(calls)) return;
    calls.forEach((call, callPosition) => {
      if (!isRecord(call)) return;
      toolCalls.add(toolCallIdentity(choiceIndex, reportedIndex(call['index'], callPosition)));
    });
  };

  return {
    observe(event: Record<string, unknown>): void {
      const id = nonEmptyString(event['id']);
      if (responseId === null && id !== null) responseId = id;
      const reportedModel = nonEmptyString(event['model']);
      if (reportedModel !== null) model = reportedModel;

      // A non-streaming body is the whole response by definition; a chunk never is.
      if (event['object'] === 'chat.completion') completed = true;
      const choices = event['choices'];
      if (Array.isArray(choices)) choices.forEach(observeChoice);

      // `usage` is explicitly `null` on every chunk but the last, so the record check is the test.
      const usage = event['usage'];
      if (!isRecord(usage)) return;
      // Present but unusable counts are not a measurement, so `metered` stays false and the run
      // settles `unavailable` rather than priced at zero (ADR-0068 D9).
      const measured = measuredUsage(
        usage,
        'prompt_tokens',
        'completion_tokens',
        'prompt_tokens_details',
      );
      if (measured === null) return;
      metered = true;
      // `prompt_tokens` INCLUDES the cached prefix; `pricing.ts` charges input and cache reads as
      // separate additive terms. See the same correction in `responses.ts`.
      inputTokens = Math.max(inputTokens, Math.max(0, measured.input - measured.cached));
      cacheReadInputTokens = Math.max(cacheReadInputTokens, measured.cached);
      // `completion_tokens_details.reasoning_tokens` is already inside `completion_tokens`.
      outputTokens = Math.max(outputTokens, measured.output);
    },
    snapshot(): ExtractedUsage {
      return {
        responseId,
        model,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens: 0,
        toolCalls: toolCalls.size,
        metered,
        completed,
      };
    },
  };
}
