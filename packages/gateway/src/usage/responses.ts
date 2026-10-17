/**
 * OpenAI Responses usage extraction (ADR-0068 D5).
 *
 * Usage lives on the terminal snapshot only. Three event types carry one — `response.completed`,
 * and `response.incomplete` / `response.failed`, which is how a stream that ended early still
 * reports what it spent — and a non-streaming body *is* that snapshot.
 */
import {
  counter,
  isRecord,
  measuredUsage,
  nonEmptyString,
  type ExtractedUsage,
  type UsageAccumulator,
} from './accumulator.js';

/**
 * Events that carry a whole `response` object. The three terminal ones are where usage lives;
 * `response.created` is included so a stream cut before its terminal frame has still named its
 * model and id.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
]);

const SNAPSHOT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'response.created',
  ...TERMINAL_EVENT_TYPES,
]);

/**
 * The output item types that are one relayed tool call each.
 *
 * Both tool types the hosted-tool allowlist admits appear here, because the two rules were written
 * from the same ADR decision and have to agree on what a tool call is: a `function` tool invocation
 * arrives as `function_call` and a `custom` one as `custom_tool_call`
 * (`providers/passthrough.ts`'s `RELAYABLE_TOOL_TYPES`). Counting only the former under-reports
 * `run_usage_records.tool_calls` to zero for a run whose whole tool surface is custom tools.
 */
const FUNCTION_CALL_ITEM_TYPES: ReadonlySet<unknown> = new Set([
  'function_call',
  'custom_tool_call',
]);

/**
 * A relayed tool call's identity. The upstream's own item id when it supplied one, otherwise
 * the item's position — the point is that observing the same item twice cannot inflate the count.
 */
function itemIdentity(item: Record<string, unknown>, position: number): string {
  return nonEmptyString(item['id']) ?? `#${String(position)}`;
}

export function createResponsesUsageAccumulator(): UsageAccumulator {
  let responseId: string | null = null;
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let metered = false;
  let completed = false;
  // One set fed from both sources: the streamed `response.output_item.done` events and the terminal
  // snapshot's `output`, which repeats every item. Keying by identity is what stops the snapshot
  // double-counting calls the stream already reported.
  const functionCalls = new Set<string>();

  const observeSnapshot = (snapshot: Record<string, unknown>): void => {
    const id = nonEmptyString(snapshot['id']);
    if (responseId === null && id !== null) responseId = id;
    const reportedModel = nonEmptyString(snapshot['model']);
    if (reportedModel !== null) model = reportedModel;

    const output = snapshot['output'];
    if (Array.isArray(output)) {
      output.forEach((item, position) => {
        if (isRecord(item) && FUNCTION_CALL_ITEM_TYPES.has(item['type'])) {
          functionCalls.add(itemIdentity(item, position));
        }
      });
    }

    const usage = snapshot['usage'];
    if (!isRecord(usage)) return;
    // Present but unusable counts are not a measurement, so `metered` stays false and the run
    // settles `unavailable` rather than priced at zero (ADR-0068 D9).
    const measured = measuredUsage(usage, 'input_tokens', 'output_tokens', 'input_tokens_details');
    if (measured === null) return;
    metered = true;
    // OpenAI's `input_tokens` INCLUDES the cached prefix, while `pricing.ts` charges input and
    // cache reads as separate additive terms (Anthropic's convention, where it does not). Without
    // this subtraction every cached request is billed twice for its prefix.
    inputTokens = Math.max(inputTokens, Math.max(0, measured.input - measured.cached));
    cacheReadInputTokens = Math.max(cacheReadInputTokens, measured.cached);
    // `output_tokens_details.reasoning_tokens` is already inside `output_tokens`, so it is added
    // nowhere: that is what "reasoning tokens are priced as output tokens" means.
    outputTokens = Math.max(outputTokens, measured.output);
  };

  return {
    observe(event: Record<string, unknown>): void {
      const type = event['type'];
      if (typeof type !== 'string') {
        // Not an SSE frame: a non-streaming Responses body, which is the snapshot itself.
        completed = true;
        observeSnapshot(event);
        return;
      }
      if (TERMINAL_EVENT_TYPES.has(type)) completed = true;
      if (type === 'response.output_item.done' && isRecord(event['item'])) {
        const item = event['item'];
        if (FUNCTION_CALL_ITEM_TYPES.has(item['type'])) {
          functionCalls.add(itemIdentity(item, counter(event['output_index'])));
        }
        return;
      }
      if (SNAPSHOT_EVENT_TYPES.has(type) && isRecord(event['response'])) {
        observeSnapshot(event['response']);
      }
    },
    snapshot(): ExtractedUsage {
      return {
        responseId,
        model,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        // OpenAI reports cache reads but never a cache-write class of its own.
        cacheCreationInputTokens: 0,
        toolCalls: functionCalls.size,
        metered,
        completed,
      };
    },
  };
}
