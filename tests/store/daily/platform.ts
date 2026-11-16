/**
 * The deployment's operator calls the daily jobs make (the Agent Store runbook, "The daily jobs"): a
 * bearer request to the platform with the operator token. Neither the token nor the platform's
 * address is ever put in a message that leaves this module.
 */

export interface Platform {
  /** The platform's origin, `STORE_PLATFORM_URL`. */
  readonly baseUrl: string;
  /** `AW_DEMO_OPERATOR_TOKEN`'s value, `STORE_OPERATOR_TOKEN` here. */
  readonly token: string;
  readonly request: typeof fetch;
}

/** The longest one operator call may take before the run fails it as unanswered. */
export const OPERATOR_CALL_TIMEOUT_MS = 30_000;

/** The platform's address with no trailing slash, so a path joins to it cleanly. */
const origin = (platform: Platform): string => platform.baseUrl.replace(/\/+$/u, '');

/** One bearer call to `path`; the answer, or a failure whose message names the status only. */
export async function operatorCall(
  platform: Platform,
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown,
): Promise<Response> {
  let response: Response;
  try {
    response = await platform.request(`${origin(platform)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${platform.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(OPERATOR_CALL_TIMEOUT_MS),
    });
  } catch {
    // A transport error can name the address; say only that the platform did not answer.
    throw new Error(`${method} ${path}: the platform did not answer`);
  }
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${String(response.status)}`);
  return response;
}
