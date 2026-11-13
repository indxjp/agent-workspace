/**
 * The handlers behind `/api/users` and `/api/api-keys` (memberships are `./membership-handlers.ts`).
 *
 * Every one of them takes a {@link WorkspaceDirectory} and plain data and returns an
 * {@link ApiResult}, so a test exercises them without a framework, a server or a network. The
 * route files under `apps/web/app/api/**` are the thin wiring above these, and `routes.test.ts`
 * imports those files and drives them with real `Request` objects so that the wiring itself is
 * covered rather than assumed.
 *
 * Request bodies are read by `./body-readers.ts` (positive validation, and the role-conferral gate
 * that stops a caller minting a role above its own); `GET /api/me` is `./me.ts`.
 */
import type {
  ApiKeySummary,
  CreateApiKeyOutcome,
  CreateUserOutcome,
  RevokeApiKeyOutcome,
  WorkspaceDirectory,
} from './directory';
import {
  asObject,
  isUuid,
  readConferredRole,
  readEmail,
  readExpiry,
  readPathId,
  readString,
} from './body-readers';
import type { ApiResult } from '../http/result';
import { problem } from './http';
import { publicMembership } from './membership-handlers';
import { unhandledOutcome } from './unhandled-outcome';

// ── users ───────────────────────────────────────────────────────────────────────────────────

/** `GET /api/users` — the members of the caller's workspace, and no other workspace's (§25). */
export async function listUsers(directory: WorkspaceDirectory): Promise<ApiResult> {
  return { status: 200, body: { users: await directory.listUsers() } };
}

/** `POST /api/users` — add a member to the caller's workspace with one of §21's four roles. */
export async function createUser(
  directory: WorkspaceDirectory,
  callerRole: unknown,
  body: unknown,
): Promise<ApiResult> {
  const object = asObject(body);
  if (!object.ok) return object.result;
  const email = readEmail(object.body);
  if (!email.ok) return email.result;
  const name = readString(object.body, 'name', 200);
  if (!name.ok) return name.result;
  const role = readConferredRole(object.body, callerRole);
  if (!role.ok) return role.result;

  const outcome: CreateUserOutcome = await directory.createUser({
    email: email.value,
    name: name.value,
    role: role.value,
  });
  switch (outcome.kind) {
    case 'created':
      return {
        status: 201,
        body: { user: outcome.user, membership: publicMembership(outcome.membership) },
      };
    case 'email-taken':
      return problem(409, 'email_taken', `${outcome.email} is already a member of this workspace.`);
    default:
      return unhandledOutcome('createUser', outcome);
  }
}

// ── api keys ────────────────────────────────────────────────────────────────────────────────

/**
 * `GET /api/api-keys` — §22's list.
 *
 * The response shape is {@link ApiKeySummary}, which has nowhere to put a secret. This is the
 * route the acceptance criterion means by *"a second read of the creation endpoint does not
 * re-reveal it"*: it is the only other route on `/api/api-keys`, it is a `GET` on the same path
 * the `201` came from, and `api-keys.test.ts` reads it after a creation and scans the body.
 */
export async function listApiKeys(directory: WorkspaceDirectory): Promise<ApiResult> {
  const keys: ApiKeySummary[] = await directory.listApiKeys();
  return { status: 200, body: { apiKeys: keys } };
}

/**
 * `POST /api/api-keys` — mint one key, store its hash, and return the whole key **once**.
 *
 * This function contains the only expression in the program that puts a plaintext key into a
 * response body. §22: *"Show the raw secret only once. Store only a secure hash."*
 */
export async function createApiKey(
  directory: WorkspaceDirectory,
  callerRole: unknown,
  body: unknown,
): Promise<ApiResult> {
  const object = asObject(body);
  if (!object.ok) return object.result;
  const name = readString(object.body, 'name', 120);
  if (!name.ok) return name.result;
  const role = readConferredRole(object.body, callerRole);
  if (!role.ok) return role.result;
  const expiresAt = readExpiry(object.body);
  if (!expiresAt.ok) return expiresAt.result;

  const outcome: CreateApiKeyOutcome = await directory.createApiKey({
    name: name.value,
    role: role.value,
    expiresAt: expiresAt.value,
  });
  switch (outcome.kind) {
    case 'created':
      return {
        status: 201,
        body: {
          apiKey: outcome.key,
          // The one time. Named `key` rather than `secret` because it is the whole credential the
          // operator pastes, and carrying the warning in the payload means the caller that stores
          // it has been told, not merely documented at.
          key: outcome.presented,
          warning:
            'This is the only time this key is shown. Only its hash is stored; it cannot be ' +
            'recovered, only revoked and replaced.',
        },
      };
    case 'name-taken':
      return problem(
        409,
        'name_taken',
        `This workspace already has an API key named ${JSON.stringify(outcome.name)}.`,
      );
    case 'expiry-in-the-past':
      return problem(
        400,
        'invalid_field',
        `"expiresAt" is ${outcome.expiresAt}, which is not later than now. A key that expires ` +
          `before it exists is a row every "is this key usable?" comparison answers wrongly.`,
      );
    default:
      return unhandledOutcome('createApiKey', outcome);
  }
}

/**
 * The one answer the verb below gives for an API key this workspace has not got — whether the id
 * named no row, or could not name one at all. Extracted for the reason {@link membershipNotFound}
 * is: the malformed-id guard must not drift away from the directory's own `no-such-key` answer.
 * The id is echoed because that is what the existing `no-such-key` detail does, and dropping it
 * would change the response every caller who sends a well-formed unknown UUID already gets.
 */
function apiKeyNotFound(id: string): ApiResult {
  return problem(404, 'no_such_api_key', `No API key ${id} in this workspace.`);
}

/**
 * `DELETE /api/api-keys/:id` — revoke.
 *
 * Revocation is a timestamp, not a delete: §22's own field list has `revoked_at`, and §36 wants
 * the action auditable, which a vanished row is not. The response is therefore the row, greyed.
 */
export async function revokeApiKey(
  directory: WorkspaceDirectory,
  rawId: unknown,
  /** Runs once, after the first revoke of a key scoped to an `mcp-project` client. */
  onEndpointKeyRevoked?: (clientId: string) => Promise<void>,
): Promise<ApiResult> {
  const pathId = readPathId(rawId, 'API key');
  if (!pathId.ok) return pathId.result;
  const id = pathId.value;
  // See `changeMembershipRole` above for why the guard sits at the read. As in `deleteMembership`,
  // only the missing/blank check precedes it — a different fact, and one a guard placed above it
  // would swallow by answering 404 where a blank id gets `400 invalid_field`.
  if (!isUuid(id)) return apiKeyNotFound(id);

  const outcome: RevokeApiKeyOutcome = await directory.revokeApiKey(id);
  switch (outcome.kind) {
    case 'revoked':
      if (outcome.mcpProjectClientId !== null)
        await onEndpointKeyRevoked?.(outcome.mcpProjectClientId);
      return { status: 200, body: { apiKey: outcome.key } };
    case 'already-revoked':
      return { status: 200, body: { apiKey: outcome.key } };
    case 'no-such-key':
      return apiKeyNotFound(outcome.id);
    default:
      return unhandledOutcome('revokeApiKey', outcome);
  }
}
