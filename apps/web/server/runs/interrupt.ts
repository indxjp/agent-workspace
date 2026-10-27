/**
 * The live-run registry and the private runtime interrupt signal (issue #235, S-14).
 *
 * **Why a registry, and why anchored on `globalThis`.** `POST /api/runs/:id/interrupt` can land on
 * any replica, and only the replica whose launcher closure is actually holding the run's runtime
 * connection knows the runtime's base URL and its private authentication headers — neither is
 * persisted anywhere (`environment.ts`'s own header: "there is no durable way, today, for an
 * arbitrary replica to address the runtime that is executing a given run"). This registry is that
 * one process's address book, populated by `launcher.ts` for exactly the runs it is holding.
 *
 * It is anchored on `globalThis` rather than a module-level `let` for the same reason
 * `environment.ts`'s own registry is: Next.js compiles `instrumentation.ts` (where the launcher is
 * built) and the route handlers (where an interrupt is served) into separate module graphs, and
 * only a `globalThis` property is shared by every bundle in one Node process.
 *
 * **Best effort, by design.** A run this process is not holding — a different replica, or a run
 * that already ended — has no entry, and {@link signalLiveRun} then does nothing rather than fail
 * the request: the control-plane transition (terminal status, token revocation) is the security
 * boundary and always happens; this signal is the courtesy that stops the runtime sooner when it
 * can be reached at all. See `docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md`.
 */
import { defineSlot } from '../runtime-slot';
import { publicRunFailure } from './failures';

/** What a launcher knows about the runtime holding one run, while it holds it. */
export interface LiveRunHandle {
  /** `POST {base}/interrupt` is the runner's own §14.3 contract. */
  readonly base: string;
  /** Private runner-manager authentication, the same headers the launcher's own requests carry. */
  readonly headers: Readonly<Record<string, string>>;
  /** Stops what the launcher still does for the run on this process (its storage write-back). */
  readonly onInterrupt?: () => void;
}

const registry = defineSlot<Map<string, LiveRunHandle>>('__agentWorkspaceLiveRuns__');

/**
 * How long the courtesy signal may hold the caller's request open.
 *
 * `POST /api/runs/:id/interrupt` awaits this fetch, and by the time it runs the durable half of
 * the interrupt — terminal status and token revocation — is already committed. A runtime that has
 * stopped answering but still holds the connection open (a blackholed container, a stuck sandbox)
 * must therefore not hold the interrupt request open with it: past this deadline the signal has
 * failed and the failure is reported as the upstream failure it is.
 */
const INTERRUPT_SIGNAL_TIMEOUT_MS = 5_000;

function liveRuns(): Map<string, LiveRunHandle> {
  return registry.getOrCreate(() => new Map());
}

/** Record that this process is holding `runId`'s runtime connection. Called once `base` is known. */
export function registerLiveRun(runId: string, handle: LiveRunHandle): void {
  liveRuns().set(runId, handle);
}

/** Forget `runId`. Called from the launcher's finalisation path, whatever the run's outcome. */
export function releaseLiveRun(runId: string): void {
  liveRuns().delete(runId);
}

/** For tests: a registry that leaked between cases would make one test's run visible to another. */
export function resetLiveRuns(): void {
  liveRuns().clear();
}

/**
 * Raise the runner's private `POST {base}/interrupt` (§14.3). Never throws: a runtime that cannot
 * be reached is reported to server diagnostics and otherwise ignored, because the caller of this
 * function has already made the run terminal on the control-plane side — see this file's header.
 *
 * Bounded by {@link INTERRUPT_SIGNAL_TIMEOUT_MS}; `timeoutMs` overrides it so a test can prove the
 * deadline fires without waiting for it. Unlike the launcher's own runtime fetch, an
 * `AbortSignal.timeout` is right here: this response is a small acknowledgement that is never
 * streamed, so the signal cannot outlive the request and abort a run in progress.
 */
export async function signalRuntimeInterrupt(
  base: string,
  runId: string,
  headers: Readonly<Record<string, string>>,
  doFetch: typeof globalThis.fetch,
  timeoutMs: number = INTERRUPT_SIGNAL_TIMEOUT_MS,
): Promise<void> {
  try {
    const response = await doFetch(`${base.replace(/\/+$/, '')}/interrupt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 409 `no_run_in_flight` / `run_mismatch` is the runner saying it is not holding this run —
    // a signal that did not land, and only this log can say so.
    if (!response.ok) {
      throw new Error(`the runtime refused the interrupt with HTTP ${String(response.status)}`);
    }
  } catch (cause) {
    publicRunFailure(cause, {
      operation: 'interrupt-runtime',
      failureKind: 'upstream',
      publicMessage: 'The runtime could not be interrupted.',
    });
  }
}

/**
 * Signal the runtime holding `runId`, if this process is the one holding it. Resolves immediately,
 * with no signal raised, when it is not — the best-effort half of this file's header.
 */
export function signalLiveRun(runId: string, doFetch: typeof globalThis.fetch): Promise<void> {
  const handle = liveRuns().get(runId);
  if (handle === undefined) return Promise.resolve();
  handle.onInterrupt?.();
  return signalRuntimeInterrupt(handle.base, runId, handle.headers, doFetch);
}
