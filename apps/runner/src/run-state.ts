import type { RunnerAgentConnection } from './runtime.js';

export // ── The three endpoints ─────────────────────────────────────────────────────────────────

/** One run this runner process is serving. */
type InFlight = {
  readonly runId: string;
  readonly sessionId: string;
  readonly connection: RunnerAgentConnection;
  interrupted: boolean;
};

/**
 * A run this runner has admitted: the admission checks passed and the slot is held, whether or
 * not its engine has started yet. Kept apart from {@link InFlight} because a run is admitted
 * before it has a connection to interrupt — `startAgent` is asynchronous (the registry's dynamic
 * `import()`), and the slot must be held across that `await`.
 */
export type Admitted = {
  readonly runId: string;
  readonly sessionId: string;
  /** `/interrupt` arrived while the engine was still starting; applied once it has started. */
  interruptRequested: boolean;
};

export type RunnerState = {
  /** Every admitted run — starting or streaming. The admission checks read this map only. */
  readonly admitted: Map<string, Admitted>;
  /** The admitted runs whose engine has started, which are the ones an interrupt can reach. */
  readonly runs: Map<string, InFlight>;
  readonly maxConcurrentRuns: number;
};
