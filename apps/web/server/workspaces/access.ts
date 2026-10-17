/**
 * The two {@link OwnershipResolver}s `/api/workspaces/:id` routes need — issue #119's
 * "cross-workspace enumeration is prevented" and "an Owner can rename/update/archive; unauthorized
 * users cannot", both read off the caller's *real* membership of the workspace named in the path,
 * never off `principal.role` (that is the caller's role in their *session* workspace, which need
 * not be this one — see `runtime.ts`'s header).
 *
 * Both resolvers answer the same indistinguishable 404 for "no such workspace" and "not a member of
 * it" — issue #117's concealment rule, applied here to the tenant row itself rather than to an item
 * inside one. {@link memberOwnershipResolver} then allows any current membership; {@link
 * ownerOwnershipResolver} additionally requires the membership's role to be Owner, and — unlike the
 * 404 case — answers a genuine `other` for a real, lesser-privileged member: that caller already
 * knows the workspace exists (it is in their own `GET /api/workspaces` list), so `decide()`'s `403`
 * is a decision actually measured against them, not an oracle for existence.
 *
 * ## API-key callers
 *
 * `/api/workspaces` administers human Memberships, while an API-key principal has no Membership
 * user id with which to call `getForMember`. `docs/adr/W9-WS-119-api-key-callers-are-refused.md`
 * therefore records the decision to refuse every workspace route before attempting that lookup.
 *
 * ## Membership removal races
 *
 * A session Membership can disappear after `identify()` verifies the session but before a route's
 * `listMemberships()` read. Every workspace route therefore resolves only the session caller's
 * exact current Membership through {@link resolveSessionActorUserId} or
 * {@link resolveSessionActorUserIdForWorkspace}; a miss returns `null` and is refused. The proof is
 * `vanished-membership.test.ts`, which removes the caller's Membership between reads and asserts
 * that every route fails closed.
 */
import {
  problem,
  type ApiResult,
  type OwnershipOutcome,
  type OwnershipResolver,
} from '../rbac/http';
import { resolveSessionActorUserId } from '../rbac/ownership';
import type { Principal } from '../rbac/principal';
import type { WorkspaceRepositoryPort } from './runtime';

/**
 * RFC 9562 canonical textual form, any version — the same pattern every other resource module in
 * this repository declares privately for itself (`apps/web/server/{agents,runs,models,…}`). `id`
 * is a `uuid` column, so a non-UUID path segment is rejected here rather than handed to
 * `getForMember`, which would otherwise reach PostgreSQL as an invalid literal and throw instead
 * of answering "not found".
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * The one 404 every refusal in this module — and `GET /api/workspaces/:id`'s own second identity
 * resolution — answers with, so "no such workspace", "not a member" and "membership vanished
 * mid-request" are byte-identical over HTTP (issue #117's concealment rule).
 */
export function workspaceNotFound(): ReturnType<typeof problem> {
  return problem(
    404,
    'workspace_not_found',
    'No workspace with that id, or it is not one of the caller’s current memberships.',
  );
}

/**
 * `/api/workspaces` administers Memberships — issue #119's whole surface is "which workspaces does
 * this *person* belong to, and what may they do in one" — and an API key has no Membership of its
 * own to answer that question with (§21/§27: a key carries a workspace and a role, never a
 * person). `docs/adr/W9-WS-119-api-key-callers-are-refused.md` records the decision to refuse every
 * one of the four `/api/workspaces` routes to `via === 'api-key'` rather than invent a human
 * identity for it.
 */
export function apiKeyRefusal(principal: Principal): ApiResult | null {
  return principal.via === 'api-key'
    ? problem(
        403,
        'api_key_not_permitted',
        'API keys act for one workspace with a fixed role; they cannot list, create, read or ' +
          'administer workspace records. Use a session.',
      )
    : null;
}

/**
 * The three checks both resolvers below share, in the order that keeps each cheap: a malformed id
 * needs no identity to reject, and an API-key principal needs no membership lookup to reject.
 * Returns the resolved `{ view, actorUserId }` once a `getForMember` read is actually warranted,
 * or the `OwnershipOutcome` to return immediately.
 */
async function resolveMembershipView(
  repository: WorkspaceRepositoryPort,
  id: unknown,
  principal: Principal,
  directory: Parameters<OwnershipResolver>[1],
): Promise<
  | { readonly outcome: OwnershipOutcome; readonly view?: undefined }
  | {
      readonly outcome?: undefined;
      readonly view: NonNullable<Awaited<ReturnType<WorkspaceRepositoryPort['getForMember']>>>;
    }
> {
  if (!isUuid(id)) return { outcome: { kind: 'refuse', result: workspaceNotFound() } };
  const refusal = apiKeyRefusal(principal);
  if (refusal !== null) return { outcome: { kind: 'refuse', result: refusal } };
  // Resolve only the session caller's exact current Membership. If it disappeared after
  // `identify()`, refuse instead of continuing with an identity that is no longer authorized.
  const memberships = await directory.listMemberships();
  const actorUserId = resolveSessionActorUserId(memberships, principal.actor);
  if (actorUserId === null) return { outcome: { kind: 'refuse', result: workspaceNotFound() } };
  const view = await repository.getForMember(id, actorUserId);
  if (view === null) return { outcome: { kind: 'refuse', result: workspaceNotFound() } };
  return { view };
}

/** `'own'` for any current membership of `id`; the 404 concealment otherwise. */
export function memberOwnershipResolver(
  repository: WorkspaceRepositoryPort,
  id: unknown,
): OwnershipResolver {
  return async (principal, directory): Promise<OwnershipOutcome> => {
    const resolved = await resolveMembershipView(repository, id, principal, directory);
    return resolved.outcome ?? { kind: 'ownership', ownership: 'own' };
  };
}

/**
 * `'own'` only when the caller's role in `id` is Owner. A real member with a lesser role is
 * `'other'`, which `decide()` denies with a genuine `403` (this file's header explains why that is
 * safe rather than an existence leak). A non-member, and a non-UUID `id`, get the same 404 {@link
 * memberOwnershipResolver} gives.
 */
export function ownerOwnershipResolver(
  repository: WorkspaceRepositoryPort,
  id: unknown,
): OwnershipResolver {
  return async (principal, directory): Promise<OwnershipOutcome> => {
    const resolved = await resolveMembershipView(repository, id, principal, directory);
    if (resolved.outcome !== undefined) return resolved.outcome;
    return { kind: 'ownership', ownership: resolved.view.role === 'owner' ? 'own' : 'other' };
  };
}
