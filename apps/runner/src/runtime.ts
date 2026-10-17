/**
 * `apps/runner/src/runtime.ts` — the runner's side of the runtime boundary.
 *
 * One job: turn the run an **engine adapter** starts into the shape §14.2 calls an
 * `AgentConnection` — a frame stream, a session id, and a way to interrupt. `server.ts` streams
 * that shape over the §14.3 HTTP contract, and the `local` driver of §14.4 runs it in this
 * process.
 *
 * ## What ENG-04 (#303) changed here
 *
 * Until this unit `startLocalAgent` called `./claude.ts`'s `startRun` — this application
 * imported an SDK boundary, so "the runner" and "the Claude runner" were the same program. Now
 * it takes an {@link AgentEngine} and calls the port. Three consequences worth naming, because
 * each of them used to be a Claude-shaped assumption living in this file:
 *
 *   * the stream is `EngineFrame`, not `ClassifiedSdkEvent`. The adapter produces the neutral
 *     `agent.*` vocabulary; this file no longer knows an engine-native event exists, and
 *     `server.ts` no longer maps one.
 *   * the session id is read off an `agent.session` frame rather than off a `session_id` field
 *     the Claude SDK happens to put on every message.
 *   * the compile refusal arrives as a value. `startEngineAgent` answers
 *     {@link EngineStartOutcome} rather than throwing, because `server.ts` turns a refusal into
 *     a `run-error` frame carrying a stable code and a throw carries only a sentence.
 *
 * ## Why `RunnerAgentConnection` is still declared here
 *
 * `packages/runtime/src/driver.ts` declares `AgentConnection<TEvent>` with the same members.
 * This file does not import it, and the reason is unchanged from W1-RN-02: the two declarations
 * are structurally identical and nominally unrelated, which is a real duplication and is
 * declared as one. See `docs/adr/W1-RN-02-runtime-driver-is-generic.md`.
 */
import type { RunRequest } from '@agent-workspace/core';
import {
  withStoreWriteFailures,
  type AgentEngine,
  type EngineFrame,
  type EngineRefusalCode,
  type EngineRunRequest,
  type EngineStartContext,
  type SessionDurabilityVerdict,
} from '@agent-workspace/engine';

/**
 * §14.2's `AgentConnection`, for the runner, plus the one thing §14.9 makes a release blocker.
 *
 * `sessionDurability()` is not in the spec's printed interface and is not a fourth member of the
 * abstraction: it is this connection reporting what the adapter observed, so that the run's own
 * answer to *"can this conversation be resumed after the sandbox is gone?"* travels with the run
 * instead of being inferred later from its absence.
 */
export type RunnerAgentConnection = {
  /** The neutral `agent.*` frames. Nothing engine-native crosses this boundary (§42). */
  readonly frames: AsyncIterable<EngineFrame>;
  /**
   * The engine's session id **as the run reported it**, not as the request asked for it.
   *
   * Resolves from the first `agent.session` frame, and **rejects** if the stream ends without
   * one. There is no third outcome: a session id invented from the request would be the identity
   * §14.9 resumes a conversation by, asserted because nothing contradicted it.
   *
   * The rejection is pre-handled inside the adapter, so a caller that never awaits this promise
   * does not take the process down with an unhandled rejection.
   */
  readonly sessionId: Promise<string>;
  /**
   * Cancel the run.
   *
   * Resolving means *the cancellation signal has been raised*, not that the engine has exited.
   * The observable end of a run is its frame stream ending; a caller that needs to know the run
   * has actually stopped waits for that, and `server.ts` does.
   */
  interrupt(): Promise<void>;
  /** See {@link SessionDurabilityVerdict}. Meaningful once `frames` has been exhausted. */
  sessionDurability(): SessionDurabilityVerdict;
  /** The adapter's own version, reported on the run's terminal frame (`run-done`). */
  readonly engineVersion: string;
};

/**
 * What {@link startEngineAgent} answers.
 *
 * The refusal arm carries the port's own {@link EngineRefusalCode} — `engine_not_installed`,
 * `engine_policy_invalid`, `engine_credential_refused` — so `server.ts` can put a code on the
 * wire that a control plane branches on rather than a sentence it has to pattern-match.
 */
export type EngineStartOutcome =
  | { readonly ok: true; readonly connection: RunnerAgentConnection }
  | { readonly ok: false; readonly code: EngineRefusalCode; readonly reason: string };

/**
 * How `server.ts` starts a run. A parameter so a caller can substitute one; see `server.ts`.
 *
 * It takes the **private-contract** `RunRequest` rather than the port's `EngineRunRequest`, and
 * that is deliberate: a starter is also what materialises the run's granted files into the
 * sandbox (`apps/runner/src/index.ts`), and those bytes are on the contract's request and not on
 * the port's — the port hands an adapter grants, not content. Translating at the top of
 * `server.ts` instead would mean carrying the bytes through the port to reach the one function
 * that writes them.
 *
 * It is **async** because choosing an engine is a dynamic `import()` (`./engines.ts`). The
 * refusal it can answer with is a value, not a throw, so `server.ts` can put a stable code on
 * the wire.
 */
export type RunnerAgentStarter = (request: RunRequest) => Promise<EngineStartOutcome>;

/**
 * Start one agent in **this** process — the `local` driver of §14.4, and what the runtime image's
 * §14.3 server does inside its container.
 *
 * There is no isolation here and this function does not pretend otherwise; the honest statement
 * of what that means is `LOCAL_RUNTIME_CAPABILITIES` in `packages/runtime/src/local.ts`.
 *
 * `compile` is called **before** `start` and its refusal is returned rather than thrown. That
 * ordering is the invariant, not an optimisation: a run whose options could not be compiled must
 * not have started a subprocess, must not have written to the sandbox, and must not have emitted
 * a frame — which is what lets `server.ts` answer `engine_not_installed` and its siblings
 * *before any output*, as ENG-04's T2 invariant requires.
 */
export function startEngineAgent(
  engine: AgentEngine,
  request: EngineRunRequest,
  context: EngineStartContext = {},
): EngineStartOutcome {
  const compiled = engine.compile(request);
  if (!compiled.ok) return { ok: false, code: compiled.code, reason: compiled.reason };

  const connection = engine.start(request, context);
  // ENG-06 (#305): the verdict is the adapter's **and** the store's. An adapter can only report
  // what its own engine told it — for Claude, an `append()` rejection and a `system/mirror_error`
  // — so a store that dropped a write on an engine with no such signal would leave a run reported
  // durable when its state is not. `withStoreWriteFailures` is the fold, and it can only ever make
  // the verdict worse: a store with nothing to report returns the adapter's answer unchanged.
  // Bound, not read off the object: `{ ...store }` and an unbound method both lose `this`, and a
  // class-based store would then throw on first use (the same trap `instrumentSessionStore` names).
  const store = context.sessionStore;
  const storeFailures = store?.writeFailures?.bind(store);
  return {
    ok: true,
    connection: {
      frames: connection.frames,
      sessionId: connection.engineSessionId,
      interrupt: () => connection.interrupt(),
      sessionDurability: () =>
        storeFailures === undefined
          ? connection.sessionDurability()
          : withStoreWriteFailures(connection.sessionDurability(), storeFailures()),
      engineVersion: engine.version,
    },
  };
}

// ── §25: a distinct cwd / config directory per session, for whoever composes a request ────

/** What {@link sessionScopedWorkspacePaths} returns: the two directories §25 requires per session. */
export type SessionScopedWorkspacePaths = {
  /** §25: a distinct `cwd` per session, nested under the workspace's own root. */
  readonly cwd: string;
  /** The engine's own configuration directory: a distinct per-session directory inside that `cwd`. */
  readonly configDir: string;
};

/**
 * A session id is safe to use as a single path segment when it is exactly this shape — letters,
 * digits, `_` and `-`, starting with a letter or digit. There is no separate "reject `..`" rule
 * to keep in sync with this one: anything that is not this shape, including a path-traversal or
 * absolute-path attempt, is refused by the same check.
 *
 * The SAME rule, for the same reason `RunnerAgentConnection` mirrors `AgentConnection` (this
 * file's own header), as `packages/runtime/src/env.ts`'s `SAFE_PATH_SEGMENT` — but **not a
 * byte-identical copy**: this file's `sessionScopedWorkspacePaths` below validates `workspaceRoot`
 * with `workspaceRoot.length === 0`, while `env.ts`'s `sessionWorkspacePaths` validates it with a
 * `typeof` check (`requireNonEmptyString`), so a non-string root throws a different error from a
 * different place in the two copies. `apps/runner/src/runtime.test.ts` drives this exact function
 * against the same refusal list `env.test.ts` uses, independently.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Compute a distinct `cwd` and engine configuration directory for one session under one
 * workspace root.
 *
 * §25: *"Each workspace and session must get a distinct directory."*
 *
 * `protectedConfigDirectory` is the **adapter's** answer to "where does this engine keep its own
 * configuration" ({@link AgentEngine.protectedConfigDirectory}), and it is **required**. ENG-04
 * removed the hard-coded `.claude` from three places that had no business knowing it and left a
 * default here so the callers could be moved over one at a time; ENG-04b moved the last of them, so
 * the default is gone — a default would be this file deciding one engine's layout again, and the
 * only reason it could not be caught is that it would be right for exactly one engine.
 *
 * A positive assertion, not the absence of a negative (ADR-0015): `sessionId` is checked against
 * an allow-listed shape and refused by name otherwise, never merely checked for the specific
 * characters a path-traversal attempt happens to use.
 */
export function sessionScopedWorkspacePaths(
  workspaceRoot: string,
  sessionId: string,
  protectedConfigDirectory: string,
): SessionScopedWorkspacePaths {
  if (workspaceRoot.length === 0) {
    throw new Error('sessionScopedWorkspacePaths: workspaceRoot must be a non-empty string.');
  }
  if (!SAFE_PATH_SEGMENT.test(sessionId)) {
    throw new Error(
      `sessionScopedWorkspacePaths: sessionId ${JSON.stringify(sessionId)} is not safe to use as a directory name (must match ${String(SAFE_PATH_SEGMENT)}); refusing to allocate a session workspace under an unvalidated name (spec §25).`,
    );
  }
  if (
    protectedConfigDirectory.length === 0 ||
    protectedConfigDirectory.includes('/') ||
    protectedConfigDirectory.includes('\\') ||
    protectedConfigDirectory === '..'
  ) {
    throw new Error(
      `sessionScopedWorkspacePaths: protectedConfigDirectory ${JSON.stringify(protectedConfigDirectory)} is not a single path segment; refusing to nest a session's engine configuration under an unvalidated name (spec §25).`,
    );
  }
  const trimmedRoot = workspaceRoot.replace(/[\\/]+$/, '');
  const cwd = `${trimmedRoot}/${sessionId}`;
  return { cwd, configDir: `${cwd}/${protectedConfigDirectory}` };
}
