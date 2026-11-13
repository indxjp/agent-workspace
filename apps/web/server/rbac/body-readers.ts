/**
 * Positive readers for the request bodies and path ids behind `/api/users`, `/api/memberships`,
 * `/api/api-keys` and `/api/invitations`.
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
 * {@link readConferredRole} → `conferRole` is the one place that asks *"may THIS caller confer THAT
 * role?"*, and every role-accepting handler goes through it. `core/conferral.ts` is the only module
 * that can produce a `ConferredRole`, and states the rule.
 */
import { conferRole, type ConferredRole } from './core/conferral';
import type { ApiResult } from '../http/result';
import { problem } from './http';
import { ROLES } from './core/roles';

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
 * refuse  500 authorisation_undecidable   the caller's role is not one of §21's four; nothing was decided
 * ```
 *
 * A malformed value — absent, not a string, not one of §21's four — is still a `400`, because that
 * is a fact about the request rather than about the caller's entitlement; `conferRole` reports it
 * as `refuse`, and this function turns that one case back into the `400` it always was. The only
 * other refusal is a caller role that is not one of the four, and it keeps its `500`: a `403` there
 * would assert that a rule was applied, and none was.
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
export function readExpiry(
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

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** A path `:id` that is present and not blank, or the `400` that says which resource's id is not. */
export function readPathId(
  id: unknown,
  resource: string,
): { ok: true; value: string } | { ok: false; result: ApiResult } {
  if (typeof id !== 'string' || id.trim() === '') {
    return {
      ok: false,
      result: problem(400, 'invalid_field', `The ${resource} id in the path is missing or blank.`),
    };
  }
  return { ok: true, value: id };
}
