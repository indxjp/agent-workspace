/**
 * The handlers behind `/api/users`, `/api/memberships`, `/api/api-keys` and `/api/me`.
 *
 * Every one of them takes a {@link WorkspaceDirectory} and plain data and returns an
 * {@link ApiResult}, so a test exercises them without a framework, a server or a network. The
 * route files under `apps/web/app/api/**` are the thin wiring above these, and `routes.test.ts`
 * imports those files and drives them with real `Request` objects so that the wiring itself is
 * covered rather than assumed.
 *
 * ## Validation is positive, and its `else` rejects
 *
 * Every reader below decides that a field *is* what it must be. There is no branch that accepts an
 * input because nothing objected to it: a body that is not an object, a role that is not one of
 * §21's four, an email that is not shaped like one, a name that is blank after trimming — each is
 * a named `400`. That is ADR-0015 applied to a request body.
 *
 * ## A role in a body is a *conferral*, and it is checked against the caller's own
 *
 * Four of the handlers below write a role into a row. Round 1 read that role with `parseRole`,
 * which asks only whether the value is one of §21's four — so an Admin could mint an API key with
 * `role: 'owner'` and authenticate as an Owner, and could `PATCH` its own membership row to
 * `owner` outright. The verifier built and ran both. The question `parseRole` never asked is
 * *"may THIS caller confer THAT role?"*, and it is now asked in exactly one place,
 * {@link readConferredRole} → `conferRole`, which every role-accepting handler here goes through
 * and which the type system enforces: the directory's role-writing inputs take a `ConferredRole`
 * and `conferral.ts` is the only module that can produce one. That file states the rule.
 */
import type {
  ApiKeySummary,
  CreateApiKeyOutcome,
  CreateMembershipOutcome,
  CreateUserOutcome,
  DeleteMembershipOutcome,
  MembershipChangeOutcome,
  MembershipSummary,
  RevokeApiKeyOutcome,
  WorkspaceDirectory,
} from './directory';
import { conferRole, type ConferredRole } from './conferral';
import { problem, type ApiResult } from './http';
import type { Principal, PrincipalKind } from './principal';
import { ROLES, type Role } from './roles';

function publicMembership(membership: MembershipSummary) {
  return {
    id: membership.id,
    principalId: membership.principalId,
    userId: membership.userId,
    email: membership.email,
    name: membership.name,
    role: membership.role,
    createdAt: membership.createdAt,
  };
}

/**
 * The body of a request, as an object, or the problem that says why it is not one.
 *
 * Exported — with {@link readString} below — so `apps/web/server/workspaces/handlers.ts` (also
 * this task's `Owns`) imports these instead of carrying a second, byte-identical copy;
 * verification round 1, finding 6, found jscpd reporting exactly that clone.
 */
export function asObject(
  value: unknown,
): { ok: true; body: Record<string, unknown> } | { ok: false; result: ApiResult } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'The request body must be a JSON object.'),
    };
  }
  return { ok: true, body: value as Record<string, unknown> };
}

/** A required non-blank string field. See {@link asObject}'s comment for why this is exported. */
export function readString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; result: ApiResult } {
  const raw = body[field];
  if (typeof raw !== 'string') {
    return {
      ok: false,
      result: problem(400, 'invalid_field', `"${field}" must be a string.`),
    };
  }
  const value = raw.trim();
  if (value === '') {
    return {
      ok: false,
      result: problem(400, 'invalid_field', `"${field}" must not be blank.`),
    };
  }
  if (value.length > maxLength) {
    return {
      ok: false,
      result: problem(
        400,
        'invalid_field',
        `"${field}" is longer than ${String(maxLength)} characters.`,
      ),
    };
  }
  return { ok: true, value };
}

/**
 * The same shape check `users_email_shape` applies in PostgreSQL: no whitespace, exactly one `@`,
 * a dot in the domain. Not an RFC 5322 parser, and deliberately the same rule in both places so
 * that an address this route accepts is one the table accepts.
 *
 * Exported — with {@link readConferredRole} below — so
 * `apps/web/server/invitations/handlers.ts` (issue #121, also this task's `Owns`) reuses these
 * instead of carrying a second copy of the same shape check and the same conferral gate; see
 * `asObject`'s comment above for the precedent this follows.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function readEmail(
  body: Record<string, unknown>,
): { ok: true; value: string } | { ok: false; result: ApiResult } {
  const field = readString(body, 'email', 320);
  if (!field.ok) return field;
  const value = field.value.toLowerCase();
  if (!EMAIL_SHAPE.test(value)) {
    return {
      ok: false,
      result: problem(400, 'invalid_field', '"email" is not shaped like an email address.'),
    };
  }
  return { ok: true, value };
}

/**
 * The `role` field of a request body, as a role **this caller is entitled to confer**.
 *
 * Three answers, not two, because `conferRole` has three:
 *
 * ```text
 * allow   the caller holds at least everything §21 grants the requested role
 * deny    403 forbidden_role_conferral    §21 grants that role something the caller has not got
 * refuse  500 authorisation_undecidable   the two cannot be compared; nothing was decided
 * ```
 *
 * A malformed value — absent, not a string, not one of §21's four — is still a `400`, because that
 * is a fact about the request rather than about the caller's entitlement; `conferRole` reports it
 * as `refuse`, and this function turns that one case back into the `400` it always was. Every
 * other refusal keeps its `500`: a `403` there would assert that a rule was applied, and none was.
 */
export function readConferredRole(
  body: Record<string, unknown>,
  callerRole: unknown,
): { ok: true; value: ConferredRole } | { ok: false; result: ApiResult } {
  const requested = body['role'];
  const conferral = conferRole(callerRole, requested);
  switch (conferral.effect) {
    case 'allow':
      return { ok: true, value: conferral.role };
    case 'deny':
      return { ok: false, result: problem(403, 'forbidden_role_conferral', conferral.because) };
    case 'refuse':
      // The one refusal that is a fact about the body rather than about the comparison: the value
      // is not a role at all. It was a 400 before this check existed and it stays one.
      if (typeof requested !== 'string' || !ROLES.some((role) => role === requested)) {
        return {
          ok: false,
          result: problem(
            400,
            'invalid_field',
            `"role" must be one of spec §21's four roles: ${ROLES.join(', ')}.`,
          ),
        };
      }
      return {
        ok: false,
        result: problem(
          500,
          'authorisation_undecidable',
          `${conferral.because} No conferral decision was made, so this role was neither granted ` +
            `nor refused on its merits.`,
        ),
      };
    default: {
      const unreachable: never = conferral;
      throw new Error(`unclassified conferral ${JSON.stringify(unreachable)} — refusing to grant`);
    }
  }
}

/** An optional ISO-8601 expiry, or `null`. Absent and explicit `null` mean the same thing. */
function readExpiry(
  body: Record<string, unknown>,
): { ok: true; value: string | null } | { ok: false; result: ApiResult } {
  const raw = body['expiresAt'];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string' || Number.isNaN(new Date(raw).getTime())) {
    return {
      ok: false,
      result: problem(
        400,
        'invalid_field',
        '"expiresAt" must be an ISO-8601 timestamp, or null for a key that does not expire.',
      ),
    };
  }
  return { ok: true, value: new Date(raw).toISOString() };
}

/**
 * RFC 9562 canonical textual form, any version — the same predicate every other resource module in
 * this repository declares privately for itself (`apps/web/server/workspaces/access.ts` records
 * that standing decision, and `server/{agents,runs,models,secrets,runtimes}` each carry their own).
 *
 * Every `:id` this module reads a row by is a `uuid` column — `memberships.id`
 * (`packages/core/src/db/schema/memberships.ts`) and `api_keys.id`
 * (`packages/core/src/db/schema/api-keys.ts`), both `primaryKeyId()` — so a path segment that is
 * not a UUID reaches PostgreSQL as an invalid literal and raises `22P02 invalid input syntax for
 * type uuid`. Nothing above these handlers catches it — `authorise` calls them with no
 * `try`/`catch` — so without this check a malformed id escapes as an unhandled error instead of
 * the refusal an unknown id gets.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

// ── me ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The wire spelling of a {@link PrincipalKind} (issue #233).
 *
 * `workspace_principals.kind` stores `api_key` under a CHECK constraint
 * (`packages/core/src/db/schema/workspace-principals.ts`), so the stored value cannot be renamed
 * without a migration; every enum `@indx-workspace/contracts` publishes is kebab-case. The two
 * therefore differ by one character and this is the single place that reconciles them.
 *
 * A total `switch` with no `default` arm: a third principal kind is a compile error here rather
 * than a value that leaks the stored spelling, or `undefined`, onto the wire.
 */
export type WirePrincipalKind = 'membership' | 'api-key';

export function wireKind(kind: PrincipalKind): WirePrincipalKind {
  switch (kind) {
    case 'membership':
      return 'membership';
    case 'api_key':
      return 'api-key';
  }
}

/**
 * The six fields `GET /api/me` publishes, and no seventh.
 *
 * Declared positively rather than derived from `Principal` by a spread or an `Omit`: the
 * `Principal` this is built from also carries `actor`, `via` and `apiKeyId`, and a
 * spread-and-serialise implementation would publish all three. A field added to `Principal`
 * tomorrow is invisible to this type by construction, and `me.test.ts` plus
 * `sdk-conformance.test.ts` scan the rendered JSON rather than trusting the annotation.
 */
export interface MePrincipal {
  readonly principalId: string;
  readonly kind: WirePrincipalKind;
  readonly role: Role;
  readonly workspaceId: string;
  /** `users.id` for a membership principal; `null` for exactly an API-key principal. */
  readonly userId: string | null;
  /** Display attribution — the member's name or the key's name. Never an authorization input. */
  readonly label: string;
}

/**
 * `GET /api/me` — the principal this credential resolves to.
 *
 * There is no failure arm and no directory read. `authorise` has already answered the only two
 * questions this route has: a caller it could not identify is `401 unauthenticated` (which is
 * what a revoked key and an expired session both are), and everything past that point carries a
 * real {@link Principal}. So this is a pure projection, and it is the whole handler.
 */
export function readMe(principal: Principal): ApiResult {
  const body: MePrincipal = {
    principalId: principal.principalId,
    kind: wireKind(principal.kind),
    role: principal.role,
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    label: principal.label,
  };
  return { status: 200, body };
}

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
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled createUser outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

// ── memberships ─────────────────────────────────────────────────────────────────────────────

/** `GET /api/memberships` — who belongs to this workspace, and with which of §21's four roles. */
export async function listMemberships(directory: WorkspaceDirectory): Promise<ApiResult> {
  const memberships = (await directory.listMemberships()).map(publicMembership);
  return { status: 200, body: { memberships } };
}

/** `POST /api/memberships` — attach an existing user to this workspace. */
export async function createMembership(
  directory: WorkspaceDirectory,
  callerRole: unknown,
  body: unknown,
): Promise<ApiResult> {
  const object = asObject(body);
  if (!object.ok) return object.result;
  const email = readEmail(object.body);
  if (!email.ok) return email.result;
  const role = readConferredRole(object.body, callerRole);
  if (!role.ok) return role.result;

  const outcome: CreateMembershipOutcome = await directory.createMembership({
    email: email.value,
    role: role.value,
  });
  switch (outcome.kind) {
    case 'created':
      return { status: 201, body: { membership: publicMembership(outcome.membership) } };
    case 'no-such-user':
      return problem(
        404,
        'no_such_user',
        `No user exists with the address ${outcome.email}. Create the user first.`,
      );
    case 'already-a-member':
      return problem(
        409,
        'already_a_member',
        `${outcome.email} already belongs to this workspace; change the role instead.`,
      );
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled createMembership outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The one answer both verbs below give for a membership this workspace has not got — whether the
 * id named no row, or could not name one at all. One function rather than three copies of the
 * sentence, so the malformed-id guard cannot drift away from the directory's own answer; the id is
 * echoed because that is what the existing `no-such-membership` detail does, and dropping it would
 * change the response every caller who sends a well-formed unknown UUID already gets.
 */
function membershipNotFound(id: string): ApiResult {
  return problem(404, 'no_such_membership', `No membership ${id} in this workspace.`);
}

/**
 * A caller may change or remove only a member whose CURRENT role it could itself confer: an Admin
 * cannot demote or remove an Owner. `null` when the caller may act, or when no such row exists (the
 * directory then answers its own 404).
 */
async function refuseUnlessCallerOutranks(
  directory: WorkspaceDirectory,
  callerRole: unknown,
  id: string,
): Promise<ApiResult | null> {
  const target = (await directory.listMemberships()).find((membership) => membership.id === id);
  if (target === undefined) return null;
  const conferral = conferRole(callerRole, target.role);
  if (conferral.effect === 'allow') return null;
  return problem(
    403,
    'forbidden_role_conferral',
    `This member holds "${target.role}", a role this caller could not confer, so it cannot ` +
      `change or remove it. ${conferral.because}`,
  );
}

/** `PATCH /api/memberships/:id` — change one member's role. */
export async function changeMembershipRole(
  directory: WorkspaceDirectory,
  callerRole: unknown,
  id: unknown,
  body: unknown,
): Promise<ApiResult> {
  if (typeof id !== 'string' || id.trim() === '') {
    return problem(400, 'invalid_field', 'The membership id in the path is missing or blank.');
  }
  const object = asObject(body);
  if (!object.ok) return object.result;
  const role = readConferredRole(object.body, callerRole);
  if (!role.ok) return role.result;

  // At the read, not at the top of the handler. This guard stands in for a row read that finds
  // nothing, so it must answer only where that read would have happened: above the two checks
  // before it, a malformed id would get a 404 where an unknown UUID gets `400 malformed_body` or
  // `403 forbidden_role_conferral` — a *different* answer from the one it exists to make identical.
  if (!isUuid(id)) return membershipNotFound(id);
  const outranked = await refuseUnlessCallerOutranks(directory, callerRole, id);
  if (outranked !== null) return outranked;

  const outcome: MembershipChangeOutcome = await directory.changeMembershipRole(id, role.value);
  switch (outcome.kind) {
    case 'changed':
      return { status: 200, body: { membership: publicMembership(outcome.membership) } };
    case 'no-such-membership':
      return membershipNotFound(outcome.id);
    case 'last-owner':
      return problem(
        409,
        'last_owner',
        'This is the workspace’s last Owner. Spec §21 gives Owner everything, so demoting the ' +
          'last one leaves a workspace nobody can administer. Promote another member first.',
      );
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled changeMembershipRole outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

/** `DELETE /api/memberships/:id` — remove a member from this workspace. */
export async function deleteMembership(
  directory: WorkspaceDirectory,
  callerRole: unknown,
  id: unknown,
): Promise<ApiResult> {
  if (typeof id !== 'string' || id.trim() === '') {
    return problem(400, 'invalid_field', 'The membership id in the path is missing or blank.');
  }
  // See `changeMembershipRole` above for why the guard sits at the read. Only the missing/blank
  // check precedes it here — a different fact, and one a guard placed above it would swallow by
  // answering 404 where a blank id gets `400 invalid_field`. Same rule, first position it applies.
  if (!isUuid(id)) return membershipNotFound(id);
  const outranked = await refuseUnlessCallerOutranks(directory, callerRole, id);
  if (outranked !== null) return outranked;

  const outcome: DeleteMembershipOutcome = await directory.deleteMembership(id);
  switch (outcome.kind) {
    case 'deleted':
      return { status: 204, body: null };
    case 'no-such-membership':
      return membershipNotFound(outcome.id);
    case 'last-owner':
      return problem(
        409,
        'last_owner',
        'This is the workspace’s last Owner; removing it leaves a workspace nobody can administer.',
      );
    case 'membership-in-use':
      return problem(409, 'membership_in_use', MEMBERSHIP_IN_USE_MESSAGES[outcome.dependency]);
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled deleteMembership outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The `409 membership_in_use` message for each dependency that keeps a member. */
const MEMBERSHIP_IN_USE_MESSAGES: Readonly<
  Record<Extract<DeleteMembershipOutcome, { kind: 'membership-in-use' }>['dependency'], string>
> = {
  projects:
    'This member still owns projects in this workspace. Delete or reassign those projects ' +
    'before removing the membership.',
  'local-runtime-keys':
    'Local runtime keys created by `aw dev` acted for this member and still reference it. ' +
    'Removing a member that a local runtime key acted for is not supported.',
};

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
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled createApiKey outcome ${JSON.stringify(unreachable)}`);
    }
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
  id: unknown,
  /** Runs once, after the first revoke of a key scoped to an `mcp-project` client. */
  onEndpointKeyRevoked?: (clientId: string) => Promise<void>,
): Promise<ApiResult> {
  if (typeof id !== 'string' || id.trim() === '') {
    return problem(400, 'invalid_field', 'The API key id in the path is missing or blank.');
  }
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
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled revokeApiKey outcome ${JSON.stringify(unreachable)}`);
    }
  }
}
