import { parseRunFailure, type RunStartProblemCode } from '@indx-workspace/contracts/runs';
import { DomainError } from '../errors';
import { describeDiscoveryFailure } from '../integrations';
import { connectionSubject, modelUnavailableReason, type ModelResolution } from './run-request';

/** One refusal: the contract code and a sentence that names what to fix. */
export interface RunStartRefusal {
  readonly code: RunStartProblemCode;
  readonly message: string;
}

/** The refusal as a thrown error, for a check that fails after the run was queued. */
export function runStartRefusalError(refusal: RunStartRefusal): DomainError {
  return new DomainError({
    category: 'validation',
    code: refusal.code,
    publicMessage: `${refusal.code}: ${refusal.message}`,
  });
}

type RuntimeProfileHolder = {
  readonly id: string;
  readonly name: string;
  readonly runtimeProfileId: string | null;
};

/**
 * `agent_runtime_profile_missing` for an agent whose runtime profile could not be found: it names
 * none, or names one that no longer exists in its workspace. A runtime has no inheritance layer,
 * so there is nothing to fall back to.
 */
export function missingRuntimeProfile(agent: RuntimeProfileHolder): RunStartRefusal {
  return {
    code: 'agent_runtime_profile_missing',
    message:
      agent.runtimeProfileId === null
        ? `agent "${agent.name}" has no runtime profile. Attach a runtime profile to the agent, or finish the setup wizard.`
        : `agent "${agent.name}" selects runtime profile ${agent.runtimeProfileId}, which no longer exists. Attach an existing runtime profile to the agent.`,
  };
}

const MODEL_REMEDY: Readonly<Record<Extract<ModelResolution, { ok: false }>['code'], string>> = {
  model_connection_unresolved:
    'Choose a model on the agent, or set a workspace default model under Models.',
  // The discovery failure's own sentence already says to check the base URL and the network.
  model_connection_failed: '',
  model_unavailable: 'Choose a model the connection offers.',
  // The discovery failure's own sentence already says to replace the key on this connection.
  model_credential_rejected: '',
};

/** A failed model resolution as a refusal: the resolver's reason, then what to do about it. */
export function modelResolutionRefusal(
  resolution: Extract<ModelResolution, { ok: false }>,
): RunStartRefusal {
  return {
    code: resolution.code,
    message: `${resolution.reason} ${MODEL_REMEDY[resolution.code]}`.trim(),
  };
}

/** A launched run whose model was not checked against the provider's list (discovery was down). */
export interface UnvalidatedModel {
  readonly layer: Extract<ModelResolution, { ok: true }>['layer'];
  readonly connectionName: string;
  readonly model: string;
}

/** Every launched run's model selection, validated or not (issue #661). */
export interface LaunchedModel extends UnvalidatedModel {
  readonly validated: boolean;
}

/**
 * The coded failure for a run the engine stopped because the provider rejected the key once it was
 * running (issue #661), or `null` for any other failure. The engine reports
 * `model_credential_rejected: …`; the stored sentence is this one, naming the run's connection the
 * way the pre-queue refusal does, so the runtime's text is never stored as given. Only a `403`
 * status is read back from it; anything else is reported as the `401` it almost always is.
 */
export function credentialRejectedFailure(
  reason: string,
  launched: UnvalidatedModel,
): string | null {
  if (parseRunFailure(reason)?.code !== 'model_credential_rejected') return null;
  const status = /\bHTTP 403\b/u.test(reason) ? 403 : 401;
  return runStartRefusalError(
    modelResolutionRefusal({
      ok: false,
      layer: launched.layer,
      code: 'model_credential_rejected',
      reason: `${connectionSubject(launched.layer)} "${launched.connectionName}": ${describeDiscoveryFailure({ kind: 'credential-rejected', status })}`,
    }),
  ).publicMessage;
}

/**
 * The coded failure for a launched run the runtime reported failed, or `null` to store the generic
 * sentence: a rejected key is coded for every run (issue #661), "model not found" only for a run
 * whose model was queued unvalidated (PR #403 review).
 */
export function codeLaunchedRunFailure(
  reason: string,
  launched: LaunchedModel | undefined,
): string | null {
  if (launched === undefined) return null;
  return (
    credentialRejectedFailure(reason, launched) ??
    (launched.validated ? null : modelNotFoundFailure(reason, launched))
  );
}

/**
 * The provider's own "this model does not exist" answers: Anthropic's `not_found_error`, OpenAI's
 * `model_not_found`, and the plain sentences both use, which name the model id.
 */
const MODEL_NOT_FOUND_CODES = /\b(?:not_found_error|model_not_found)\b/iu;
const NOT_FOUND_SENTENCE = /\b(?:not found|does not exist|404)\b/iu;

/**
 * The coded failure for a run whose explicit model was queued unvalidated and that the provider
 * then refused as unknown (PR #403 review), or `null` for any other failure.
 *
 * Discovery being down is the one case where `runs.start` lets an unchecked model through, so it is
 * the one case where "the model does not exist" can first be learnt from the model call. Mapping it
 * to `model_unavailable` makes the run read as the pre-queue refusal would have: the same code, the
 * same sentence. A reason is only treated as "model not found" when it carries a provider code for
 * that or a not-found sentence, **and** names this model, so an unrelated 404 is not mislabelled.
 */
export function modelNotFoundFailure(reason: string, unvalidated: UnvalidatedModel): string | null {
  const matches =
    reason.includes(unvalidated.model) &&
    (MODEL_NOT_FOUND_CODES.test(reason) || NOT_FOUND_SENTENCE.test(reason));
  if (!matches) return null;
  return runStartRefusalError(
    modelResolutionRefusal({
      ok: false,
      layer: unvalidated.layer,
      code: 'model_unavailable',
      reason: modelUnavailableReason(
        unvalidated.layer,
        unvalidated.model,
        unvalidated.connectionName,
      ),
    }),
  ).publicMessage;
}
