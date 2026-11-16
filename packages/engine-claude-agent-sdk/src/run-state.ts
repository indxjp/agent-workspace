import type { ClassifiedSdkEvent } from '@agent-workspace/run-protocol';
import type { ApprovalState } from './permissions.js';

import { type SessionDurabilityVerdict } from '@agent-workspace/engine';

import { type RecordedHandoff } from './handoff.js';

/** The message of a thrown value, without assuming it is an `Error`. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return `non-Error thrown: ${describe(error)}`;
}

/**
 * Whether this run's conversation survives the sandbox (spec §14.9, §20).
 *
 * The type itself is `@agent-workspace/engine`'s {@link SessionDurabilityVerdict} — ENG-04 moved
 * it to the port, because "can this conversation be resumed after the sandbox is gone?" is a
 * question every engine has to answer and not a Claude one. The alias is kept so this module's
 * existing consumers read the same name they always did.
 *
 * Two arms, and the `false` arm always carries a sentence. There is no "probably fine": §14.9
 * calls a session that lives only in `CLAUDE_CONFIG_DIR` a release blocker, so the platform
 * must be able to say *which* runs it may offer a resume for and which it may not.
 */
export type SessionDurability = SessionDurabilityVerdict;

export type RunState = {
  readonly approval: ApprovalState;
  /** The first `handoff_to_person` call of the run; later calls are ignored. */
  handoff: RecordedHandoff | null;
  readonly storeConfigured: boolean;
  appendsSettled: number;
  appendsInFlight: number;
  readonly appendFailures: string[];
  readonly mirrorErrors: string[];
  sawResult: boolean;
  exhausted: boolean;
  /**
   * Set when the stream stayed open past `linger.ms` after its `result` and the SDK was aborted
   * (issue #2076). The CLI may have been killed before it handed its last transcript batch to the
   * mirror, so the verdict cannot claim the session durable.
   */
  lingered: boolean;
  failure: string | null;
};

export function newRunState(storeConfigured: boolean): RunState {
  return {
    approval: { consumed: new Set(), request: null, denied: [] },
    handoff: null,
    storeConfigured,
    appendsSettled: 0,
    appendsInFlight: 0,
    appendFailures: [],
    mirrorErrors: [],
    sawResult: false,
    exhausted: false,
    lingered: false,
    failure: null,
  };
}

/**
 * Read a `system/mirror_error` envelope without trusting its shape.
 *
 * R-01 §4 records that the SDK emits fields the `.d.ts` does not declare, so the envelope is
 * parsed defensively rather than cast. What matters is that a batch was dropped; the text is
 * for the operator.
 */
function describeMirrorError(event: Record<string, unknown>): string {
  const error = typeof event['error'] === 'string' ? event['error'] : 'no error text';
  const key = event['key'];
  if (typeof key !== 'object' || key === null || Array.isArray(key)) return error;
  const record = key as Record<string, unknown>;
  const projectKey = typeof record['projectKey'] === 'string' ? record['projectKey'] : '?';
  const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'] : '?';
  const subpath = typeof record['subpath'] === 'string' ? `/${record['subpath']}` : '';
  return `${projectKey}/${sessionId}${subpath}: ${error}`;
}

/**
 * The durability verdict for a finished run.
 *
 * Read this as one long "no, because …" list ending in a single "yes, and here is the evidence".
 * ADR-0015: the run is durable because a scenario passed — a store was configured, its writes
 * were observed to resolve, none was dropped, and the stream reached a `result` — never because
 * no failure was seen.
 */
export function verdict(state: RunState): SessionDurability {
  if (!state.exhausted) {
    return {
      durable: false,
      reason:
        'the event stream has not been exhausted. Durability is asserted about a completed run; a stream still open, or abandoned by the consumer before it ended, may have transcript batches that were never mirrored.',
    };
  }
  if (state.failure !== null) {
    return { durable: false, reason: `the run stream ended in an error: ${state.failure}` };
  }
  if (state.lingered) {
    return {
      durable: false,
      reason:
        "the SDK stream was aborted after the run's result because it stayed open past the linger window, so the CLI may have been stopped before its last transcript batch was mirrored.",
    };
  }
  if (!state.storeConfigured) {
    return {
      durable: false,
      reason:
        'no sessionStore was supplied, so this session exists only as <CLAUDE_CONFIG_DIR>/projects/<projectKey>/<sessionId>.jsonl inside the sandbox (R-01 §6, verified live). Spec §14.9: destroying the sandbox destroys the conversation, and the session id in Postgres is not enough to resume it.',
    };
  }
  if (state.mirrorErrors.length > 0) {
    return {
      durable: false,
      reason: `the SDK emitted ${String(state.mirrorErrors.length)} system/mirror_error event(s): a batch of transcript entries was dropped after 3 attempts and has no surviving copy in the store. First: ${state.mirrorErrors[0] ?? '(none recorded)'}`,
    };
  }
  if (state.appendFailures.length > 0) {
    return {
      durable: false,
      reason: `${String(state.appendFailures.length)} sessionStore.append() call(s) rejected. The SDK retries, but a run whose mirror rejected cannot be claimed durable. First: ${state.appendFailures[0] ?? '(none recorded)'}`,
    };
  }
  if (state.appendsInFlight > 0) {
    return {
      durable: false,
      reason: `${String(state.appendsInFlight)} sessionStore.append() call(s) were still in flight when the stream ended; their outcome is unknown.`,
    };
  }
  if (!state.sawResult) {
    return {
      durable: false,
      reason:
        "the stream ended without a 'result' event, so the run did not reach a terminal state and the transcript may be incomplete.",
    };
  }
  if (state.appendsSettled === 0) {
    return {
      durable: false,
      reason:
        'a sessionStore was configured but it received no append() call, so nothing about this session was mirrored out of the sandbox.',
    };
  }
  return { durable: true, mirroredBatches: state.appendsSettled };
}

/** Name a value in a rejection message without stringifying something huge or cyclic. */
export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `the number ${String(value)}`;
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  return `a value of type ${typeof value}`;
}

export function observeSdkEvent(state: RunState, event: ClassifiedSdkEvent): void {
  if (event.kind === 'system' && event.subtype === 'mirror_error') {
    state.mirrorErrors.push(describeMirrorError(event.event));
  } else if (event.kind === 'result' || event.kind === 'result-unknown') {
    state.sawResult = true;
  }
}
