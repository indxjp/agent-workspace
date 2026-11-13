/**
 * The tables of the in-memory `DirectoryRoot` and the rules every operation over them shares.
 *
 * `../memory-directory.ts` seeds one {@link MemoryDirectoryState} and answers the root operations;
 * `workspace.ts` answers the workspace-scoped ones. Both read and write the rows only through this
 * module's lookups, so a uniqueness or hashing rule is stated once.
 */
import type {
  ApiKeySummary,
  InvitationSummary,
  MembershipSummary,
  StoredApiKey,
  UserSummary,
} from '../directory';
import type { Role } from '../core/roles';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface MembershipRow {
  id: string;
  principalId: string;
  workspaceId: string;
  userId: string;
  role: Role;
  createdAt: string;
}

export interface ApiKeyRow {
  id: string;
  workspaceId: string;
  name: string;
  role: Role;
  keyId: string;
  keyPrefix: string;
  keyHash: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface InvitationRow {
  id: string;
  workspaceId: string;
  email: string;
  role: Role;
  invitedBy: string | null;
  tokenHash: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * A workspace's display name, for the sole purpose of `DirectoryRoot.membershipsForUser`.
 *
 * This in-memory directory otherwise treats a workspace id as an opaque string — it has no
 * `workspaces` table of its own, unlike the PostgreSQL implementation. A test that does not name
 * a workspace here gets its id back as both the slug and the name, which is deliberately not a
 * placeholder: most tests choose workspace ids that already read as slugs (`'acme'`, `'ws-a'`),
 * and inventing a different display name for those would prove nothing a real deployment does.
 */
export interface SeedWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** Non-null means the workspace is archived and cannot accept new memberships. */
  readonly archivedAt?: string | null;
}

/** Every table of one in-memory directory, plus its injected clock and identifier source. */
export interface MemoryDirectoryState {
  readonly users: Map<string, UserRow>;
  readonly memberships: Map<string, MembershipRow>;
  readonly apiKeys: Map<string, ApiKeyRow>;
  readonly invitations: Map<string, InvitationRow>;
  readonly workspaceNames: Map<string, SeedWorkspace>;
  /**
   * Keyed by `${issuer}\u0000${subject}`, which cannot collide the way string concatenation with
   * no separator can (an issuer ending where a subject begins is otherwise ambiguous).
   */
  readonly identities: Map<string, string>;
  readonly now: () => Date;
  readonly newId: () => string;
}

export function isoOf(date: Date): string {
  return date.toISOString();
}

/**
 * `users.email` is stored lower-case and PostgreSQL enforces it (`users_email_lowercase`). Doing
 * it here too keeps the two implementations answering the same question about the same input.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Keep source and principal identities distinct, stable, and UUID-shaped, as PostgreSQL does. */
export function principalId(kind: 'membership' | 'api_key', sourceId: string): string {
  const input = `${kind}:${sourceId}`;
  const lanes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (const [index, character] of [...input].entries()) {
    const lane = index % lanes.length;
    const current = lanes[lane];
    if (current === undefined) throw new Error('principal id hash lane is missing');
    lanes[lane] = Math.imul(current ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  const hex = lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The row exists and belongs to `workspaceId`; any other workspace's row reads as absent. */
export function inWorkspace<Row extends { readonly workspaceId: string }>(
  row: Row | undefined,
  workspaceId: string,
): row is Row {
  return row !== undefined && row.workspaceId === workspaceId;
}

export function userByEmail(state: MemoryDirectoryState, email: string): UserRow | null {
  for (const row of state.users.values()) if (row.email === email) return row;
  return null;
}

export function membershipOf(
  state: MemoryDirectoryState,
  workspaceId: string,
  userId: string,
): MembershipRow | null {
  for (const row of state.memberships.values()) {
    if (row.workspaceId === workspaceId && row.userId === userId) return row;
  }
  return null;
}

export function ownerCount(state: MemoryDirectoryState, workspaceId: string): number {
  let total = 0;
  for (const row of state.memberships.values()) {
    if (row.workspaceId === workspaceId && row.role === 'owner') total += 1;
  }
  return total;
}

export function pendingInvitationClash(
  state: MemoryDirectoryState,
  workspaceId: string,
  email: string,
): boolean {
  return [...state.invitations.values()].some(
    (row) =>
      row.workspaceId === workspaceId &&
      row.email === email &&
      row.acceptedAt === null &&
      row.revokedAt === null,
  );
}

/** The one place a membership row is built, so its principal id rule is stated once. */
export function insertMembership(
  state: MemoryDirectoryState,
  input: {
    /** A row id the caller drew already, so its clock read can follow the id draw. */
    readonly id?: string | undefined;
    readonly workspaceId: string;
    readonly userId: string;
    readonly role: Role;
    readonly createdAt: string;
    /** Exact persisted principal for a seeded fixture; otherwise derived from the row id. */
    readonly principalId?: string | undefined;
  },
): MembershipRow {
  const membershipId = input.id ?? state.newId();
  const membership: MembershipRow = {
    id: membershipId,
    principalId: input.principalId ?? principalId('membership', membershipId),
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
    createdAt: input.createdAt,
  };
  state.memberships.set(membership.id, membership);
  return membership;
}

export function summariseUser(user: UserRow): UserSummary {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

export function summariseMembership(
  state: MemoryDirectoryState,
  row: MembershipRow,
): MembershipSummary {
  const user = state.users.get(row.userId);
  if (user === undefined) {
    // A membership whose user is gone is a broken foreign key; PostgreSQL makes it impossible
    // and this implementation refuses rather than inventing an email for the response.
    throw new Error(
      `membership ${row.id} names user ${row.userId}, which does not exist. A directory that ` +
        `answered with a placeholder here would be reporting a member nobody can name.`,
    );
  }
  return {
    id: row.id,
    principalId: row.principalId,
    userId: row.userId,
    email: user.email,
    name: user.name,
    role: row.role,
    createdAt: row.createdAt,
  };
}

export function summariseKey(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    keyPrefix: row.keyPrefix,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export function storedKey(row: ApiKeyRow): StoredApiKey {
  return {
    ...summariseKey(row),
    workspaceId: row.workspaceId,
    keyHash: row.keyHash,
    keyId: row.keyId,
  };
}

export function summariseInvitation(row: InvitationRow): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
