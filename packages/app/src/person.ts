/**
 * Who is asking: the person a page, a route or an agent tool acts for, and the one access check
 * every store operation runs (issue #1502).
 *
 * Pure: the store, the routes and the agent tools share it, so an access rule means the same thing
 * wherever it is checked. Resolving a {@link Person} from a request (the platform session or the
 * identity assertion of an agent call) is the server's job; this module takes one as given.
 */
import { MEMBERSHIP_ROLES, type MembershipRoleName } from '@indx-workspace/contracts/team';

import type { AccessRule } from './resource.js';

/** The person an operation runs for, and how: in person, or through an agent acting for them. */
export interface Person {
  /** The workspace principal id, or the opaque subject of an identity assertion (ADR-0142). */
  readonly principalId: string;
  readonly workspaceId: string;
  /** The person's role in the workspace; `null` when they are not a member of it. */
  readonly role: MembershipRoleName | null;
  /** `'agent'` when an agent run acts for the person; it never exceeds their own access. */
  readonly via: 'person' | 'agent';
  /** The run an agent acts in. Every agent write carries it. */
  readonly runId?: string;
}

/**
 * The rank of each role: a higher role holds every grant of a lower one (roles are monotonic,
 * ADR-0152), so `role:builder` admits a builder, an admin and an owner.
 */
const ROLE_RANK: Readonly<Record<MembershipRoleName, number>> = {
  owner: 3,
  admin: 2,
  builder: 1,
  viewer: 0,
};

const ROLE_PREFIX = 'role:';

function isRoleName(value: string): value is MembershipRoleName {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

/** Whether `rule` names no role and is not `'member'`: then it names a `person()` field. */
export function isPersonFieldRule(rule: AccessRule): boolean {
  return rule !== 'member' && !rule.startsWith(ROLE_PREFIX);
}

/** Whether one rule admits `person`, without looking at a record: `'member'` or a role. */
function allowsWithoutRow(rule: AccessRule, person: Person): boolean {
  if (person.role === null) return false;
  if (rule === 'member') return true;
  const role = rule.slice(ROLE_PREFIX.length);
  return isRoleName(role) && ROLE_RANK[person.role] >= ROLE_RANK[role];
}

/**
 * Whether `rule` (or any one of a list of rules) admits `person`, on `row` when given.
 *
 * - `'member'`: any member of the workspace; a person whose role is `null` never passes.
 * - `'role:<x>'`: a member whose role is `x` or higher (owner > admin > builder > viewer).
 * - a `person()` field name: the record's field holds the person's principal id. Without a row
 *   (or with the field unset) it does not pass.
 *
 * An empty list admits nobody.
 */
export function allows(
  rule: AccessRule | readonly AccessRule[],
  person: Person,
  row?: Readonly<Record<string, unknown>>,
): boolean {
  const rules: readonly AccessRule[] = typeof rule === 'string' ? [rule] : rule;
  return rules.some((one) =>
    isPersonFieldRule(one) ? row?.[one] === person.principalId : allowsWithoutRow(one, person),
  );
}
