/**
 * The shape every per-protocol usage extractor produces, and the numeric helpers they share.
 *
 * An accumulator absorbs one decoded event at a time and never holds the events themselves, which
 * is what lets `auth.ts` meter a streamed response without buffering it (ADR-0068 D5).
 */

export type ExtractedUsage = {
  /** The upstream's own response id, when it reported one. */
  readonly responseId: string | null;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly toolCalls: number;
  /**
   * An authoritative usage frame was seen. False means the counters are absent, not zero: the
   * caller settles that case as unpriced (`unavailable`) or failed rather than as a measured zero.
   */
  readonly metered: boolean;
  /**
   * The upstream declared this response finished, in its own dialect's terms — `message_stop`, one
   * of the Responses terminal events, a `finish_reason`, or a non-streaming body.
   *
   * It is what separates the two unmetered outcomes (ADR-0068 D9): a response that finished without
   * reporting usage is recorded at unpriced zeros, while a stream that stopped before any terminal
   * frame is a settlement failure.
   */
  readonly completed: boolean;
};

export interface UsageAccumulator {
  /** Absorb one SSE `data:` payload, or one whole non-streaming response body. */
  observe(event: Record<string, unknown>): void;
  /** The counters implied by everything observed so far. */
  snapshot(): ExtractedUsage;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A non-negative safe integer, or 0. Provider JSON is untrusted at this boundary. */
export function counter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Provider JSON omits a field it has nothing to say about, and spells the same thing `null`. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * A counter the provider actually reported, distinguishing "absent" (`0`) from "present but
 * unusable" (`null`) — a string `"90"`, a fraction, a negative.
 */
function reportedCounter(value: unknown): number | null {
  if (isAbsent(value)) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** One dialect's `usage` counters, as reported: `input` still includes the cached prefix. */
type MeasuredUsage = {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
};

/**
 * The counters of one provider `usage` object, or `null` when the object is not a measurement.
 *
 * `inputKey` and `outputKey` name this dialect's two primary token counters and `cachedGroup` the
 * detail object carrying the cached prefix. The report counts as a measurement only when at least
 * one primary counter is present and every field that *is* present parses as a non-negative safe
 * integer. An `openai-compatible` upstream reporting `{"prompt_tokens": "90"}`, or a bare `{}`,
 * measured nothing: reading either as zeros would settle the run `complete` at a cost
 * indistinguishable from a genuinely free turn instead of `unavailable`, and a zero claimed for a
 * count that was never read is exactly the fabricated count ADR-0068 D9 forbids.
 */
export function measuredUsage(
  usage: Record<string, unknown>,
  inputKey: string,
  outputKey: string,
  cachedGroup: string,
): MeasuredUsage | null {
  if (isAbsent(usage[inputKey]) && isAbsent(usage[outputKey])) return null;
  const input = reportedCounter(usage[inputKey]);
  const output = reportedCounter(usage[outputKey]);
  const details = usage[cachedGroup];
  const cached = isAbsent(details)
    ? 0
    : isRecord(details)
      ? reportedCounter(details['cached_tokens'])
      : null;
  if (input === null || output === null || cached === null) return null;
  return { input, output, cached };
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
