import {
  OUTPUT_SCHEMA_UNSATISFIED,
  OUTPUT_SCHEMA_UNSATISFIED_MESSAGE,
} from '@indx-workspace/contracts/runs';
import { credentialRejectedError, isGatewayTokenRefusal } from '@agent-workspace/engine';
import { type MastraCompiled } from './compile.js';
import { addMastraUsage, type MastraUsage } from './frames.js';

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The failure a run ends with when the model call came back `401` or `403` from the provider
 * (issue #690), or `null` for any other error. The adapter never holds the model key, so this is
 * the first moment it can see the key is wrong. A gateway refusal of the run token carries a
 * `token_*` code (`packages/gateway/src/auth.ts`) and is left alone, so nobody is told to replace
 * a good key. Only the status is read: no key and no provider text reaches the message.
 */
function rejectedKeyFailure(error: unknown): Error | null {
  if (!isRecord(error)) return null;
  const status = error['statusCode'];
  if (status !== 401 && status !== 403) return null;
  const body = error['responseBody'];
  if (typeof body === 'string' && isGatewayTokenRefusal(body)) return null;
  return credentialRejectedError(status);
}

/** What the stream loop has seen. An object, so reads after the loop are not narrowed away. */
export type RunState = {
  steps: number;
  lastStepReason: unknown;
  usage: MastraUsage | null;
  finish: unknown;
  errored: boolean;
  /** Set when an error chunk is the provider refusing the key (issue #690). */
  rejection: Error | null;
  /** Set when an error chunk is Mastra's own structured-output check failing (ADR-0143). */
  schemaFailure: boolean;
  /** The validated value of Mastra's `object-result` chunk, once it has arrived. */
  object: { readonly value: unknown } | null;
};

/**
 * Whether `error` is Mastra's structured-output failure: a `MastraError` whose `id` starts
 * `STRUCTURED_OUTPUT_` (schema mismatch, a truncated answer), or the AI SDK's
 * `NoObjectGeneratedError`. Read by id or name, never by message. Mastra's own
 * `isStructuredOutputFormatError` also counts `AI_JSONParseError` and `AI_TypeValidationError`,
 * but the AI SDK raises those for a malformed provider stream chunk too, which is not the answer
 * failing the schema, so they are left as a plain failed run.
 */
function isStructuredOutputError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (typeof error['id'] === 'string' && error['id'].startsWith('STRUCTURED_OUTPUT_')) return true;
  return error['name'] === 'AI_NoObjectGeneratedError';
}

export function outputSchemaUnsatisfied(): Error {
  return new Error(`${OUTPUT_SCHEMA_UNSATISFIED}: ${OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}`);
}

/** Fold one chunk into the run's state. */
export function observe(state: RunState, chunk: unknown): void {
  if (!isRecord(chunk)) return;
  const payload = isRecord(chunk['payload']) ? chunk['payload'] : {};
  if (chunk['type'] === 'error') {
    state.errored = true;
    state.rejection = rejectedKeyFailure(payload['error']);
    state.schemaFailure = isStructuredOutputError(payload['error']);
  }
  if (chunk['type'] === 'object-result') state.object = { value: chunk['object'] };
  if (chunk['type'] === 'finish') state.finish = chunk;
  if (chunk['type'] === 'tool-output') {
    // A subagent's chunks arrive wrapped in its tool call's output. Its steps are reported usage;
    // they are not the run's own steps, so `steps` and the `maxSteps` reading stay the parent's.
    const inner = payload['output'];
    if (!isRecord(inner) || inner['type'] !== 'step-finish') return;
    meterStep(state, isRecord(inner['payload']) ? inner['payload'] : {});
    return;
  }
  if (chunk['type'] !== 'step-finish') return;
  state.steps += 1;
  state.lastStepReason = isRecord(payload['stepResult']) ? payload['stepResult']['reason'] : null;
  meterStep(state, payload);
}

/** Add one `step-finish` payload's usage to the run's. The gateway prices it (ADR-0162). */
function meterStep(state: RunState, payload: Record<string, unknown>): void {
  const output = isRecord(payload['output']) ? payload['output'] : {};
  state.usage = addMastraUsage(state.usage, output['usage']);
}

/** What {@link mastraStopReason} reads of a drained run. Plain data. */
export type MastraStopInput = {
  /** The `step-finish` chunks seen. */
  readonly steps: number;
  /** The last step's `stepResult.reason`, as Mastra reported it. */
  readonly lastStepReason: unknown;
  /** The compiled `limits.maxSteps`; `null` is Mastra's own default. */
  readonly maxSteps: number | null;
  /** The caller interrupted the run. */
  readonly interrupted: boolean;
};

/**
 * The run's stop reason, once the stream has drained without an `error` chunk. The caller's
 * interrupt wins; otherwise a run whose last allowed step still asked for tools
 * was cut short (`max_turns`) and any other ends `end_turn` — including one that used exactly
 * `maxSteps` steps and stopped on its own.
 */
export function mastraStopReason(input: MastraStopInput): 'end_turn' | 'max_turns' | 'cancelled' {
  if (input.interrupted) return 'cancelled';
  const cutShort =
    input.maxSteps !== null &&
    input.steps >= input.maxSteps &&
    input.lastStepReason === 'tool-calls';
  return cutShort ? 'max_turns' : 'end_turn';
}

/** {@link mastraStopReason} over the loop's state; a drained run with no `finish` is a failure. */
export function stopReasonOf(
  state: RunState,
  compiled: MastraCompiled,
  interrupted: boolean,
): 'end_turn' | 'max_turns' | 'cancelled' {
  const input: MastraStopInput = {
    steps: state.steps,
    lastStepReason: state.lastStepReason,
    maxSteps: compiled.limits.maxSteps,
    interrupted,
  };
  if (!interrupted && state.finish === null) {
    throw new Error("Mastra's stream ended without a finish chunk.");
  }
  return mastraStopReason(input);
}
