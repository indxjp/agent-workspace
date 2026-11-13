/**
 * The workspace-scoped half of the in-memory directory: one {@link WorkspaceDirectory} over the
 * shared {@link MemoryDirectoryState}. A row of another workspace reads as absent everywhere here.
 */
import { mintApiKey } from '../api-key';
import type {
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
  InvitationSummary,
  MembershipChangeOutcome,
  MembershipSummary,
  ResendInvitationOutcome,
  RevokeApiKeyOutcome,
  RevokeInvitationOutcome,
  StoredApiKey,
  UserSummary,
  WorkspaceDirectory,
} from '../directory';
import type { ConferredRole } from '../core/conferral';
import { INVITATION_TTL_MS, mintInvitationToken } from '../../invitations/token';
import {
  inWorkspace,
  insertMembership,
  isoOf,
  membershipOf,
  normaliseEmail,
  ownerCount,
  pendingInvitationClash,
  storedKey,
  summariseInvitation,
  summariseKey,
  summariseMembership,
  summariseUser,
  userByEmail,
  type ApiKeyRow,
  type InvitationRow,
  type MemoryDirectoryState,
} from './state';

export function memoryWorkspaceDirectory(
  state: MemoryDirectoryState,
  workspaceId: string,
): WorkspaceDirectory {
  return {
    ...userOperations(state, workspaceId),
    ...memberOperations(state, workspaceId),
    ...apiKeyOperations(state, workspaceId),
    ...invitationOperations(state, workspaceId),
  };
}

function userOperations(
  state: MemoryDirectoryState,
  workspaceId: string,
): Pick<WorkspaceDirectory, 'listUsers' | 'createUser'> {
  return {
    listUsers: (): Promise<UserSummary[]> =>
      Promise.resolve(
        [...state.memberships.values()]
          .filter((row) => row.workspaceId === workspaceId)
          .map((row) => {
            const user = state.users.get(row.userId);
            if (user === undefined) {
              throw new Error(`membership ${row.id} names user ${row.userId}, which is absent.`);
            }
            return summariseUser(user);
          })
          .sort((a, b) => a.email.localeCompare(b.email)),
      ),

    createUser: (input: CreateUserInput): Promise<CreateUserOutcome> => {
      const email = normaliseEmail(input.email);
      const existing = userByEmail(state, email);
      if (existing !== null && membershipOf(state, workspaceId, existing.id) !== null) {
        return Promise.resolve({ kind: 'email-taken', email });
      }
      const createdAt = isoOf(state.now());
      // Trimmed as the durable repository trims it, so both answer the same name for one input.
      const user = existing ?? { id: state.newId(), email, name: input.name.trim(), createdAt };
      state.users.set(user.id, user);
      const membership = insertMembership(state, {
        workspaceId,
        userId: user.id,
        role: input.role,
        createdAt,
      });
      return Promise.resolve({
        kind: 'created',
        user: summariseUser(user),
        membership: summariseMembership(state, membership),
      });
    },
  };
}

function memberOperations(
  state: MemoryDirectoryState,
  workspaceId: string,
): Pick<
  WorkspaceDirectory,
  | 'listMemberships'
  | 'findMembershipByPrincipal'
  | 'createMembership'
  | 'changeMembershipRole'
  | 'deleteMembership'
> {
  return {
    listMemberships: (): Promise<MembershipSummary[]> =>
      Promise.resolve(
        [...state.memberships.values()]
          .filter((row) => row.workspaceId === workspaceId)
          .map((row) => summariseMembership(state, row))
          .sort((a, b) => a.email.localeCompare(b.email)),
      ),

    findMembershipByPrincipal: (principalId: string): Promise<MembershipSummary | null> => {
      const row = [...state.memberships.values()].find(
        (candidate) =>
          candidate.workspaceId === workspaceId && candidate.principalId === principalId,
      );
      return Promise.resolve(row === undefined ? null : summariseMembership(state, row));
    },

    createMembership: (input: CreateMembershipInput): Promise<CreateMembershipOutcome> => {
      const email = normaliseEmail(input.email);
      const user = userByEmail(state, email);
      if (user === null) return Promise.resolve({ kind: 'no-such-user', email });
      if (membershipOf(state, workspaceId, user.id) !== null) {
        return Promise.resolve({ kind: 'already-a-member', email });
      }
      const id = state.newId();
      const membership = insertMembership(state, {
        id,
        workspaceId,
        userId: user.id,
        role: input.role,
        createdAt: isoOf(state.now()),
      });
      return Promise.resolve({
        kind: 'created',
        membership: summariseMembership(state, membership),
      });
    },

    changeMembershipRole: (id: string, role: ConferredRole): Promise<MembershipChangeOutcome> => {
      const row = state.memberships.get(id);
      if (!inWorkspace(row, workspaceId)) {
        return Promise.resolve({ kind: 'no-such-membership', id });
      }
      if (row.role === 'owner' && role !== 'owner' && ownerCount(state, workspaceId) === 1) {
        return Promise.resolve({ kind: 'last-owner', id });
      }
      row.role = role;
      return Promise.resolve({ kind: 'changed', membership: summariseMembership(state, row) });
    },

    deleteMembership: (id: string): Promise<DeleteMembershipOutcome> => {
      const row = state.memberships.get(id);
      if (!inWorkspace(row, workspaceId)) {
        return Promise.resolve({ kind: 'no-such-membership', id });
      }
      if (row.role === 'owner' && ownerCount(state, workspaceId) === 1) {
        return Promise.resolve({ kind: 'last-owner', id });
      }
      state.memberships.delete(id);
      return Promise.resolve({ kind: 'deleted', id });
    },
  };
}

function apiKeyOperations(
  state: MemoryDirectoryState,
  workspaceId: string,
): Pick<WorkspaceDirectory, 'listApiKeys' | 'createApiKey' | 'revokeApiKey' | 'readStoredApiKey'> {
  return {
    listApiKeys: (): Promise<ApiKeySummary[]> =>
      Promise.resolve(
        [...state.apiKeys.values()]
          .filter((row) => row.workspaceId === workspaceId)
          .map(summariseKey)
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),

    createApiKey: async (input: CreateApiKeyInput): Promise<CreateApiKeyOutcome> => {
      const name = input.name.trim();
      const clash = [...state.apiKeys.values()].find(
        (row) => row.workspaceId === workspaceId && row.name === name,
      );
      if (clash !== undefined) return { kind: 'name-taken', name };
      const createdAt = state.now();
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
        id: state.newId(),
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
      state.apiKeys.set(row.id, row);
      return { kind: 'created', key: summariseKey(row), presented: minted.presented };
    },

    revokeApiKey: (id: string): Promise<RevokeApiKeyOutcome> => {
      const row = state.apiKeys.get(id);
      if (!inWorkspace(row, workspaceId)) return Promise.resolve({ kind: 'no-such-key', id });
      if (row.revokedAt !== null) {
        return Promise.resolve({ kind: 'already-revoked', key: summariseKey(row) });
      }
      row.revokedAt = isoOf(state.now());
      return Promise.resolve({ kind: 'revoked', key: summariseKey(row), mcpProjectClientId: null });
    },

    readStoredApiKey: (id: string): Promise<StoredApiKey | null> => {
      const row = state.apiKeys.get(id);
      return Promise.resolve(inWorkspace(row, workspaceId) ? storedKey(row) : null);
    },
  };
}

function invitationOperations(
  state: MemoryDirectoryState,
  workspaceId: string,
): Pick<
  WorkspaceDirectory,
  'listInvitations' | 'createInvitation' | 'resendInvitation' | 'revokeInvitation'
> {
  const expiresFromNow = (): string => isoOf(new Date(state.now().getTime() + INVITATION_TTL_MS));
  return {
    listInvitations: (): Promise<InvitationSummary[]> =>
      Promise.resolve(
        [...state.invitations.values()]
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
      if (pendingInvitationClash(state, workspaceId, email)) {
        return { kind: 'already-invited', email };
      }
      const row: InvitationRow = {
        id: state.newId(),
        workspaceId,
        email,
        role: input.role,
        invitedBy: input.invitedBy,
        tokenHash: minted.tokenHash,
        expiresAt: expiresFromNow(),
        acceptedAt: null,
        revokedAt: null,
        createdAt: isoOf(state.now()),
      };
      state.invitations.set(row.id, row);
      return { kind: 'created', invitation: summariseInvitation(row), token: minted.token };
    },

    resendInvitation: async (id: string): Promise<ResendInvitationOutcome> => {
      // As with create, finish the only awaited work before reading lifecycle state, so acceptance
      // cannot commit between a "pending" check and this token rotation.
      const minted = await mintInvitationToken();
      const row = state.invitations.get(id);
      if (!inWorkspace(row, workspaceId)) return { kind: 'no-such-invitation', id };
      if (row.acceptedAt !== null) {
        return { kind: 'already-accepted', invitation: summariseInvitation(row) };
      }
      if (row.revokedAt !== null) return { kind: 'revoked', invitation: summariseInvitation(row) };
      row.tokenHash = minted.tokenHash;
      row.expiresAt = expiresFromNow();
      return { kind: 'resent', invitation: summariseInvitation(row), token: minted.token };
    },

    revokeInvitation: (id: string): Promise<RevokeInvitationOutcome> => {
      const row = state.invitations.get(id);
      if (!inWorkspace(row, workspaceId)) {
        return Promise.resolve({ kind: 'no-such-invitation', id });
      }
      if (row.acceptedAt !== null) {
        return Promise.resolve({ kind: 'already-accepted', invitation: summariseInvitation(row) });
      }
      if (row.revokedAt !== null) {
        return Promise.resolve({ kind: 'already-revoked', invitation: summariseInvitation(row) });
      }
      row.revokedAt = isoOf(state.now());
      return Promise.resolve({ kind: 'revoked', invitation: summariseInvitation(row) });
    },
  };
}
