/**
 * The parts of a pi run that never touch pi itself (`./boundary.ts` is the only file that may import
 * the SDK): where a run's session starts from, the queue its events travel through, how its session
 * is mirrored into the store, and how it ends.
 */
import { credentialRejectedError, isGatewayTokenRefusal } from '@agent-workspace/engine';

import type { PiCompiled } from './compile.js';
import type { PiUsage } from './frames.js';
import {
  forkPiStream,
  type PiFileEntry,
  type PiSessionMirror,
  type PiStreamVerdict,
} from './session.js';

/** What a run needs from the engine around it. */
export type PiRunDeps = {
  /** The stream this run's session is mirrored into, or `null` without a session store. */
  readonly mirror: PiSessionMirror | null;
  /** The parent of a fork, read from the store; `null` unless the run is a fork with a store. */
  readonly loadParent: (() => Promise<PiStreamVerdict | null>) | null;
  readonly signal: AbortSignal;
};

/** How a run ends: the stop reason of its `run_completed` event. */
type PiStopReason = 'end_turn' | 'max_turns' | 'cancelled';

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function resumedLines(
  engineSessionId: string,
  mirror: PiSessionMirror | null,
): Promise<PiFileEntry[]> {
  if (mirror === null) {
    throw new Error(
      `pi session ${engineSessionId} can only be resumed from the session store, and this run has none; refusing to start a new conversation in its place.`,
    );
  }
  const loaded = await mirror.load();
  if (loaded === null) {
    throw new Error(`the session store holds no pi session ${engineSessionId}.`);
  }
  if (!loaded.ok) throw new Error(loaded.reason);
  return [...loaded.entries];
}

async function forkedLines(compiled: PiCompiled, deps: PiRunDeps): Promise<PiFileEntry[]> {
  const { session } = compiled;
  const parentId = session.parentSessionId ?? '';
  if (deps.loadParent === null) {
    throw new Error(
      `pi session ${parentId} can only be forked from the session store, and this run has none.`,
    );
  }
  const parent = await deps.loadParent();
  if (parent === null) throw new Error(`the session store holds no pi session ${parentId}.`);
  if (!parent.ok) throw new Error(parent.reason);
  return [
    ...forkPiStream(parent.entries, {
      engineSessionId: session.engineSessionId,
      parentSessionId: parentId,
      cwd: compiled.workspace.cwd,
      timestamp: new Date().toISOString(),
    }),
  ];
}

/** The session lines a run starts from: none, the resumed stream, or a copy of the parent. */
export async function initialLines(compiled: PiCompiled, deps: PiRunDeps): Promise<PiFileEntry[]> {
  const { session } = compiled;
  if (session.mode === 'fresh') return [];
  if (session.mode === 'resume') return resumedLines(session.engineSessionId, deps.mirror);
  return forkedLines(compiled, deps);
}

/**
 * The failure a run ends with when the model call came back `401` or `403` from the provider
 * (issue #690), or `null` for any other error. pi reports a failed call as one string, the status
 * then the body (`401 {...}`), so the status is read from its start. The adapter never holds the
 * model key, so this is the first moment it can see the key is wrong. A gateway refusal of the run
 * token carries a `token_*` code (`packages/gateway/src/auth.ts`) and is left alone, so nobody is
 * told to replace a good key. No key and no provider text reaches the message.
 */
function rejectedKeyFailure(errorMessage: string): Error | null {
  const status = /^(401|403)(?![0-9])/u.exec(errorMessage)?.[1];
  return status === undefined || isGatewayTokenRefusal(errorMessage)
    ? null
    : credentialRejectedError(status);
}

/** A queue the session's synchronous listener pushes into and the generator drains. */
export function eventQueue(): {
  push(event: unknown): void;
  close(): void;
  next(): Promise<{ done: true } | { done: false; value: unknown }>;
} {
  const items: unknown[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  return {
    push(event) {
      items.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async next() {
      for (;;) {
        if (items.length > 0) return { done: false, value: items.shift() };
        if (closed) return { done: true };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    },
  };
}

/** Collects the first failure of fire-and-forget work, to be raised once the stream has drained. */
type FailureSlot = {
  /** Wraps `task` so a rejection is recorded instead of left unhandled. */
  readonly track: (task: Promise<void>) => Promise<void>;
  /** Throws the recorded failure, if any, as an `Error` carrying `nonErrorMessage` for other values. */
  readonly raise: (nonErrorMessage: string) => void;
};

export function failureSlot(): FailureSlot {
  let failure: unknown = null;
  return {
    track: (task) =>
      task.catch((error: unknown) => {
        failure ??= error;
      }),
    raise: (nonErrorMessage) => {
      if (failure === null) return;
      throw failure instanceof Error ? failure : new Error(nonErrorMessage);
    },
  };
}

/** The mirror of a run's session into the store: writes are chained, so they land in order. */
type SessionMirroring = {
  /** Persists the session as it now stands; a no-op without a store. */
  readonly persist: () => void;
  /** Resolves once every queued write has landed, then raises the first refused one. */
  readonly settle: () => Promise<void>;
};

export function sessionMirroring(
  target: PiSessionMirror | null,
  snapshot: () => PiFileEntry[],
): SessionMirroring {
  const failures = failureSlot();
  let chain: Promise<void> = Promise.resolve();
  return {
    persist: () => {
      if (target === null) return;
      const file = snapshot();
      chain = failures.track(chain.then(() => target.persist(file)));
    },
    settle: async () => {
      await chain;
      failures.raise('the session store refused a write with a non-Error value.');
    },
  };
}

/** What a run's listener learns from the session, read once the stream has drained. */
export type PiRunState = {
  turns: number;
  usage: PiUsage | null;
  limit: 'max_turns' | null;
  lastAssistant: Readonly<Record<string, unknown>> | null;
};

/** What a run's failed model call, or an aborted prompt, turns into once the stream has drained. */
export function stopReasonOf(
  state: PiRunState,
  outcome: { readonly cancelled: boolean; readonly promptFailure: unknown },
): PiStopReason {
  if (state.limit !== null) return state.limit;
  if (outcome.cancelled) return 'cancelled';
  const { promptFailure } = outcome;
  if (promptFailure !== null) {
    throw promptFailure instanceof Error
      ? promptFailure
      : new Error("pi's prompt failed with a non-Error value.");
  }
  const ended = state.lastAssistant;
  if (ended?.['stopReason'] === 'error') {
    const message = ended['errorMessage'];
    const rejected = typeof message === 'string' ? rejectedKeyFailure(message) : null;
    if (rejected !== null) throw rejected;
    throw new Error(
      `pi's model call failed: ${typeof message === 'string' ? message : 'no reason given'}`,
    );
  }
  return ended?.['stopReason'] === 'aborted' ? 'cancelled' : 'end_turn';
}
