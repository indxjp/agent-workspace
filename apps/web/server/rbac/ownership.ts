/**
 * Compatibility helpers for code that still needs a human `users.id` while ownership moves to
 * WorkspacePrincipal. These helpers never invent a human identity. In particular, an API key and
 * a vanished Membership resolve to `null`; callers must refuse or use the principal id directly.
 */
import type { MembershipSummary } from './directory';
import type { Principal } from './principal';
import { applicationContext } from '../application-context';

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

/** Resolve a session email to the exact current Membership user, without any fallback. */
export function resolveMemberUserId(
  memberships: readonly MembershipSummary[],
  actor: string,
): string | null {
  const wanted = normalise(actor);
  return memberships.find((member) => normalise(member.email) === wanted)?.userId ?? null;
}

/**
 * Legacy session-only lookup retained for membership administration call sites. It resolves only
 * the supplied email; a miss is `null` and never another member.
 */
export function resolveSessionActorUserId(
  memberships: readonly MembershipSummary[],
  actor: string,
): string | null {
  return resolveMemberUserId(memberships, actor);
}

/** Exact current user id for a verified Membership principal, or `null` after removal. */
export async function resolveSessionActorUserIdForWorkspace(
  workspaceId: string,
  principal: Principal,
): Promise<string | null> {
  const runtime = applicationContext()?.rbac ?? null;
  if (
    runtime === null ||
    principal.workspaceId !== workspaceId ||
    principal.kind !== 'membership' ||
    principal.userId === null
  ) {
    return null;
  }
  const memberships = await runtime.directory.forWorkspace(workspaceId).listMemberships();
  return memberships.some(
    (member) => member.principalId === principal.principalId && member.userId === principal.userId,
  )
    ? principal.userId
    : null;
}
