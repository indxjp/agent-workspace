import { log } from '../telemetry/logger';
import { redacted } from '@agent-workspace/core/telemetry';
import type { SetupInput, SetupResult } from './runtime';

/** The part of first-run setup that threw; the public message names it and nothing else. */
export type SetupStep = 'runtime test' | 'secrets store' | 'persistence' | 'setup';

export type SetupFailureResult = Extract<SetupResult, { ok: false }>;

/**
 * The code a runtime test answers in place of `setup_failed` when the runner manager's platform
 * front end, not the manager, refused web with an HTML `403`. On a new Cloud Run install that is
 * web's `roles/run.invoker` grant on the manager still propagating, which can take minutes, so a
 * caller that just applied the grant may retry; nothing was written. Any other manager `403` (its
 * own JSON refusal) stays `setup_failed`.
 */
export const RUNTIME_MANAGER_FORBIDDEN = 'runtime_manager_forbidden';

/** A Node errno such as `EACCES`: a fixed vocabulary, safe to show beside the error name. */
const SAFE_ERRNO = /^E[A-Z0-9]{2,15}$/u;

/** The values of `input` that must never reach a log line or a response. */
export function setupSecretsOf(input: SetupInput): readonly string[] {
  return [input.providerApiKey, input.adminPassword, input.runtimeCredential].filter(
    (value): value is string => value !== undefined && value !== '',
  );
}

function errnoOf(error: unknown): string {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && SAFE_ERRNO.test(code) ? ` ${code}` : '';
}

/** An error name, or a socket code such as `ECONNREFUSED` or `UND_ERR_CONNECT_TIMEOUT`: fixed vocabularies. */
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const MAX_CAUSE_DEPTH = 8;

/**
 * The first error name and the first `code` down `error`'s `cause` chain, each only when it is a
 * plain identifier. Node's `fetch` throws `TypeError: fetch failed` and keeps the reason (the
 * socket's errno) in `cause`, so without these an unreachable hop logs no reason at all.
 */
function causeFieldsOf(error: unknown): { causeName?: string; causeCode?: string } {
  const fields: { causeName?: string; causeCode?: string } = {};
  let cursor: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor instanceof Error; depth += 1) {
    if (fields.causeName === undefined && SAFE_IDENTIFIER.test(cursor.name)) {
      fields.causeName = cursor.name;
    }
    const code = (cursor as { code?: unknown }).code;
    if (fields.causeCode === undefined && typeof code === 'string' && SAFE_IDENTIFIER.test(code)) {
      fields.causeCode = code;
    }
    cursor = cursor.cause;
  }
  return fields;
}

/**
 * The typed answer to a setup step that threw, so setup never answers an empty 500. The error name,
 * a redacted message, the vetted `safeCause` and the cause chain's error name and code go to the
 * server log; the response carries the step, the error name and,
 * when the caller vetted one, the redacted `safeCause`. A secrets store that cannot be reached is
 * `503 setup_unavailable`, any other step `500 setup_failed`.
 */
export function setupStepFailure(
  step: SetupStep,
  error: unknown,
  secrets: readonly string[],
  /** A caller-vetted phrase naming the failing hop (no body text, no URL, no key). */
  safeCause?: string,
): SetupFailureResult {
  const name = error instanceof Error ? error.name : 'non-error thrown';
  const errno = errnoOf(error);
  const message = error instanceof Error ? redacted(error.message, secrets) : '';
  log.error(`[setup] the ${step} step failed`, {
    errorName: name,
    message,
    ...(safeCause === undefined ? {} : { safeCause: redacted(safeCause, secrets) }),
    ...causeFieldsOf(error),
  });
  const unavailable = step === 'secrets store';
  return {
    ok: false,
    status: unavailable ? 503 : 500,
    code: unavailable ? 'setup_unavailable' : 'setup_failed',
    message: `Setup failed at the ${step} step (${/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) ? name : 'Error'}${errno}${safeCause === undefined ? '' : `: ${redacted(safeCause, secrets)}`}). See the server log, then retry.`,
  };
}
