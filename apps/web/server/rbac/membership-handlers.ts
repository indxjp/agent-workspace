/**
 * The handlers behind `/api/memberships`: who belongs to a workspace, with which of §21's four
 * roles, and the rule that a caller may only change or remove a member whose current role it could
 * itself confer.
 */
import type {
  CreateMembershipOutcome,
  DeleteMembershipOutcome,
  MembershipChangeOutcome,
  MembershipSummary,
  WorkspaceDirectory,
} from './directory';
import { asObject, isUuid, readConferredRole, readEmail, readPathId } from './body-readers';
import { conferRole } from './core/conferral';
import type { ApiResult } from '../http/result';
import { problem } from './http';
import { unhandledOutcome } from './unhandled-outcome';

export function publicMembership(membership: MembershipSummary) {
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
    default:
      return unhandledOutcome('createMembership', outcome);
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
  // A uuid column matches in any case, so the path id is compared in lower case.
  const wanted = id.toLowerCase();
  const target = (await directory.listMemberships()).find(
    (membership) => membership.id.toLowerCase() === wanted,
  );
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
  rawId: unknown,
  body: unknown,
): Promise<ApiResult> {
  const pathId = readPathId(rawId, 'membership');
  if (!pathId.ok) return pathId.result;
  const id = pathId.value;
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
    default:
      return unhandledOutcome('changeMembershipRole', outcome);
  }
}

/** `DELETE /api/memberships/:id` — remove a member from this workspace. */
export async function deleteMembership(
  directory: WorkspaceDirectory,
  callerRole: unknown,
  rawId: unknown,
): Promise<ApiResult> {
  const pathId = readPathId(rawId, 'membership');
  if (!pathId.ok) return pathId.result;
  const id = pathId.value;
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
    default:
      return unhandledOutcome('deleteMembership', outcome);
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
