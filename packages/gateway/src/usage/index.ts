/**
 * Per-protocol usage extraction (ADR-0068 D5): one accumulator per wire protocol, and the one
 * function that drives a provider response through it without buffering a stream.
 */
import type { WireProtocol } from '../types.js';
import { isRecord, type ExtractedUsage, type UsageAccumulator } from './accumulator.js';
import { createAnthropicUsageAccumulator } from './anthropic.js';
import { createChatCompletionsUsageAccumulator } from './chat-completions.js';
import { createResponsesUsageAccumulator } from './responses.js';
import { readServerSentEvents } from './sse.js';

export type { ExtractedUsage, UsageAccumulator } from './accumulator.js';
export { readServerSentEvents } from './sse.js';

/** The extractor for one dialect. Exhaustive over {@link WireProtocol} by construction. */
export function createUsageAccumulator(protocol: WireProtocol): UsageAccumulator {
  switch (protocol) {
    case 'anthropic-messages':
      return createAnthropicUsageAccumulator();
    case 'openai-responses':
      return createResponsesUsageAccumulator();
    case 'openai-chat-completions':
      return createChatCompletionsUsageAccumulator();
  }
}

/** Replay a recorded event sequence through one protocol's extractor. The pure core, used by the
 * unit tests and by the `gateway-ingress` vector replay. */
export function extractUsageFromEvents(
  protocol: WireProtocol,
  events: readonly Record<string, unknown>[],
): ExtractedUsage {
  const accumulator = createUsageAccumulator(protocol);
  for (const event of events) accumulator.observe(event);
  return accumulator.snapshot();
}

function observeJson(accumulator: UsageAccumulator, payload: string): void {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    // A partial frame from an interrupted stream. Dropping it is the point: a truncated stream
    // settles as unmetered rather than inventing counts (ADR-0068 D9).
    return;
  }
  if (isRecord(value)) accumulator.observe(value);
}

/**
 * Extract usage from a provider response.
 *
 * A `text/event-stream` body is read incrementally, so only the line being assembled and the
 * counters are ever held. A non-streaming body is parsed whole — it has to be, JSON has no
 * meaningful prefix — but the provider client has already materialised it by then.
 */
export async function extractResponseUsage(
  response: Response,
  protocol: WireProtocol,
): Promise<ExtractedUsage> {
  const accumulator = createUsageAccumulator(protocol);
  const isStream = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
  if (isStream && response.body !== null) {
    await readServerSentEvents(response.body, (payload) => observeJson(accumulator, payload));
    return accumulator.snapshot();
  }
  observeJson(accumulator, await response.text());
  return accumulator.snapshot();
}
