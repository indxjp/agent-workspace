import { redacted } from '../redact';
import type { SetupInput, SetupResult } from './runtime';

/** The part of first-run setup that threw; the public message names it and nothing else. */
export type SetupStep = 'runtime test' | 'secrets store' | 'persistence' | 'setup';

export type SetupFailureResult = Extract<SetupResult, { ok: false }>;

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

/**
 * The typed answer to a setup step that threw, so setup never answers an empty 500. The error name
 * and a redacted message go to the server log; the response carries the step, the error name and,
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
  console.error(`[setup] the ${step} step failed (${name}): ${message}`);
  const unavailable = step === 'secrets store';
  return {
    ok: false,
    status: unavailable ? 503 : 500,
    code: unavailable ? 'setup_unavailable' : 'setup_failed',
    message: `Setup failed at the ${step} step (${/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) ? name : 'Error'}${errno}${safeCause === undefined ? '' : `: ${redacted(safeCause, secrets)}`}). See the server log, then retry.`,
  };
}
