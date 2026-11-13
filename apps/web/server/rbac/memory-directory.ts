/**
 * An in-memory {@link DirectoryRoot}.
 *
 * This is the contract adapter for fast route and domain tests. The deployment uses the durable
 * implementation in `packages/core/src/db/repositories/directory.ts`, reached through
 * `postgres-directory.ts`; service-backed suites run the same lifecycle against that repository.
 *
 * It is not a permissive stub. It mirrors the constraints PostgreSQL enforces — lower-case email,
 * workspace-unique keys and memberships, globally unique key hashes, invitation uniqueness and
 * invitation terminal states — so a unit test cannot pass only because its substitute accepts a
 * state the deployed store refuses.
 *
 * ## What is deliberately NOT here
 *
 * A plaintext API key or invitation token. Each create/resend operation mints and stores a hash;
 * the presented value is returned to its caller and then exists nowhere in this module.
 */
import { hashApiKeySecret, hashesEqual, parsePresentedKey, type PresentedKey } from './api-key';
import type {
  AcceptInvitationOutcome,
  ApiKeyIdentity,
  DirectoryRoot,
  StoredApiKey,
  UserMembershipSummary,
  UserSummary,
} from './directory';
import { hashInvitationToken } from '../invitations/token';
import type { Role } from './core/roles';
import {
  insertMembership,
  isoOf,
  membershipOf,
  normaliseEmail,
  principalId,
  storedKey,
  summariseMembership,
  userByEmail,
  type InvitationRow,
  type MemoryDirectoryState,
  type SeedWorkspace,
  type UserRow,
} from './memory-directory/state';
import { memoryWorkspaceDirectory } from './memory-directory/workspace';

export type { SeedWorkspace } from './memory-directory/state';

/** A row that may be seeded before the first request. Nothing here mints or hashes a key. */
export interface SeedUser {
  readonly id?: string;
  /** Exact persisted principal for service-backed fixtures; unit fixtures may use the default. */
  readonly principalId?: string;
  readonly email: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly role: Role;
}

/** Options for {@link createMemoryDirectory}. */
export interface MemoryDirectoryOptions {
  /** Members that exist before the first request. Emails are lower-cased on the way in. */
  readonly users?: readonly SeedUser[];
  /** Workspace slug/name, for {@link DirectoryRoot.membershipsForUser}. See {@link SeedWorkspace}. */
  readonly workspaces?: readonly SeedWorkspace[];
  /** The clock. Injected so a test can prove expiry without waiting for it. */
  readonly now?: () => Date;
  /** Identifiers. Injected so a test can assert on stable ids. */
  readonly newId?: () => string;
}

/** The in-memory root, plus the two handles a test needs and a route never gets. */
export interface MemoryDirectory extends DirectoryRoot {
  /** Every stored key row of every workspace. For the test that scans storage for a plaintext. */
  everyStoredApiKey(): StoredApiKey[];
}

/** The OIDC identity an invitation is accepted by. */
interface AcceptingIdentity {
  readonly email: string;
  readonly issuer: string;
  readonly subject: string;
}

const identityKey = (issuer: string, subject: string): string => `${issuer}\u0000${subject}`;

function workspaceDisplay(
  state: MemoryDirectoryState,
  workspaceId: string,
): { slug: string; name: string } {
  const named = state.workspaceNames.get(workspaceId);
  return named ?? { slug: workspaceId, name: workspaceId };
}

function seededState(options: MemoryDirectoryOptions): MemoryDirectoryState {
  let counter = 0;
  const state: MemoryDirectoryState = {
    users: new Map(),
    memberships: new Map(),
    apiKeys: new Map(),
    invitations: new Map(),
    workspaceNames: new Map(),
    identities: new Map(),
    now: options.now ?? ((): Date => new Date()),
    newId: options.newId ?? ((): string => `id-${String((counter += 1))}`),
  };
  for (const workspace of options.workspaces ?? []) {
    state.workspaceNames.set(workspace.id, workspace);
  }
  for (const seed of options.users ?? []) {
    const email = normaliseEmail(seed.email);
    const createdAt = isoOf(state.now());
    const existing = userByEmail(state, email);
    const user = existing ?? { id: seed.id ?? state.newId(), email, name: seed.name, createdAt };
    state.users.set(user.id, user);
    if (membershipOf(state, seed.workspaceId, user.id) === null) {
      insertMembership(state, {
        workspaceId: seed.workspaceId,
        userId: user.id,
        role: seed.role,
        createdAt,
        principalId: seed.principalId,
      });
    }
  }
  return state;
}

export function createMemoryDirectory(options: MemoryDirectoryOptions = {}): MemoryDirectory {
  const state = seededState(options);
  return {
    forWorkspace: (workspaceId) => memoryWorkspaceDirectory(state, workspaceId),

    authenticateApiKey: (presented, at) => authenticateApiKey(state, presented, at),

    resolveRole: (email: string, workspaceId: string): Promise<Role | null> => {
      const user = userByEmail(state, normaliseEmail(email));
      if (user === null) return Promise.resolve(null);
      const membership = membershipOf(state, workspaceId, user.id);
      // The explicit else: a role exists because a membership row was read, never because nothing
      // objected (ADR-0015).
      if (membership === null) return Promise.resolve(null);
      return Promise.resolve(membership.role);
    },

    findUserByEmail: (email: string): Promise<UserSummary | null> => {
      const user = userByEmail(state, normaliseEmail(email));
      return Promise.resolve(user === null ? null : { ...user });
    },

    findIdentity: (
      issuer: string,
      subject: string,
    ): Promise<{ userId: string; email: string } | null> => {
      const userId = state.identities.get(identityKey(issuer, subject));
      const user = userId === undefined ? undefined : state.users.get(userId);
      return Promise.resolve(user === undefined ? null : { userId: user.id, email: user.email });
    },

    linkIdentity: async (issuer: string, subject: string, userId: string): Promise<void> => {
      // Idempotent, the same way the PostgreSQL implementation's unique index makes it: binding
      // the same pair to the same user twice succeeds silently, because a replayed callback must
      // not fail on the second attempt.
      const key = identityKey(issuer, subject);
      const existing = state.identities.get(key);
      if (existing !== undefined && existing !== userId) {
        throw new Error('OIDC identity is already bound to a different user');
      }
      state.identities.set(key, userId);
      return Promise.resolve();
    },

    membershipsForUser: (userId: string): Promise<UserMembershipSummary[]> =>
      Promise.resolve(
        [...state.memberships.values()]
          .filter((row) => row.userId === userId)
          .map((row) => {
            const display = workspaceDisplay(state, row.workspaceId);
            return {
              principalId: row.principalId,
              workspaceId: row.workspaceId,
              workspaceSlug: display.slug,
              workspaceName: display.name,
              role: row.role,
            };
          })
          .sort((a, b) => a.workspaceName.localeCompare(b.workspaceName)),
      ),

    acceptInvitation: (id, token, identity) => acceptInvitation(state, id, token, identity),

    everyStoredApiKey: (): StoredApiKey[] => [...state.apiKeys.values()].map(storedKey),
  };
}

async function authenticateApiKey(
  state: MemoryDirectoryState,
  presented: string,
  at: Date,
): Promise<ApiKeyIdentity | null> {
  const parsed: PresentedKey | null = parsePresentedKey(presented);
  if (parsed === null) return null;
  const row = [...state.apiKeys.values()].find((candidate) => candidate.keyId === parsed.keyId);
  // Every one of the four rejections below is the same `null`, deliberately: R-12 §1.5 makes a
  // revoked key, an expired key and an unknown key indistinguishable over HTTP.
  if (row === undefined) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && new Date(row.expiresAt).getTime() <= at.getTime()) return null;
  const presentedHash = await hashApiKeySecret(parsed.secret);
  if (!hashesEqual(presentedHash, row.keyHash)) return null;
  row.lastUsedAt = isoOf(at);
  return {
    principalId: principalId('api_key', row.id),
    apiKeyId: row.id,
    workspaceId: row.workspaceId,
    role: row.role,
    label: row.name,
    // The in-memory directory mints only hosted keys, which own what they write.
    actsForPrincipalId: null,
  };
}

async function acceptInvitation(
  state: MemoryDirectoryState,
  id: string,
  token: string,
  identity: AcceptingIdentity,
): Promise<AcceptInvitationOutcome> {
  const email = normaliseEmail(identity.email);
  const row = state.invitations.get(id);
  const tokenHash = await hashInvitationToken(token);
  if (row === undefined) return { kind: 'invalid' };
  const refusal = refuseInvitation(row, tokenHash, email, state);
  if (refusal !== null) return refusal;

  const createdAt = isoOf(state.now());
  const user = userForAcceptance(state, identity, email, createdAt);
  if (user === null) return { kind: 'invalid' };
  state.identities.set(identityKey(identity.issuer, identity.subject), user.id);
  const existingMembership = membershipOf(state, row.workspaceId, user.id);
  if (existingMembership !== null) {
    row.acceptedAt = isoOf(state.now());
    return {
      kind: 'already-member',
      workspaceId: row.workspaceId,
      userId: user.id,
      principalId: existingMembership.principalId,
    };
  }
  const membership = insertMembership(state, {
    workspaceId: row.workspaceId,
    userId: user.id,
    role: row.role,
    createdAt,
  });
  row.acceptedAt = isoOf(state.now());
  return {
    kind: 'accepted',
    workspaceId: row.workspaceId,
    workspaceSlug: workspaceDisplay(state, row.workspaceId).slug,
    user: { ...user },
    membership: summariseMembership(state, membership),
  };
}

/** Why `row` cannot be accepted with this token by this email, or `null` when it can. */
function refuseInvitation(
  row: InvitationRow,
  tokenHash: string,
  email: string,
  state: MemoryDirectoryState,
): AcceptInvitationOutcome | null {
  // One condition covers id, token and email together, the same way the PostgreSQL
  // implementation's single `WHERE` does — see that file's header for why the three collapse.
  // (An unknown id is refused by the caller before this, with the same `invalid`.)
  if (!hashesEqual(tokenHash, row.tokenHash) || row.email !== email) return { kind: 'invalid' };
  if ((state.workspaceNames.get(row.workspaceId)?.archivedAt ?? null) !== null) {
    return { kind: 'invalid' };
  }
  if (row.revokedAt !== null) return { kind: 'revoked' };
  if (row.acceptedAt !== null) return { kind: 'already-accepted' };
  if (new Date(row.expiresAt).getTime() <= state.now().getTime()) return { kind: 'expired' };
  return null;
}

/**
 * The user an accepted invitation joins: the one the OIDC identity is already bound to, else the
 * one with the invited email, else a new one. `null` when the bound user's email differs.
 */
function userForAcceptance(
  state: MemoryDirectoryState,
  identity: AcceptingIdentity,
  email: string,
  createdAt: string,
): UserRow | null {
  const boundUserId = state.identities.get(identityKey(identity.issuer, identity.subject));
  const user =
    boundUserId === undefined ? userByEmail(state, email) : (state.users.get(boundUserId) ?? null);
  if (boundUserId !== undefined && user?.email !== email) return null;
  if (user !== null) return user;
  const created = { id: state.newId(), email, name: email.split('@')[0] || email, createdAt };
  state.users.set(created.id, created);
  return created;
}
