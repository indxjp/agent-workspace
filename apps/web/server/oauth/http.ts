/**
 * Response and request helpers shared by the OAuth endpoints. Responses are `no-store` (RFC 6749
 * §5.1) and errors are the RFC 6749 §5.2 shape; nothing here ever carries a secret.
 */
import { MAX_REQUEST_BODY_BYTES } from '../rbac/http';

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'temporarily_unavailable'
  | 'server_error'
  | 'oauth_not_configured';

export function oauthJson(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...headers,
    },
  });
}

export function oauthError(
  status: number,
  error: OAuthErrorCode,
  description: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return oauthJson(status, { error, error_description: description }, headers);
}

export const oauthNotConfigured = (): Response =>
  oauthError(
    404,
    'oauth_not_configured',
    'AW_PUBLIC_URL is not set, so this server issues no tokens.',
  );

export const oauthUnavailable = (): Response =>
  oauthError(503, 'server_error', 'The OAuth server is not available.');

export const oauthRateLimited = (retryAfterSeconds: number): Response =>
  oauthError(429, 'temporarily_unavailable', 'Too many requests.', {
    'retry-after': String(retryAfterSeconds),
  });

/** A bounded `application/x-www-form-urlencoded` body in which no parameter repeats (RFC 6749 §3.2). */
export async function readForm(request: Request): Promise<URLSearchParams | Response> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    return oauthError(
      400,
      'invalid_request',
      'The body must be application/x-www-form-urlencoded.',
    );
  }
  let text: string;
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_REQUEST_BODY_BYTES) {
      return oauthError(413, 'invalid_request', 'The request body is too large.');
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return oauthError(400, 'invalid_request', 'The request body could not be read as UTF-8.');
  }
  const form = new URLSearchParams(text);
  const keys = [...form.keys()];
  if (new Set(keys).size !== keys.length) {
    return oauthError(400, 'invalid_request', 'A parameter was included more than once.');
  }
  return form;
}
