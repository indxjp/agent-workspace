/**
 * What `/oauth/token` and `/oauth/revoke` do before they look at a grant: admit the address, refuse
 * an address that failed authentication too often, read the form, identify the client and check
 * its secret, and only then count the client (ADR-0134 part 3). A `client_id` is public, so naming
 * one counts against nobody; failed authentications count against the source address.
 */
import { isUuid } from '@indx-workspace/contracts';

import { applicationContext } from '../application-context';
import { systemClock } from '../clock';
import { hashesEqual } from '../rbac/api-key';
import {
  oauthError,
  oauthNotConfigured,
  oauthRateLimited,
  oauthUnavailable,
  readForm,
} from './http';
import {
  admitOAuthAddress,
  admitOAuthAuthAttempt,
  admitOAuthClient,
  recordOAuthAuthFailure,
} from './limits';
import { publicOrigin } from './resource';
import type { OAuthClient, OAuthRuntime } from './runtime';
import { clientSecretDigest } from './tokens';

export type ClientAuthentication =
  | {
      readonly ok: true;
      readonly client: OAuthClient;
      readonly form: URLSearchParams;
      readonly runtime: OAuthRuntime;
    }
  | { readonly ok: false; readonly response: Response };

const invalidClient = (): ClientAuthentication => ({
  ok: false,
  response: oauthError(401, 'invalid_client', 'Client authentication failed.', {
    'www-authenticate': 'Basic realm="agent-workspace"',
  }),
});

const refuse = (response: Response): ClientAuthentication => ({ ok: false, response });

/**
 * `client_secret_basic` (RFC 6749 §2.3.1): form-urlencoded id and secret, joined by `:` and
 * base64'd. `undefined` when there is no Basic header, `null` when there is a malformed one. Also
 * read by the ID-token exchange (ADR-0161 D3), which takes this method only.
 */
export function readBasic(
  header: string | null,
): { id: string; secret: string } | null | undefined {
  if (header === null || !/^Basic[ ]/iu.test(header)) return undefined;
  try {
    const decoded = atob(header.slice(6).trim());
    const split = decoded.indexOf(':');
    if (split < 0) return null;
    const unescape = (value: string) => decodeURIComponent(value.replace(/\+/gu, ' '));
    return { id: unescape(decoded.slice(0, split)), secret: unescape(decoded.slice(split + 1)) };
  } catch {
    return null;
  }
}

export async function authenticateClient(request: Request): Promise<ClientAuthentication> {
  if (publicOrigin() === null) return refuse(oauthNotConfigured());
  const runtime = applicationContext()?.oauth ?? null;
  if (runtime === null) return refuse(oauthUnavailable());
  const nowMs = systemClock.now().getTime();
  const address = admitOAuthAddress(request.headers, nowMs);
  if (!address.admitted) return refuse(oauthRateLimited(address.retryAfterSeconds));

  const form = await readForm(request);
  if (form instanceof Response) return refuse(form);

  const attempt = admitOAuthAuthAttempt(request.headers, nowMs);
  if (!attempt.admitted) return refuse(oauthRateLimited(attempt.retryAfterSeconds));
  const failed = (): ClientAuthentication => {
    recordOAuthAuthFailure(request.headers, nowMs);
    return invalidClient();
  };

  const basic = readBasic(request.headers.get('authorization'));
  if (basic === null) return failed();
  const bodyId = form.get('client_id');
  const bodySecret = form.get('client_secret');
  if (basic !== undefined && bodySecret !== null) {
    return refuse(oauthError(400, 'invalid_request', 'Use one client authentication method.'));
  }
  const clientId = basic?.id ?? bodyId;
  if (clientId === null || clientId === '') {
    return refuse(oauthError(400, 'invalid_request', 'client_id is required.'));
  }
  if (basic !== undefined && bodyId !== null && bodyId !== basic.id) {
    return refuse(oauthError(400, 'invalid_request', 'client_id does not match the credentials.'));
  }
  const checked = await checkClientCredentials(
    (id) => runtime.findClient(id),
    clientId,
    basic?.secret ?? bodySecret,
  );
  if (!checked.ok) return failed();
  const counted = admitOAuthClient(checked.client.id, nowMs);
  if (!counted.admitted) return refuse(oauthRateLimited(counted.retryAfterSeconds));
  return { ok: true, client: checked.client, form, runtime };
}

export type ClientCheck =
  | { readonly ok: true; readonly client: OAuthClient }
  | { readonly ok: false; readonly found: OAuthClient | null };

/**
 * The one OAuth client check, used by `/oauth/token`, `/oauth/revoke` and the ID-token exchange.
 * The `client_id` must be a UUID naming a client. A confidential client must present the secret
 * whose digest equals its stored hash (constant-time compare); a public client, with no stored
 * hash, must present no secret at all. `found` is the client that was looked up, kept on a
 * refusal so the caller can log which client failed. Rate limits and the failure counter stay
 * with the caller, since each endpoint counts differently.
 */
export async function checkClientCredentials(
  findClient: (id: string) => Promise<OAuthClient | null>,
  clientId: string,
  presentedSecret: string | null,
): Promise<ClientCheck> {
  const found = isUuid(clientId) ? await findClient(clientId) : null;
  if (found === null) return { ok: false, found: null };
  if (found.clientSecretHash === null) {
    return presentedSecret === null ? { ok: true, client: found } : { ok: false, found };
  }
  const digest = await clientSecretDigest(presentedSecret);
  if (digest === null || !hashesEqual(digest, found.clientSecretHash)) {
    return { ok: false, found };
  }
  return { ok: true, client: found };
}
