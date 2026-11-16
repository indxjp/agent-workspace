/**
 * The one error envelope an app's routes answer with (ADR-0075, issue #1503):
 * `{ error: { code, message, details? } }`, the shape `ApiProblemSchema` in
 * `@indx-workspace/contracts` parses. The deprecated `detail` duplicate the platform still renders
 * is never written here.
 *
 * Every message is fixed prose chosen for the caller. An error this module does not know becomes
 * `500 internal_error` and is logged by its name only, never its text, which may carry a driver's,
 * a database's or a credential's words.
 */
import { AppStoreError } from '../db/errors.js';

/** Every code the server half raises itself, with the status it travels under. */
export const APP_SERVER_ERROR_STATUS = {
  app_misconfigured: 500,
  upstream_failure: 502,
} as const;

/** A code the server half raises itself. */
export type AppServerErrorCode = keyof typeof APP_SERVER_ERROR_STATUS;

const SERVER_MESSAGES: Readonly<Record<AppServerErrorCode, string>> = {
  app_misconfigured:
    'The app is not configured: AW_URL, AW_APP_NAME, DATABASE_URL and AW_WORKSPACE_ID must all be set and valid.',
  upstream_failure: 'Agent Workspace did not answer as expected. Try again later.',
};

const INTERNAL_MESSAGE = 'The request failed.';

/**
 * Why the server half could not serve a request: the app's environment is missing or invalid
 * (`app_misconfigured`), or Agent Workspace failed to say who is asking (`upstream_failure`). The
 * message is fixed; the original error, when there is one, is kept as `cause` and never rendered.
 */
export class AppServerError extends Error {
  readonly code: AppServerErrorCode;
  readonly status: (typeof APP_SERVER_ERROR_STATUS)[AppServerErrorCode];

  constructor(code: AppServerErrorCode, options: { readonly cause?: unknown } = {}) {
    super(
      SERVER_MESSAGES[code],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppServerError';
    this.code = code;
    this.status = APP_SERVER_ERROR_STATUS[code];
  }
}

/** The `cache-control` every answer of an app route carries: nothing is cached. */
export const NO_STORE = 'no-store';

/**
 * A problem answer: `status`, `{ error: { code, message, details? } }` as JSON, and
 * `cache-control: no-store`. `details` is left out when not given.
 */
export function problem(
  code: string,
  status: number,
  message: string,
  details?: readonly string[],
): Response {
  return Response.json(
    { error: { code, message, ...(details === undefined ? {} : { details: [...details] }) } },
    { status, headers: { 'content-type': 'application/json', 'cache-control': NO_STORE } },
  );
}

/** The problem answer of a store's refusal or failure, its code, status, message and details. */
export function fromStoreError(error: AppStoreError): Response {
  return problem(error.code, error.status, error.message, error.details);
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The problem answer of anything a handler threw: a store's or the server half's own error as
 * itself, anything else as `500 internal_error`, logged by its name and never its text.
 */
export function problemFromError(error: unknown): Response {
  if (error instanceof AppStoreError) {
    if (error.code === 'internal_error') logFailure(error.cause ?? error);
    return fromStoreError(error);
  }
  if (error instanceof AppServerError) {
    if (error.code === 'upstream_failure') logFailure(error.cause ?? error);
    return problem(error.code, error.status, error.message);
  }
  logFailure(error);
  return problem('internal_error', 500, INTERNAL_MESSAGE);
}

function logFailure(error: unknown): void {
  console.error(`[@indx-workspace/app] a request failed (${nameOf(error)})`);
}
