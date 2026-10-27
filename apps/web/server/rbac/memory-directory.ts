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
import {
  hashApiKeySecret,
  hashesEqual,
  mintApiKey,
  parsePresentedKey,
  type PresentedKey,
} from './api-key';
import type {
  AcceptInvitationOutcome,
  ApiKeyIdentity,
  ApiKeySummary,
  CreateApiKeyInput,
  CreateApiKeyOutcome,
  CreateInvitationInput,
  CreateInvitationOutcome,
  CreateMembershipInput,
  CreateMembershipOutcome,
  CreateUserInput,
  CreateUserOutcome,
  DeleteMembershipOutcome,
  DirectoryRoot,
  InvitationSummary,
  MembershipChangeOutcome,
  MembershipSummary,
  ResendInvitationOutcome,
  RevokeApiKeyOutcome,
  RevokeInvitationOutcome,
  StoredApiKey,
  UserMembershipSummary,
  UserSummary,
  WorkspaceDirectory,
} from './directory';
import type { ConferredRole } from './conferral';
import { hashInvitationToken, INVITATION_TTL_MS, mintInvitationToken } from '../invitations/token';
import type { Role } from './roles';

interface UserRow {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

interface MembershipRow {
  id: string;
  principalId: string;
  workspaceId: string;
  userId: string;
  role: Role;
  createdAt: string;
}

interface ApiKeyRow {
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

interface InvitationRow {
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

/**
 * A workspace's display name, for the sole purpose of {@link DirectoryRoot.membershipsForUser}.
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

function isoOf(date: Date): string {
  return date.toISOString();
}

/**
 * `users.email` is stored lower-case and PostgreSQL enforces it (`users_email_lowercase`). Doing
 * it here too keeps the two implementations answering the same question about the same input.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Keep source and principal identities distinct, stable, and UUID-shaped, as PostgreSQL does. */
function principalId(kind: 'membership' | 'api_key', sourceId: string): string {
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

export function createMemoryDirectory(options: MemoryDirectoryOptions = {}): MemoryDirectory {
  const now = options.now ?? ((): Date => new Date());
  let counter = 0;
  const newId = options.newId ?? ((): string => `id-${String((counter += 1))}`);

  const users = new Map<string, UserRow>();
  const memberships = new Map<string, MembershipRow>();
  const apiKeys = new Map<string, ApiKeyRow>();
  const invitations = new Map<string, InvitationRow>();
  const workspaceNames = new Map<string, SeedWorkspace>();
  // Keyed by `${issuer}\u0000${subject}`, which cannot collide the way string concatenation with
  // no separator can (an issuer ending where a subject begins is otherwise ambiguous).
  const identities = new Map<string, string>();

  for (const workspace of options.workspaces ?? []) {
    workspaceNames.set(workspace.id, workspace);
  }
  const workspaceDisplay = (workspaceId: string): { slug: string; name: string } => {
    const named = workspaceNames.get(workspaceId);
    return named ?? { slug: workspaceId, name: workspaceId };
  };
  const identityKey = (issuer: string, subject: string): string => `${issuer}\u0000${subject}`;

  const userByEmail = (email: string): UserRow | null => {
    for (const row of users.values()) if (row.email === email) return row;
    return null;
  };

  const membershipOf = (workspaceId: string, userId: string): MembershipRow | null => {
    for (const row of memberships.values()) {
      if (row.workspaceId === workspaceId && row.userId === userId) return row;
    }
    return null;
  };

  const ownerCount = (workspaceId: string): number => {
    let total = 0;
    for (const row of memberships.values()) {
      if (row.workspaceId === workspaceId && row.role === 'owner') total += 1;
    }
    return total;
  };

  const summariseMembership = (row: MembershipRow): MembershipSummary => {
    const user = users.get(row.userId);
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
  };

  const summariseKey = (row: ApiKeyRow): ApiKeySummary => ({
    id: row.id,
    name: row.name,
    role: row.role,
    keyPrefix: row.keyPrefix,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  });

  const storedKey = (row: ApiKeyRow): StoredApiKey => ({
    ...summariseKey(row),
    workspaceId: row.workspaceId,
    keyHash: row.keyHash,
    keyId: row.keyId,
  });

  const summariseInvitation = (row: InvitationRow): InvitationSummary => ({
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  });

  const pendingInvitationClash = (workspaceId: string, email: string): boolean =>
    [...invitations.values()].some(
      (row) =>
        row.workspaceId === workspaceId &&
        row.email === email &&
        row.acceptedAt === null &&
        row.revokedAt === null,
    );

  for (const seed of options.users ?? []) {
    const email = normaliseEmail(seed.email);
    const createdAt = isoOf(now());
    const existing = userByEmail(email);
    const user = existing ?? { id: seed.id ?? newId(), email, name: seed.name, createdAt };
    users.set(user.id, user);
    if (membershipOf(seed.workspaceId, user.id) === null) {
      const membershipId = newId();
      const membership: MembershipRow = {
        id: membershipId,
        principalId: seed.principalId ?? principalId('membership', membershipId),
        workspaceId: seed.workspaceId,
        userId: user.id,
        role: seed.role,
        createdAt,
      };
      memberships.set(membership.id, membership);
    }
  }

  const forWorkspace = (workspaceId: string): WorkspaceDirectory => ({
    listUsers: (): Promise<UserSummary[]> =>
      Promise.resolve(
        [...memberships.values()]
          .filter((row) => row.workspaceId === workspaceId)
          .map((row) => {
            const user = users.get(row.userId);
            if (user === undefined) {
              throw new Error(`membership ${row.id} names user ${row.userId}, which is absent.`);
            }
            return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
          })
          .sort((a, b) => a.email.localeCompare(b.email)),
      ),

    createUser: (input: CreateUserInput): Promise<CreateUserOutcome> => {
      const email = normaliseEmail(input.email);
      const existing = userByEmail(email);
      if (existing !== null && membershipOf(workspaceId, existing.id) !== null) {
        return Promise.resolve({ kind: 'email-taken', email });
      }
      const createdAt = isoOf(now());
      // Trimmed as the durable repository trims it, so both answer the same name for one input.
      const user = existing ?? { id: newId(), email, name: input.name.trim(), createdAt };
      users.set(user.id, user);
      const membershipId = newId();
      const membership: MembershipRow = {
        id: membershipId,
        principalId: principalId('membership', membershipId),
        workspaceId,
        userId: user.id,
        role: input.role,
        createdAt,
      };
      memberships.set(membership.id, membership);
      return Promise.resolve({
        kind: 'created',
        user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
        membership: summariseMembership(membership),
      });
    },

    listMemberships: (): Promise<MembershipSummary[]> =>
      Promise.resolve(
        [...memberships.values()]
          .filter((row) => row.workspaceId === workspaceId)
          .map(summariseMembership)
          .sort((a, b) => a.email.localeCompare(b.email)),
      ),

    createMembership: (input: CreateMembershipInput): Promise<CreateMembershipOutcome> => {
      const email = normaliseEmail(input.email);
      const user = userByEmail(email);
      if (user === null) return Promise.resolve({ kind: 'no-such-user', email });
      if (membershipOf(workspaceId, user.id) !== null) {
        return Promise.resolve({ kind: 'already-a-member', email });
      }
      const membershipId = newId();
      const membership: MembershipRow = {
        id: membershipId,
        principalId: principalId('membership', membershipId),
        workspaceId,
        userId: user.id,
        role: input.role,
        createdAt: isoOf(now()),
      };
      memberships.set(membership.id, membership);
      return Promise.resolve({ kind: 'created', membership: summariseMembership(membership) });
    },

    changeMembershipRole: (id: string, role: ConferredRole): Promise<MembershipChangeOutcome> => {
      const row = memberships.get(id);
      if (row === undefined || row.workspaceId !== workspaceId) {
        return Promise.resolve({ kind: 'no-such-membership', id });
      }
      if (row.role === 'owner' && role !== 'owner' && ownerCount(workspaceId) === 1) {
        return Promise.resolve({ kind: 'last-owner', id });
      }
      row.role = role;
      return Promise.resolve({ kind: 'changed', membership: summariseMembership(row) });
    },

    deleteMembership: (id: string): Promise<DeleteMembershipOutcome> => {
      const row = memberships.get(id);
      if (row === undefined || row.workspaceId !== workspaceId) {
        return Promise.resolve({ kind: 'no-such-membership', id });
      }
      if (row.role === 'owner' && ownerCount(workspaceId) === 1) {
        return Promise.resolve({ kind: 'last-owner', id });
      }
      memberships.delete(id);
      return Promise.resolve({ kind: 'deleted', id });
    },

    listApiKeys: (): Promise<ApiKeySummary[]> =>
      Promise.resolve(
        [...apiKeys.values()]
          .filter((row) => row.workspaceId === workspaceId)
          .map(summariseKey)
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),

    createApiKey: async (input: CreateApiKeyInput): Promise<CreateApiKeyOutcome> => {
      const name = input.name.trim();
      const clash = [...apiKeys.values()].find(
        (row) => row.workspaceId === workspaceId && row.name === name,
      );
      if (clash !== undefined) return { kind: 'name-taken', name };
      const createdAt = now();
      if (input.expiresAt !== null) {
        const expires = new Date(input.expiresAt);
        // Positive: the expiry has to *parse* and has to be later than now. `Number.isNaN` on the
        // epoch is the check, because `new Date('nonsense') > now` is `false` — a comparison that
        // silently answers "already expired" for an input nobody validated.
        if (Number.isNaN(expires.getTime()) || expires.getTime() <= createdAt.getTime()) {
          return { kind: 'expiry-in-the-past', expiresAt: input.expiresAt };
        }
      }
      const minted = await mintApiKey();
      const row: ApiKeyRow = {
        id: newId(),
        workspaceId,
        name,
        role: input.role,
        keyId: minted.keyId,
        keyPrefix: minted.keyPrefix,
        keyHash: minted.keyHash,
        lastUsedAt: null,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: isoOf(createdAt),
      };
      apiKeys.set(row.id, row);
      return { kind: 'created', key: summariseKey(row), presented: minted.presented };
    },

    revokeApiKey: (id: string): Promise<RevokeApiKeyOutcome> => {
      const row = apiKeys.get(id);
      if (row === undefined || row.workspaceId !== workspaceId) {
        return Promise.resolve({ kind: 'no-such-key', id });
      }
      if (row.revokedAt !== null) {
        return Promise.resolve({ kind: 'already-revoked', key: summariseKey(row) });
      }
      row.revokedAt = isoOf(now());
      return Promise.resolve({
        kind: 'revoked',
        key: summariseKey(row),
        mcpProjectClientId: null,
      });
    },

    readStoredApiKey: (id: string): Promise<StoredApiKey | null> => {
      const row = apiKeys.get(id);
      if (row === undefined || row.workspaceId !== workspaceId) return Promise.resolve(null);
      return Promise.resolve(storedKey(row));
    },

    listInvitations: (): Promise<InvitationSummary[]> =>
      Promise.resolve(
        [...invitations.values()]
          .filter((row) => row.workspaceId === workspaceId)
          .map(summariseInvitation)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ),

    createInvitation: async (input: CreateInvitationInput): Promise<CreateInvitationOutcome> => {
      const email = normaliseEmail(input.email);
      // Mint before the in-memory uniqueness check. The hash awaits Web Crypto; if it followed the
      // check, two concurrent calls could both observe no row, yield while hashing, then both
      // insert. Once minting has completed, the check and Map write run without another await.
      const minted = await mintInvitationToken();
      if (pendingInvitationClash(workspaceId, email)) {
        return { kind: 'already-invited', email };
      }
      const row: InvitationRow = {
        id: newId(),
        workspaceId,
        email,
        role: input.role,
        invitedBy: input.invitedBy,
        tokenHash: minted.tokenHash,
        expiresAt: isoOf(new Date(now().getTime() + INVITATION_TTL_MS)),
        acceptedAt: null,
        revokedAt: null,
        createdAt: isoOf(now()),
      };
      invitations.set(row.id, row);
      return { kind: 'created', invitation: summariseInvitation(row), token: minted.token };
    },

    resendInvitation: async (id: string): Promise<ResendInvitationOutcome> => {
      // As with create, finish the only awaited work before reading lifecycle state, so acceptance
      // cannot commit between a "pending" check and this token rotation.
      const minted = await mintInvitationToken();
      const row = invitations.get(id);
      if (row === undefined || row.workspaceId !== workspaceId) {
        return { kind: 'no-such-invitation', id };
      }
      if (row.acceptedAt !== null) {
        return { kind: 'already-accepted', invitation: summariseInvitation(row) };
      }
      if (row.revokedAt !== null) {
        return { kind: 'revoked', invitation: summariseInvitation(row) };
      }
      row.tokenHash = minted.tokenHash;
      row.expiresAt = isoOf(new Date(now().getTime() + INVITATION_TTL_MS));
      return { kind: 'resent', invitation: summariseInvitation(row), token: minted.token };
    },

    revokeInvitation: (id: string): Promise<RevokeInvitationOutcome> => {
      const row = invitations.get(id);
      if (row === undefined || row.workspaceId !== workspaceId) {
        return Promise.resolve({ kind: 'no-such-invitation', id });
      }
      if (row.acceptedAt !== null) {
        return Promise.resolve({ kind: 'already-accepted', invitation: summariseInvitation(row) });
      }
      if (row.revokedAt !== null) {
        return Promise.resolve({ kind: 'already-revoked', invitation: summariseInvitation(row) });
      }
      row.revokedAt = isoOf(now());
      return Promise.resolve({ kind: 'revoked', invitation: summariseInvitation(row) });
    },
  });

  return {
    forWorkspace,

    authenticateApiKey: async (presented: string, at: Date): Promise<ApiKeyIdentity | null> => {
      const parsed: PresentedKey | null = parsePresentedKey(presented);
      if (parsed === null) return null;
      const row = [...apiKeys.values()].find((candidate) => candidate.keyId === parsed.keyId);
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
    },

    resolveRole: (email: string, workspaceId: string): Promise<Role | null> => {
      const user = userByEmail(normaliseEmail(email));
      if (user === null) return Promise.resolve(null);
      const membership = membershipOf(workspaceId, user.id);
      // The explicit else: a role exists because a membership row was read, never because nothing
      // objected (ADR-0015).
      if (membership === null) return Promise.resolve(null);
      return Promise.resolve(membership.role);
    },

    findUserByEmail: (email: string): Promise<UserSummary | null> => {
      const user = userByEmail(normaliseEmail(email));
      return Promise.resolve(user === null ? null : { ...user });
    },

    findIdentity: (
      issuer: string,
      subject: string,
    ): Promise<{ userId: string; email: string } | null> => {
      const userId = identities.get(identityKey(issuer, subject));
      const user = userId === undefined ? undefined : users.get(userId);
      return Promise.resolve(user === undefined ? null : { userId: user.id, email: user.email });
    },

    linkIdentity: async (issuer: string, subject: string, userId: string): Promise<void> => {
      // Idempotent, the same way the PostgreSQL implementation's unique index makes it: binding
      // the same pair to the same user twice succeeds silently, because a replayed callback must
      // not fail on the second attempt.
      const key = identityKey(issuer, subject);
      const existing = identities.get(key);
      if (existing !== undefined && existing !== userId) {
        throw new Error('OIDC identity is already bound to a different user');
      }
      identities.set(key, userId);
      return Promise.resolve();
    },

    membershipsForUser: (userId: string): Promise<UserMembershipSummary[]> =>
      Promise.resolve(
        [...memberships.values()]
          .filter((row) => row.userId === userId)
          .map((row) => {
            const display = workspaceDisplay(row.workspaceId);
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

    acceptInvitation: async (
      id: string,
      token: string,
      identity: { readonly email: string; readonly issuer: string; readonly subject: string },
    ): Promise<AcceptInvitationOutcome> => {
      const email = normaliseEmail(identity.email);
      const row = invitations.get(id);
      // One condition covers id, token and email together, the same way the PostgreSQL
      // implementation's single `WHERE` does — see that file's header for why the three collapse.
      const tokenHash = await hashInvitationToken(token);
      if (row === undefined || !hashesEqual(tokenHash, row.tokenHash) || row.email !== email) {
        return { kind: 'invalid' };
      }
      if ((workspaceNames.get(row.workspaceId)?.archivedAt ?? null) !== null) {
        return { kind: 'invalid' };
      }
      if (row.revokedAt !== null) return { kind: 'revoked' };
      if (row.acceptedAt !== null) return { kind: 'already-accepted' };
      if (new Date(row.expiresAt).getTime() <= now().getTime()) return { kind: 'expired' };

      const createdAt = isoOf(now());
      const key = identityKey(identity.issuer, identity.subject);
      const boundUserId = identities.get(key);
      let user = boundUserId === undefined ? userByEmail(email) : (users.get(boundUserId) ?? null);
      if (boundUserId !== undefined && user?.email !== email) return { kind: 'invalid' };
      if (user === null) {
        user = { id: newId(), email, name: email.split('@')[0] || email, createdAt };
        users.set(user.id, user);
      }
      identities.set(key, user.id);
      const existingMembership = membershipOf(row.workspaceId, user.id);
      if (existingMembership !== null) {
        row.acceptedAt = isoOf(now());
        return {
          kind: 'already-member',
          workspaceId: row.workspaceId,
          userId: user.id,
          principalId: existingMembership.principalId,
        };
      }
      const membershipId = newId();
      const membership: MembershipRow = {
        id: membershipId,
        principalId: principalId('membership', membershipId),
        workspaceId: row.workspaceId,
        userId: user.id,
        role: row.role,
        createdAt,
      };
      memberships.set(membership.id, membership);
      row.acceptedAt = isoOf(now());
      return {
        kind: 'accepted',
        workspaceId: row.workspaceId,
        workspaceSlug: workspaceDisplay(row.workspaceId).slug,
        user: { ...user },
        membership: summariseMembership(membership),
      };
    },

    everyStoredApiKey: (): StoredApiKey[] => [...apiKeys.values()].map(storedKey),
  };
}
