/**
 * The read model both users of `GET /api/workspaces` share — the sidebar switcher
 * (`workspace-switcher.tsx`) and the `/workspaces` screen
 * (`apps/web/app/(shell)/workspaces/workspaces-screen.tsx`) — so the two cannot drift into two
 * different ideas of what a membership row looks like. Mirrors
 * `apps/web/server/workspaces/handlers.ts`'s `serialiseMembershipView`/`serialiseWorkspace`
 * exactly, field for field, because that is the only contract either screen has: issue #119's
 * routes are not this task's `Owns`, so this file reads their JSON the way a real browser would,
 * never their TypeScript.
 *
 * ## Why this does not reuse `apps/web/components/agents/model.ts`'s `isApiErrorEnvelope`
 *
 * `apps/web/server/rbac/http.ts`'s `problem()` — what every `/api/workspaces` route answers a
 * non-2xx with — is the standard `{ error: { code, message, detail } }` (ADR-0075: `detail`
 * repeats `message` until the next major release (ADR-0078 D7)). This reader stays exact about the keys it accepts, so it
 * names both spellings it understands: the current `{ code, message, detail }` and the earlier
 * `{ code, detail }`. It prefers `message` when present. Accepting only the earlier spelling would
 * read every refusal as "no envelope", so a `401` would no longer trigger session recovery.
 */
import { MEMBERSHIP_ROLES, type MembershipRoleName } from '@indx-workspace/contracts/team';

const ROLES: ReadonlySet<string> = new Set<string>(MEMBERSHIP_ROLES);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UTC_MILLISECOND_TIMESTAMP =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

const RESOURCE_KEYS = [
  'id',
  'slug',
  'name',
  'archivedAt',
  'publicSharingEnabled',
  'createdAt',
  'updatedAt',
] as const;
const MEMBERSHIP_KEYS = [...RESOURCE_KEYS, 'role'] as const;
const LIST_KEYS = ['workspaces'] as const;

function isRole(value: unknown): value is MembershipRoleName {
  return typeof value === 'string' && ROLES.has(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactRecord<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Record<Key, unknown> | null {
  const candidate = record(value);
  if (candidate === null) return null;
  const actualKeys = Object.keys(candidate);
  if (actualKeys.length !== keys.length || !keys.every((key) => Object.hasOwn(candidate, key))) {
    return null;
  }
  return candidate;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** The workspace API serialises `Date` with `toISOString()`: UTC, exactly three fractional digits.
 * The calendar check is load-bearing as well as the grammar: JavaScript's date parser normalises
 * impossible dates such as February 30, while an owned response must refuse them. */
function isUtcMillisecondTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_MILLISECOND_TIMESTAMP.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  let maximumDay = 31;
  if (month === 2) maximumDay = isLeapYear ? 29 : 28;
  else if (month === 4 || month === 6 || month === 9 || month === 11) maximumDay = 30;
  return day <= maximumDay;
}

/** The fields every workspace response carries, including a successful `PATCH`. */
export interface WorkspaceResource {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly archivedAt: string | null;
  readonly publicSharingEnabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A collection/item membership view. Unlike a mutation response, it also carries the caller's role. */
export interface WorkspaceMembership extends WorkspaceResource {
  readonly role: MembershipRoleName;
}

function parseWorkspaceFields(
  row: Record<(typeof RESOURCE_KEYS)[number], unknown>,
): WorkspaceResource | null {
  if (!isUuid(row['id'])) return null;
  if (typeof row['slug'] !== 'string') return null;
  if (typeof row['name'] !== 'string') return null;
  if (row['archivedAt'] !== null && !isUtcMillisecondTimestamp(row['archivedAt'])) return null;
  if (typeof row['publicSharingEnabled'] !== 'boolean') return null;
  if (!isUtcMillisecondTimestamp(row['createdAt'])) return null;
  if (!isUtcMillisecondTimestamp(row['updatedAt'])) return null;
  return {
    id: row['id'],
    slug: row['slug'],
    name: row['name'],
    archivedAt: row['archivedAt'],
    publicSharingEnabled: row['publicSharingEnabled'],
    createdAt: row['createdAt'],
    updatedAt: row['updatedAt'],
  };
}

function asWorkspaceMembership(value: unknown): WorkspaceMembership | null {
  const row = exactRecord(value, MEMBERSHIP_KEYS);
  if (row === null || !isRole(row['role'])) return null;
  const workspace = parseWorkspaceFields(row);
  if (workspace === null) return null;
  return { ...workspace, role: row['role'] };
}

/**
 * `GET /api/workspaces`'s `{ workspaces: [...] }` body. Every entry must match the landed route's
 * contract: silently dropping one would make the switcher list fewer than exactly the server's
 * answer and conceal a contract regression. `null` means the body is not a valid workspace-list
 * response at all, so callers show a transport/contract problem rather than an incomplete list.
 */
export function parseWorkspaceList(body: unknown): readonly WorkspaceMembership[] | null {
  const outer = exactRecord(body, LIST_KEYS);
  if (outer === null || !Array.isArray(outer.workspaces)) return null;
  const out: WorkspaceMembership[] = [];
  for (const entry of outer.workspaces) {
    const parsed = asWorkspaceMembership(entry);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** What a screen knows about a failed `/api/workspaces` request, at any moment. */
export type WorkspacesProblem =
  | {
      readonly kind: 'api';
      readonly status: number;
      readonly code: string;
      readonly detail: string;
    }
  | { readonly kind: 'transport'; readonly reason: string };

/**
 * Whether the caller may rename, archive or restore this membership's workspace — issue #119's
 * `ownerOwnershipResolver`, read back off the one field the server actually hands the client: the
 * caller's own role on this row. There is no separate capability object (the card's own words);
 * this is the single, positive predicate every rename/archive/restore control in this task gates
 * on, so a `role` typo in one control cannot disagree with another.
 */
export function canAdministerWorkspace(membership: Pick<WorkspaceMembership, 'role'>): boolean {
  return membership.role === 'owner';
}

/** The one membership in `items` whose slug is the caller's current session workspace, or
 * `undefined` — the session names it, but only a `GET /api/workspaces` answer carries its
 * archived state and the caller's role on it (`apps/web/app/(shell)/layout.tsx`'s
 * `resolveIdentity` reads a different, narrower directory port that has neither field). */
export function findCurrentMembership(
  items: readonly WorkspaceMembership[],
  currentSlug: string,
): WorkspaceMembership | undefined {
  return items.find((item) => item.slug === currentSlug);
}
