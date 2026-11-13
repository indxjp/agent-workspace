/**
 * `agentPerson`: the person an agent tool call acts for (issue #1504), from a verified identity
 * assertion (ADR-0142).
 *
 * The assertion carries no role (ADR-0142 "Minimisation"), so for a `membership` subject the role
 * is looked up in the workspace's members, `GET /api/memberships` with the app's machine key (an
 * Admin's: the route is granted from Admin up). An `api-key` or `visitor` subject names no
 * workspace principal and holds no role: it passes no `member` or `role:*` rule, though a
 * `person()` field rule can still match its `sub`.
 *
 * shortcut: 60 s role cache, so a demoted member keeps the old role for up to 60 s; upgrade when
 * membership webhooks (N-3) exist.
 */
import type { IdentityAssertionPayload } from '@indx-workspace/contracts/identity-assertion';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';

import type { Person } from '../person.js';

/** How long a members list answers role lookups before it is fetched again. */
export const ROLE_CACHE_TTL_MS = 60_000;

/** One member as the role lookup needs it. */
export interface MemberRole {
  readonly principalId: string;
  readonly role: MembershipRoleName;
}

/** Where a member's role is looked up. */
export interface MemberDirectory {
  /** The role of the member `principalId`, or `null` when they are not a member. */
  roleOf(principalId: string): Promise<MembershipRoleName | null>;
}

/** What {@link cachedMemberDirectory} takes besides the list. */
export interface MemberDirectoryOptions {
  /** The clock the cache ages by, in epoch milliseconds; `Date.now` when not given. */
  readonly now?: () => number;
}

/**
 * A directory over `list` (the workspace's members), fetched at most once per
 * {@link ROLE_CACHE_TTL_MS}. Concurrent lookups share one fetch; a failed fetch is not cached, so
 * the next lookup tries again, and its error reaches the caller.
 */
export function cachedMemberDirectory(
  list: () => Promise<readonly MemberRole[]>,
  options: MemberDirectoryOptions = {},
): MemberDirectory {
  const now = options.now ?? Date.now;
  let cached:
    | { readonly at: number; readonly roles: Promise<ReadonlyMap<string, MembershipRoleName>> }
    | undefined;
  const rolesNow = (): Promise<ReadonlyMap<string, MembershipRoleName>> => {
    const at = now();
    if (cached !== undefined && at - cached.at < ROLE_CACHE_TTL_MS) return cached.roles;
    const roles = list().then(
      (members) =>
        new Map(members.map((member) => [member.principalId.toLowerCase(), member.role])),
    );
    const entry = { at, roles };
    cached = entry;
    roles.catch(() => {
      if (cached === entry) cached = undefined;
    });
    return roles;
  };
  return {
    async roleOf(principalId) {
      return (await rolesNow()).get(principalId.toLowerCase()) ?? null;
    },
  };
}

/**
 * The person a verified assertion names, acting through an agent in its run: `principalId` is the
 * assertion's `sub`, `workspaceId` its `workspace`, `runId` its `runId`, and `role` the member's
 * role for a `membership` subject (`null` when the subject is not, or no longer, a member) and
 * `null` for an `api-key` or `visitor` subject.
 */
export async function agentPerson(
  payload: IdentityAssertionPayload,
  directory: MemberDirectory,
): Promise<Person> {
  const role = payload.principalKind === 'membership' ? await directory.roleOf(payload.sub) : null;
  return Object.freeze({
    principalId: payload.sub,
    workspaceId: payload.workspace,
    role,
    via: 'agent' as const,
    runId: payload.runId,
  });
}
