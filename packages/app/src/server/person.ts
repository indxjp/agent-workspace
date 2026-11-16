/**
 * `currentPerson`: who an app request is from (issue #1503), asked of Agent Workspace as that
 * person, so the store's access rules apply to them and nobody else.
 *
 * The app runs on its own origin and cannot read the platform's session cookie. It holds a
 * platform token for the signed-in person instead, in its own httpOnly cookie `aw_user_token`, or a
 * caller sends one as `Authorization: Bearer`. The token's prefix says which credential it is
 * (ADR-0161):
 *
 * - `awo_live_…`: the access token `aw.auth.exchange` returns, which the app's sign-in
 *   (`signInRoutes`, issue #1510) stores for its 300 s. The SDK sends it as `access-token`;
 *   `GET /api/me` is in the app-backend grammar. Once it expires the platform answers `401`, this
 *   answers `null`, and the page sends the person to `signInHref(next)` to sign in again.
 * - `awu_live_…`: the person token `aw login` holds, for a developer's or a test's bearer. The SDK
 *   sends it as `user-token`.
 *
 * Anything else is no person. An API key is not a person either: a `me` answer whose `kind` is not
 * `membership` is refused. Nor is a member of another workspace: the deployment serves the one
 * workspace `AW_WORKSPACE_ID` names, so its tables never hold another tenant's rows.
 *
 * shortcut: one `GET /api/me` per request, no cache; upgrade to a 30 s per-token cache when a
 * journey shows the latency.
 */
import type { ClientAuth } from '@indx-workspace/sdk';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';

import type { Person } from '../person.js';
import { AppServerError } from './problem.js';
import { appRuntime } from './runtime.js';

/** The app's own cookie holding the signed-in person's platform token. */
export const PERSON_TOKEN_COOKIE = 'aw_user_token';

/** The token prefixes a person's credential has, and the SDK auth kind each is sent as. */
const AUTH_KIND_BY_PREFIX = [
  ['awo_live_', 'access-token'],
  ['awu_live_', 'user-token'],
] as const;

/** A token as the platform mints them: a prefix and URL-safe characters, of a bounded length. */
const TOKEN = /^[A-Za-z0-9_\-.~]{1,512}$/u;

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/iu;

function cookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');
    if (at !== -1 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return undefined;
}

/** The token of `request`: its bearer, else its `aw_user_token` cookie. */
function tokenOf(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) return BEARER.exec(authorization)?.[1];
  return cookieValue(request.headers.get('cookie'), PERSON_TOKEN_COOKIE);
}

function authOf(token: string): ClientAuth | undefined {
  if (!TOKEN.test(token)) return undefined;
  const match = AUTH_KIND_BY_PREFIX.find(([prefix]) => token.startsWith(prefix));
  return match === undefined ? undefined : { kind: match[1], token };
}

/**
 * The SDK auth of the person's token `request` carries, so a handler can call Agent Workspace as
 * that person (the agent panel, issue #1509); `undefined` when it carries none.
 */
export function personAuthOf(request: Request): ClientAuth | undefined {
  const token = tokenOf(request);
  return token === undefined ? undefined : authOf(token);
}

/**
 * The person `request` is from, as Agent Workspace says, or `null` when it carries no person's
 * token, the token is not one (an API key, an unknown prefix), the platform answers `401`, or the
 * person is a member of a workspace other than the one the deployment serves.
 *
 * @throws {AppServerError} `app_misconfigured` when the app's environment is invalid;
 *   `upstream_failure` when the platform fails in any other way (the handler answers `502`).
 */
export async function currentPerson(request: Request): Promise<Person | null> {
  const auth = personAuthOf(request);
  if (auth === undefined) return null;
  const runtime = appRuntime();
  const client = createClient({
    baseUrl: runtime.awUrl,
    auth,
    ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
  });
  let me;
  try {
    me = await client.me();
  } catch (error) {
    if (error instanceof ApiProblemError && error.status === 401) return null;
    throw new AppServerError('upstream_failure', { cause: error });
  }
  if (me.kind !== 'membership') return null;
  if (me.workspaceId.toLowerCase() !== runtime.workspaceId) return null;
  return Object.freeze({
    principalId: me.principalId,
    workspaceId: me.workspaceId,
    role: me.role,
    via: 'person' as const,
  });
}
