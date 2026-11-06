import { RUNTIME_CAPACITY_EXHAUSTED } from '@indx-workspace/contracts/runs';
import { z } from 'zod';
import { publicRunFailure } from './failures';
import { STOPPED_WHILE_LIVE } from './launcher-outcomes';

export const DEFAULT_CAPACITY_MAX_WAIT_MS = 120_000;

export const DEFAULT_CAPACITY_INITIAL_DELAY_MS = 250;

export const DEFAULT_CAPACITY_MAX_DELAY_MS = 5_000;

const CAPACITY_REFUSAL_MAX_BYTES = 16 * 1024;

const CAPACITY_EXHAUSTED_FAILURE = `${RUNTIME_CAPACITY_EXHAUSTED}: The runtime is serving its maximum number of concurrent runs; send the message again in a moment.`;

/*
 * Runtime capacity (issue #557). `apps/runner` admits a bounded number of concurrent runs and
 * refuses the next one at admission, before any side effect, with
 * `429 {"error":"runner_capacity_exhausted","message":"… retry when capacity is available"}`.
 * Re-posting the same RunRequest is therefore safe, and the launcher waits for a slot instead of
 * failing a widget conversation outright. Only that exact refusal is waited on: any other 429, a
 * 5xx or a non-SSE answer still goes to `relayRunnerStream` and fails the run as before, so a real
 * error is never hidden behind a retry.
 */
const RunnerCapacityRefusalSchema = z
  .object({ error: z.literal('runner_capacity_exhausted'), message: z.string() })
  .strict();

export interface CapacityRetry {
  readonly maxWaitMs: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

interface CapacityRefusal {
  /** The runtime's own `Retry-After`, in milliseconds, or `null` when it sent none usable. */
  readonly retryAfterMs: number | null;
}

/**
 * Read a `429` answer and say whether it is the runner's capacity refusal. The body is consumed
 * or cancelled either way, so the connection is released; an oversized, unreadable or
 * non-matching body is not a capacity refusal, and the response then fails the run as before.
 */
async function readCapacityRefusal(response: Response): Promise<CapacityRefusal | null> {
  if (response.status !== 429 || response.body === null) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > CAPACITY_REFUSAL_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    if (!RunnerCapacityRefusalSchema.safeParse(parsed).success) return null;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const retryAfter = response.headers.get('retry-after')?.trim() ?? '';
  return { retryAfterMs: /^\d+$/u.test(retryAfter) ? Number(retryAfter) * 1_000 : null };
}

/**
 * Exponential backoff with full jitter, never shorter than the runtime's own `Retry-After`, never
 * longer than `maxDelayMs` and never past `remainingMs`. `Retry-After` is only a lower bound: a
 * `Retry-After: 0` (from a proxy, or a future runner) must not remove the backoff and turn every
 * waiting run into a tight re-POST loop against a runtime that is already full.
 */
function capacityDelayMs(
  attempt: number,
  refusal: CapacityRefusal,
  retry: CapacityRetry,
  remainingMs: number,
): number {
  const backoff = Math.random() * Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** attempt);
  const delay = Math.min(Math.max(refusal.retryAfterMs ?? 0, backoff), retry.maxDelayMs);
  return Math.max(0, Math.min(delay, remainingMs));
}

/** Wait `ms`, or less if `signal` aborts first. Never rejects: the caller checks why it woke. */
function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface RunPostAttempts {
  readonly doFetch: typeof globalThis.fetch;
  readonly url: string;
  readonly init: Omit<RequestInit, 'signal'>;
  readonly connectTimeoutMs: number;
  readonly lifetime: AbortSignal;
  readonly lifetimeExpired: () => boolean;
  /** Whether the cancellation watch saw the run stopped by someone else and aborted `lifetime`. */
  readonly stoppedElsewhere: () => boolean;
  readonly lifetimeFailure: string;
  readonly retry: CapacityRetry;
  readonly stillRunning: () => Promise<boolean>;
  readonly revokeRunTokens: () => Promise<void>;
}

type RunPostResult =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'stopped'; readonly status: 'failed' | 'cancelled'; readonly error: string };

/**
 * `POST {base}/run`, waiting for runtime capacity (issue #557).
 *
 * One POST per turn, and only the runner's capacity refusal turns again: every other answer is
 * returned for `relayRunnerStream` to judge. Each attempt has its own connect deadline, which
 * covers the headers only (see the launcher's comment on `AbortSignal.timeout`). The run stays
 * `running` while it waits, the credential-bounded lifetime keeps running across the whole wait,
 * and an interrupt that makes the run terminal ends the wait without another POST.
 */
export async function postRunAwaitingCapacity(attempts: RunPostAttempts): Promise<RunPostResult> {
  const deadline = Date.now() + attempts.retry.maxWaitMs;
  for (let attempt = 0; ; attempt += 1) {
    const connect = new AbortController();
    const timer = setTimeout(
      () =>
        connect.abort(
          new Error(`the runtime did not respond within ${String(attempts.connectTimeoutMs)}ms`),
        ),
      attempts.connectTimeoutMs,
    );
    (timer as { unref?: () => void }).unref?.();
    let response: Response;
    let refusal: CapacityRefusal | null;
    try {
      response = await attempts.doFetch(attempts.url, {
        ...attempts.init,
        signal: AbortSignal.any([connect.signal, attempts.lifetime]),
      });
      refusal = await readCapacityRefusal(response);
    } catch (cause) {
      if (attempts.stoppedElsewhere()) {
        return { kind: 'stopped', status: 'cancelled', error: STOPPED_WHILE_LIVE };
      }
      const error = attempts.lifetimeExpired()
        ? attempts.lifetimeFailure
        : publicRunFailure(cause, {
            operation: 'start-runtime-run',
            failureKind: 'upstream',
            publicMessage: 'The runtime could not be reached.',
          });
      return { kind: 'stopped', status: 'failed', error };
    } finally {
      clearTimeout(timer);
    }
    if (refusal === null) return { kind: 'response', response };

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const error = publicRunFailure(
        new Error(
          `the runtime stayed at its concurrent-run capacity for ${String(attempts.retry.maxWaitMs)}ms over ${String(attempt + 1)} attempts`,
        ),
        {
          operation: 'await-runtime-capacity',
          failureKind: 'upstream',
          publicMessage: CAPACITY_EXHAUSTED_FAILURE,
        },
      );
      return { kind: 'stopped', status: 'failed', error };
    }
    await waitUnlessAborted(
      capacityDelayMs(attempt, refusal, attempts.retry, remainingMs),
      attempts.lifetime,
    );
    if (attempts.lifetimeExpired()) {
      return { kind: 'stopped', status: 'failed', error: attempts.lifetimeFailure };
    }
    let stillRunning: boolean;
    try {
      stillRunning = await attempts.stillRunning();
    } catch (cause) {
      // The store could not say whether an interrupt landed during the wait. Posting anyway could
      // hand a cancelled run's credential to the runtime, and letting the error escape would skip
      // every terminal write and leave the run `running` for good. So post nothing more, revoke
      // the run's tokens, and fail the run through the caller's normal `conclude`.
      await attempts.revokeRunTokens();
      const error = publicRunFailure(cause, {
        operation: 'read-run-status',
        publicMessage: 'The run status could not be read while it waited for runtime capacity.',
      });
      return { kind: 'stopped', status: 'failed', error };
    }
    if (!stillRunning) {
      // An interrupt landed during the wait: post nothing more, and leave no live credential
      // behind, as for an interrupt that lands while the run is still queued. `finish` is
      // first-call-wins, so the stored status and error stay the interrupt's.
      await attempts.revokeRunTokens();
      return {
        kind: 'stopped',
        status: 'cancelled',
        error: INTERRUPTED_DURING_CAPACITY_WAIT,
      };
    }
  }
}

/**
 * The stored error of a run interrupted while it waited for runtime capacity. It is a named
 * constant, not an inline string on the error field, because it is a run record's error text and
 * not an HTTP body: the envelope sweep (`error-envelope-inventory.test.ts`) refuses the bare-code
 * body shape in server sources.
 */
const INTERRUPTED_DURING_CAPACITY_WAIT =
  'the run was interrupted while it waited for runtime capacity';
