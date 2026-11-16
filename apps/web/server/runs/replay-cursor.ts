import type { StreamResetNotice } from './store';

export function resolveReplayCursor(
  runId: string,
  after: bigint | null,
  bounds: { readonly oldest: bigint; readonly latest: bigint } | null,
): { readonly cursor: bigint; readonly reset: StreamResetNotice | null } {
  let cursor = after ?? 0n;
  let reset: StreamResetNotice | null = null;
  if (bounds === null && after !== null && after > 0n) {
    reset = {
      reason: `run ${runId} has no event after ${String(after)} (its latest id is 0); the stream restarts from the oldest retained event`,
      resumedAfter: null,
    };
    cursor = 0n;
  } else if (bounds !== null && cursor < bounds.oldest - 1n) {
    reset = {
      reason:
        after === null
          ? `the beginning of run ${runId}'s event log is no longer retained; the stream starts at the oldest retained event`
          : `events after ${String(cursor)} are no longer retained for run ${runId}; the stream resumes at the oldest retained event and is not contiguous with what you already have`,
      resumedAfter: String(bounds.oldest - 1n),
    };
    cursor = bounds.oldest - 1n;
  } else if (bounds !== null && after !== null && after > bounds.latest) {
    reset = {
      reason: `run ${runId} has no event after ${String(after)} (its latest id is ${String(bounds.latest)}); the stream restarts from the oldest retained event`,
      resumedAfter: String(bounds.oldest - 1n),
    };
    cursor = bounds.oldest - 1n;
  }

  return { cursor, reset };
}
